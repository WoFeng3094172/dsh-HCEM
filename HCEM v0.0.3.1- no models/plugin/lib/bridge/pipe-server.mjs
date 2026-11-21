/**
 * HCEM 命名管道桥（Node 侧 Client）
 *
 * 为什么 Node 是 Client 而不是 Server：
 *   Rust(Tauri) 侧用 `std::fs` / `CreateFileW` 打开 Node 创建的管道实例时，
 *   系统返回 ERROR_ACCESS_DENIED（0x80070005），
 *   而反过来由 Rust `CreateNamedPipeW` 建管道、Node 用 net.connect 连，
 *   双方都能正常建立连接（已验证）。
 *   所以：**Rust = 管道 Server，Node = Client**。
 *
 * 帧格式（长度前缀）：
 *   +--------+--------+------------------+
 *   | 4 byte | 1 byte |  N byte          |
 *   | length | type   | JSON payload     |
 *   +--------+--------+------------------+
 *   length = payload 字节数（LE uint32），不含 5 字节头
 */

import net from 'node:net'
import '../home.mjs'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { log, logMods, LOG_DIR } from '../log.mjs'
import { applyModsToModules, captureStatus } from './module-runtime.mjs'

/** 往插件的本地语音端点发一个 JSON POST（通话控制走这里） */
async function postVoice(body, path = '/call') {
  const port = Number(process.env.HCEM_VOICE_PORT || 8097)
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/**
 * 通话状态转发：插件把状态写进 data/voice-call.json，这里轮询变化后推给 UI。
 *
 * 为什么不直接推：插件跑在 DSH 进程里，pipe-server 跑在 HCEM.exe 的 Node 里，
 * 是两个进程。文件是它们之间最省事的单向通道。
 */
const CALL_STATE_FILE = `${globalThis.__HCEM_HOME__}/data/voice-call.json`
// 实时情绪：插件写，这里轮询后推给 exe（悬浮球颜色 + 菜单 HSL 读数）。
// 之前 state.hsl 只在 UI 自己 set_hsl 时更新（那是性格基准的回显），
// 所以菜单里的 HSL 读数其实一直停在启动基准，不会跟着情绪走。
const HSL_LIVE_FILE = `${globalThis.__HCEM_HOME__}/data/hsl-live.json`
// 显存准入踢掉模型后，services 会写这个文件；这里轮询后推给菜单，让按钮跟着关
const EVICT_FILE = `${globalThis.__HCEM_HOME__}/data/ui-state/evicted.json`
let lastEvictStamp = ''
let callWatchTimer = null
let lastCallStamp = ''
let lastHslStamp = ''

function startCallWatch(sendFn) {
  if (callWatchTimer) return
  callWatchTimer = setInterval(() => {
    try {
      const raw = fs.readFileSync(CALL_STATE_FILE, 'utf8')
      if (raw !== lastCallStamp) {
        lastCallStamp = raw
        const v = JSON.parse(raw)
        // 超过 30 秒的旧状态不再推送，避免来电"幽灵通话"
        if (Date.now() - Number(v?.ts || 0) <= 30000) sendFn(TYPE.STATE, { voiceCall: v })
      }
    } catch (_e) {
      // 文件不存在 / 正在被写：忽略，下一轮再看
    }
    // 实时情绪推给 exe
    try {
      const raw = fs.readFileSync(HSL_LIVE_FILE, 'utf8')
      if (raw !== lastHslStamp) {
        lastHslStamp = raw
        const v = JSON.parse(raw)
        if (Date.now() - Number(v?.ts || 0) <= 30000) {
          // 注意：这里不能写 `state.hsl = ...` —— startCallWatch 在模块作用域，
          // 拿不到 connectBridge 里的局部 state，那行会抛 ReferenceError 并被 catch 吞掉，
          // 结果 STATE 帧一次都发不出去（实测菜单 HSL 读数永远不动）。
          sendFn(TYPE.STATE, { h: Number(v.h) || 0, s: Number(v.s) || 0, l: Number(v.l) || 0 })
        }
      }
    } catch (_e) {
      // 同上
    }
    // 显存让位 → 通知菜单把对应开关关掉
    try {
      const raw = fs.readFileSync(EVICT_FILE, 'utf8')
      if (raw !== lastEvictStamp) {
        lastEvictStamp = raw
        const v = JSON.parse(raw)
        if (v?.mods) send(TYPE.STATE, { mods: v.mods, evicted: v.evicted || [] })
      }
    } catch (_e) {}
  }, 700)
  if (callWatchTimer.unref) callWatchTimer.unref()
}

export const PIPE_NAME = '\\\\.\\pipe\\hcem-bridge'

// ── 单实例保护 ──
// 多个 pipe-server 抢同一个命名管道会互相把对方踢下线（日志刷 "rust pipe disconnected"）。
// 启动时写一个 lock 文件，里面是 pid；发现已有活着的实例就直接退出。
const LOCK_PATH = `${globalThis.__HCEM_HOME__}/data/.pipe-server.lock`

/**
 * 那把锁里的 pid 是不是**真的**另一个 pipe-server。
 *
 * 不能只判断「进程还活着」：Windows 会复用 PID。
 * 实测踩过：杀掉旧 pipe-server 后，PID 1360 被别的进程占用，
 * 于是每个新实例都以为「已有实例在跑」直接退出 ——
 * exe 侧没有任何 node 客户端，菜单里所有开关和启动按钮就全失灵了。
 */
function isLivePipeServer(pid) {
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0) // 进程在不在
  } catch {
    return false
  }
  // 再确认它确实是 node 且命令行是 pipe-server
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 6000, windowsHide: true },
    )
    return /pipe-server\.mjs/i.test(String(out))
  } catch {
    // 查不到就当它已经死了，宁可让新实例起来
    return false
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const old = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim())
      if (isLivePipeServer(old)) {
        console.error('[bridge] 已有 pipe-server 在跑 (pid ' + old + ')，本实例退出')
        return false
      }
      console.log('[bridge] 清掉过期锁 (pid ' + old + ')')
    }
    fs.mkdirSync(`${globalThis.__HCEM_HOME__}/data`, { recursive: true })
    fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf8')
    return true
  } catch (e) {
    console.error('[bridge] lock 失败: ' + ((e && e.message) || e))
    return true // 锁失败不阻塞启动
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const cur = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim())
      if (cur === process.pid) fs.unlinkSync(LOCK_PATH)
    }
  } catch {}
}

if (!acquireLock()) {
  process.exit(0)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => {
  releaseLock()
  process.exit(0)
})

/** 帧类型 */
export const TYPE = {
  STATE: 0,
  CMD: 1,
  ACK: 2,
  LOG: 3,
  PING: 4,
  PONG: 5,
  HELLO: 6,
}

const MAX_FRAME = 8 * 1024 * 1024

/** 组包：4B 长度 + 1B 类型 + payload */
export function encodeFrame(type, payload) {
  const body = Buffer.from(payload === undefined ? '' : JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(5 + body.length)
  frame.writeUInt32LE(body.length, 0)
  frame.writeUInt8(type, 4)
  body.copy(frame, 5)
  return frame
}

/**
 * 拆包器：管道是字节流，一次 data 可能是半帧/多帧，
 * 所以累积缓冲：不足 5 字节等头，头够但不足 5+len 继续等，凑够才切。
 */
export function createParser(onFrame) {
  let buf = Buffer.alloc(0)
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(0)
      if (len > MAX_FRAME) {
        buf = Buffer.alloc(0)
        return
      }
      if (buf.length < 5 + len) return
      const type = buf.readUInt8(4)
      const body = buf.subarray(5, 5 + len).toString('utf8')
      let payload = null
      if (body.length) {
        try { payload = JSON.parse(body) } catch { payload = { raw: body } }
      }
      buf = buf.subarray(5 + len)
      try { onFrame(type, payload) } catch (e) { console.error('[bridge] onFrame:', e) }
    }
  }
}

/**
 * 连接 Rust 侧的管道 Server（自动重连）
 * @returns {{ send:(t:number,p:any)=>void, isConnected:()=>boolean, close:()=>void }}
 */
export function connectBridge(opts = {}) {
  let socket = null
let pipeWasDown = false
  let connected = false
  // 管道断开多久：超过阈值就自杀。
  // HCEM.exe 被关闭/被杀时不会连坐子进程，实测留下过一个跑了 4 小时的孤儿，
  // 新 exe 因为锁文件抢不到管道，结果一直在用旧进程的旧代码。
  let downSince = 0
  // 插件侧维护的 UI 状态（HSL / 球大小），后续接 memory/emotion 时再扩展
  const state = { hsl: { h: 90, s: 25, l: 55 }, scale: 1 }

  const send = (type, payload) => {
    if (!socket || !connected) return false
    try {
      socket.write(encodeFrame(type, payload))
      return true
    } catch {
      return false
    }
  }

  const connect = () => {
    const sock = net.connect(PIPE_NAME)
    socket = sock

    sock.on('connect', () => {
      connected = true
      console.log('[bridge] 已连接 Rust 管道')
      pipeWasDown = false
      log('INFO', 'bridge', 'node connected to rust pipe')
      // 握手
      send(TYPE.HELLO, { role: 'node', ver: 1 })
      // 连上后立刻推一次当前状态，让 exe 一启动就显示真实颜色
      setTimeout(() => send(TYPE.STATE, state.hsl), 60)
      startCallWatch(send)
      // ① 常驻模型随 .exe 启动而启动：连上就按开关同步一次（force，绕过去重）
      try {
        opts.onConnect?.()
      } catch (e) {
        log('WARN', 'bridge', 'onConnect failed: ' + String((e && e.message) || e))
      }
    })

    const feed = createParser((type, payload) => {
      switch (type) {
        case TYPE.PING:
          // 心跳回应：原样带回 t，Rust 侧可算 RTT
          send(TYPE.PONG, { t: payload?.t ?? 0, node: Date.now() })
          break
        case TYPE.HELLO:
          console.log('[bridge] Rust 握手:', payload)
          // 握手完成
          break
        case TYPE.CMD: {
          const cmd = payload?.cmd
          const data = payload?.data
          if (cmd === 'wake_services') {
            // 统一走「按开关同步（force）」，不再自己维护一套唤醒逻辑：
            // 旧实现门禁看「本地分流」，还会去启动早已退役的 smolvlm，和 syncServicesWithMods 打架。
            syncModelsNow(true)
          } else if (cmd === 'voice_start') {
            try {
              import('../audio/voice-input.mjs').then(({ startVoiceInput }) => startVoiceInput()).catch((e) => log('ERROR', 'voice', 'start failed: ' + (e && e.message)))
            } catch (e) { log('ERROR', 'voice', 'start failed: ' + (e && e.message)) }
          } else if (cmd === 'voice_cancel') {
            try {
              import('../audio/voice-input.mjs')
                .then(({ cancelVoiceInput }) => {
                  const r = cancelVoiceInput && cancelVoiceInput()
                  log('INFO', 'voice', '取消录音 ' + JSON.stringify(r || {}))
                })
                .catch((e) => log('ERROR', 'voice', 'cancel failed: ' + (e && e.message)))
            } catch (e) {
              log('ERROR', 'voice', 'cancel failed: ' + (e && e.message))
            }
          } else if (cmd === 'voice_end') {
            try {
              import('../audio/voice-input.mjs').then(({ stopVoiceInput }) => stopVoiceInput()).then((r) => { if (r && r.text) send(TYPE.STATE, { voiceInput: r.text }) }).catch((e) => log('ERROR', 'voice', 'end failed: ' + (e && e.message)))
            } catch (e) { log('ERROR', 'voice', 'end failed: ' + (e && e.message)) }
          } else if (cmd === 'call_start' || cmd === 'call_stop' || cmd === 'call_status') {
            // 通话控制：插件进程（DSH 侧）持有通话循环，这里通过它自己的 HTTP 端点转达。
            // 走 HTTP 而不是共享内存，是因为 pipe-server 和插件在两个不同的 Node 进程里。
            const action = cmd.slice(5) // start / stop / status
            void postVoice({ action }, '/call')
              .then((r) => {
                log('INFO', 'call', action + ' -> ' + JSON.stringify(r).slice(0, 160))
                if (r && r.ok) send(TYPE.STATE, { voiceCall: { phase: action === 'start' ? 'listening' : action === 'stop' ? 'idle' : (r.active ? 'listening' : 'idle'), ...r } })
              })
              .catch((e) => log('ERROR', 'call', action + ' failed: ' + (e && e.message)))
          }
          if (cmd === 'set_hsl' && data) {
            state.hsl = { h: data.h, s: data.s, l: data.l }
            // base=true 表示这是性格/搭话度决定的 HSL 基准，额外落盘一份
            if (data.base) {
              try {
                fs.mkdirSync(UI_DIR, { recursive: true })
                fs.writeFileSync(UI_DIR + '\\hsl-base.json', JSON.stringify({ h: data.h, s: data.s, l: data.l, savedAt: Date.now() }, null, 2), 'utf8')
              } catch (e) { console.error('[hsl-base]', e.message) }
            }
            // 不再回推 STATE：Rust 收到 set_hsl 后会自己 eval 到窗口，
            // 回推会造成「set_hsl → STATE → applyHSL → set_hsl」死循环
            logDebugBridge('set_hsl -> ' + JSON.stringify(state.hsl))
          } else if (cmd === 'set_orb_scale' && data) {
            state.scale = data.scale
          } else if (cmd === 'set_mods' && data) {
            state.mods = data
            applyMods(data)
            // 启停模型统一交给插件处理（转发到 8097 /mods）。
            // 不在本进程里再算一遍：pipe-server 常驻不重载，会和插件里的新逻辑打架。
            syncModelsNow(false)
          } else if (cmd) {
            handleUiCmd(cmd, data)
          }
          if (opts.onFrame) opts.onFrame(type, payload)
          break
        }
        default:
          if (opts.onFrame) opts.onFrame(type, payload)
      }
    })
    sock.on('data', feed)

    sock.on('error', () => {})
    sock.on('close', () => {
      const wasConnected = connected
      connected = false
      // 降噪：只在「从连上变成断开」时打一次，之后静默重试
      if (!pipeWasDown) {
        pipeWasDown = true
        downSince = Date.now()
        log('INFO', 'bridge', 'rust pipe not ready, waiting for HCEM.exe')
      }
      // ③ .exe 关闭 → 所有模型关闭（只在真的断过一次时触发，避免启动抖动就杀模型）
      if (wasConnected) {
        try {
          opts.onDisconnect?.()
        } catch (e) {
          log('WARN', 'bridge', 'onDisconnect failed: ' + String((e && e.message) || e))
        }
      }
      socket = null
      setTimeout(connect, 800) // 断线重连
    })
  }

  connect()

  // 孤儿自杀：管道连续断开 20 秒说明 HCEM.exe 已经不在了，本进程没有存在意义。
  // 退出前把自己登记的锁清掉，免得新 exe 起不来自己的 pipe-server。
  const orphanTimer = setInterval(() => {
    if (connected || !downSince) return
    if (Date.now() - downSince < 20000) return
    log('INFO', 'bridge', 'HCEM.exe 已退出（管道断开 20 秒），pipe-server 自杀')
    try {
      const lock = `${globalThis.__HCEM_HOME__}/data/.pipe-server.lock`
      if (fs.existsSync(lock)) {
        const txt = fs.readFileSync(lock, 'utf8').trim()
        if (txt === String(process.pid)) fs.unlinkSync(lock)
      }
    } catch {}
    process.exit(0)
  }, 5000)
  if (orphanTimer.unref) orphanTimer.unref()

  return {
    send,
    isConnected: () => connected,
    close: () => {
      try { socket?.destroy() } catch {}
    },
  }
}

/* 直接运行：起一个 client 做 Ping/Pong 观察 */
if (process.argv[1] && process.argv[1].endsWith('pipe-server.mjs')) {
  const bridge = connectBridge({
    onFrame: (type, payload) => console.log('[bridge] 帧 type=' + type, payload),
    // ① .exe 连上 → 按开关把模型拉起来（含常驻的 embedding）
    onConnect: () => syncModelsNow(true),
    // ③ .exe 关掉 → 所有模型关掉
    onDisconnect: () => stopModelsNow('HCEM.exe 已关闭'),
  })
  // ③ 保险：本进程退出（HCEM.exe 被关/被杀）时也把模型收掉
  const shutdown = () => {
    try {
      stopModelsNow('pipe-server 退出')
    } catch {}
    process.exit(0)
  }
  process.on('exit', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  setInterval(() => {
    console.log('[bridge] 状态:', bridge.isConnected() ? '已连接' : '等待 Rust')
  }, 5000)
}

/**
 * 按当前开关把模型同步一次 —— 转发给插件（DSH 那边），自己不做。
 *
 * 这样做的原因：pipe-server 是 HCEM.exe 的子进程、长期驻留，
 * 改了插件代码它不会重新加载，会出现「DSH 里新代码、pipe-server 里旧代码」
 * 两套同步逻辑打架（实测：关「本地分流」时还把 embedding 杀了，
 * 而 DSH 里的代码明明已经把它设成常驻）。
 *
 * @param {boolean} force true=绕过「状态没变就跳过」的去重（唤醒/重连必须传）
 */
function syncModelsNow(force) {
  let mods = {}
  try {
    mods = JSON.parse(fs.readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`, 'utf8'))
  } catch {}
  return postToPlugin('/mods', { mods, force }, force ? '唤醒同步' : '开关同步')
}

/** 关掉所有模型（休眠 / exe 退出）—— 同样转发给插件执行 */
function stopModelsNow(why) {
  return postToPlugin('/mods/stop', { why }, '关闭全部模型：' + why)
}

/** POST 到插件的本地 HTTP（8097）。插件没起就静默跳过——没有 DSH，模型也没意义。 */
function postToPlugin(path, body, label) {
  const port = Number(process.env.HCEM_VOICE_PORT || 8097)
  const url = 'http://127.0.0.1:' + port + path
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => r.json())
    .then((j) => {
      log('INFO', 'services', label + ' → ' + JSON.stringify(j.result || j))
      return j
    })
    .catch((e) => {
      log('WARN', 'services', label + ' 转发失败（插件可能没起）: ' + String((e && e.message) || e))
    })
}

/* ---------------------------------------------------------------
 * 多模态开关语义（插件侧）
 *
 * 开关状态来自 UI（CMD set_mods），这里的职责是把它翻译成
 * 「该模块是否启用 / 用什么模式」，并写一份 mods.json 供插件其它
 * 模块读取。真正的采集/检测实现由各自模块负责：
 *
 *  desktop-watch  桌面截图        → desktop-watch.mjs
 *  video-watch    摄像头 + 自动看视频 → video-companion.mjs
 *  audio-watch    系统声音回环（不含麦克风）→ audio-loopback.mjs
 *  voice-out      TTS 播放        → tts/pipeline.mjs
 *  voice-in       长按悬浮球开麦   → asr push-to-talk
 *  local-route    本地模型分流     → router
 * --------------------------------------------------------------- */
const MOD_FILE = `${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`

function applyMods(mods) {
  const m = mods || {}

  // 语义派生（插件其它模块读这个对象即可）
  const derived = {
    // 视频：开启常驻后，任何视频播放都自动拉起「看视频」；
    //       关闭时只在用户明确说「一起看」时才拉起。
    video: {
      enabled: Boolean(m['video-watch']),
      autoWatch: Boolean(m['video-watch']),
      onDemandOnly: !m['video-watch'],
    },
    // 音频：监听系统声音（回环），明确排除麦克风。
    audio: {
      enabled: Boolean(m['audio-watch']),
      source: 'system-loopback',
      excludeMicrophone: true,
    },
    // 语音输入：只在长按悬浮球时开麦。
    voiceIn: {
      enabled: Boolean(m['voice-in']),
      mode: 'push-to-talk',
      alwaysListening: false,
    },
    desktop: { enabled: Boolean(m['desk-watch']) },
    voiceOut: { enabled: Boolean(m['voice-out']) },
    localRoute: { enabled: Boolean(m['local-route']) },
    updatedAt: Date.now(),
  }

  try {
    fs.mkdirSync(`${globalThis.__HCEM_HOME__}/data/ui-state`, { recursive: true })
    fs.writeFileSync(MOD_FILE, JSON.stringify(derived, null, 2), 'utf8')
  } catch (e) {
    console.error('[bridge] 写 mods.json 失败:', e.message)
  }

  // 便于观察
  const on = Object.keys(derived).filter((k) => derived[k] && derived[k].enabled)
  console.log('[mods] 已启用:', on.length ? on.join(', ') : '（无）')
  if (derived.video.autoWatch) console.log('[mods] 视频常驻开启：任意视频播放都将自动拉起「看视频」')
  if (derived.audio.enabled) console.log('[mods] 音频常驻开启：监听系统声音（不含麦克风）')
  if (derived.voiceIn.enabled) console.log('[mods] 语音输入：仅长按悬浮球时开麦')
  logMods(m, derived)
  // 真正启停采集模块（失败不影响开关状态落盘）
  applyModsToModules(m).catch((e) => log('ERROR', 'mods', 'apply modules: ' + (e && e.message)))
}

/* ---------------------------------------------------------------
 * UI 通用命令 → 落盘（插件其它模块直接读这些 json）
 *   save_persona / set_sliders / set_talk / set_volume / add_schedule
 * --------------------------------------------------------------- */
const UI_DIR = `${globalThis.__HCEM_HOME__}/data/ui-state`

function handleUiCmd(cmd, data) {
  try {
    fs.mkdirSync(UI_DIR, { recursive: true })
    const write = (name, obj) => fs.writeFileSync(UI_DIR + '\\' + name, JSON.stringify(obj, null, 2), 'utf8')

    switch (cmd) {
      case 'save_persona':
        write('persona.json', { text: String(data?.text || ''), savedAt: Date.now() })
        break
      case 'set_sliders':
        write('sliders.json', { ...data, savedAt: Date.now() })
        break
      case 'set_classifier': {
    // 分类头开关（默认关）。写到 ui-state/classifier.json，插件每次检索前读它。
    const enabled = data?.enabled === true
    const cur = (() => {
      try {
        return JSON.parse(readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/classifier.json`, 'utf8'))
      } catch {
        return {}
      }
    })()
    writeFileSync(
      `${globalThis.__HCEM_HOME__}/data/ui-state/classifier.json`,
      JSON.stringify({ ...cur, enabled, alpha: Number(cur.alpha) || 0.3, updatedAt: Date.now() }, null, 2),
      'utf8',
    )
    break
  }
  case 'set_talk': {
        // 搭话度 = 气泡档位，是**同一个字段**（settings.json 的 talkativeness）。
        // 以前这里只写 ui/talk.json，而插件从来没人读那个文件 ——
        // 于是菜单里改搭话度对插件完全无效（一直停在旧值）。这里直接写 settings.json。
        const t = Math.min(2, Math.max(0, Math.round(Number(data?.talk))))
        if (Number.isFinite(t)) {
          const sPath = `${globalThis.__HCEM_HOME__}/data/settings.json`
          let cur = {}
          try {
            cur = JSON.parse(fs.readFileSync(sPath, 'utf8'))
          } catch {}
          cur.talkativeness = t
          fs.writeFileSync(sPath, JSON.stringify(cur, null, 2), 'utf8')
          log('INFO', 'bubble', '档位改为 ' + ['话痨', '好奇', '安静'][t] + '（来自 exe 菜单）')
        }
        write('talk.json', { ...data, savedAt: Date.now() })
        break
      }
      case 'set_volume':
        write('volume.json', { ...data, savedAt: Date.now() })
        break
      case 'set_enabled': {
        // 插件总开关：直接写 data/settings.json 的 enabled
        const sPath = `${globalThis.__HCEM_HOME__}/data/settings.json`
        let cur = {}
        try {
          cur = JSON.parse(fs.readFileSync(sPath, 'utf8'))
        } catch {}
        cur.enabled = data && data.enabled === true
        fs.writeFileSync(sPath, JSON.stringify(cur, null, 2), 'utf8')
        log('INFO', 'ui', '插件开关 -> ' + (cur.enabled ? '开' : '关'))
        break
      }
      case 'set_hsl_base':
        // 性格 / 搭话度推导出的 HSL 系统基准（只落盘，不引用闭包里的 state）
        write('hsl-base.json', { ...data, savedAt: Date.now() })
        break
      case 'add_schedule': {
        let arr = []
        try { arr = JSON.parse(fs.readFileSync(UI_DIR + '\\schedule.json', 'utf8')) } catch {}
        arr.push({ ...data, createdAt: Date.now() })
        write('schedule.json', arr)
        break
      }
      default:
        break
    }
    // ui-cmd.log 会一直长（实测已 50KB），超过 2MB 轮转一份，跟 events.log 一样
    try {
      const lp2 = UI_DIR + '\\ui-cmd.log'
      if (fs.existsSync(lp2) && fs.statSync(lp2).size > 2 * 1024 * 1024) fs.renameSync(lp2, UI_DIR + '\\ui-cmd.log.1')
    } catch {}
    fs.appendFileSync(UI_DIR + '\\ui-cmd.log', new Date().toISOString() + ' ' + cmd + ' ' + JSON.stringify(data) + '\n')
    console.log('[ui] ' + cmd)
    log('INFO', 'ui', cmd, data)
  } catch (e) {
    console.error('[ui] 写入失败:', e.message)
  }
}
