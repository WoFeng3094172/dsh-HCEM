// 本地模型服务管理（视觉优化 S3 错峰 + S4 离线）
// - 拉起/停止 llama-server 服务
// - 显存检查（nvidia-smi）
// - 错峰切换（先停后起，确认显存归零）
import { spawn, execFileSync } from 'node:child_process'
import './home.mjs'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS = process.env.HCEM_MODELS_DIR || globalThis.__HCEM_MODELS__
const LLAMA = join(MODELS, 'llama.cpp-cuda', 'llama-server.exe')
// KV 缓存目录（三级存储的磁盘层）
const KV_DIR = process.env.HCEM_KV_DIR || join(MODELS, '..', 'data', 'kv-cache')

export const SERVICES = {
  qwen3: {
    name: 'Qwen3-1.7B',
    port: 8093,
    // 1.7B 全面顶替 0.6B：路由分类实测 12/15（0.6B 只有 7/15，且系统性把 cloud 判成 local），
    // 摘要也明显好于 0.6B（0.6B 会复读）。代价是慢约 2.4 倍，可接受。
    // CPU 常驻，KV 量化省内存（-fa 在 CPU 上可能无效，但无害）。
    model: join(MODELS, 'Qwen3-1.7B-Q4_K_M', 'Qwen3-1.7B-Q4_K_M.gguf'),
    args: ['-c', '4096', '-ngl', '0', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
  },
  embedding: {
    name: 'Qwen3-Embedding',
    port: 8094,
    model: join(MODELS, 'Qwen3-Embedding-0.6B-Q8_0', 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
    // 改 CPU：0.6B 在 CPU 上单条 63ms（GPU 50ms），换回 1.1 GB 显存，8G 卡更划算
    args: ['-c', '2048', '-ngl', '0', '--embedding', '--pooling', 'mean'],
  },
  omni: {
    name: 'OmniDimen-4B-Emotion',
    port: 8098,
    model: join(MODELS, 'OmniDimen-4B-Emotion-GGUF-q4_K_M', 'OmniDimen-v1.0-4b-Emotion_q4_K_M.gguf'),
    // 上下文提到 8192：flash-attn 省 KV 显存，KV 量化 q8_0 再省一半，
    // 实测约 2.75 GB（4096 f16 时是 3.0 GB），换来双倍上下文。
    args: ['-c', '8192', '-ngl', '99', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
  },
  qwen25vl: {
    name: 'Qwen2.5-VL-3B',
    port: 8091,
    model: join(MODELS, 'Qwen2.5-VL-3B-Instruct-GGUF', 'Qwen_Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf'),
    mmproj: join(MODELS, 'Qwen2.5-VL-3B-Instruct-GGUF', 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf'),
    // 4096：够看视频（桌面用不到这么多也不亏），flash-attn + KV q8_0 压显存
    args: ['-c', '4096', '-ngl', '99', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
  },
}

// 场景配置：每个场景的模型 c 与 KV 位置
//   daily  ：日常（在线非视频）→ OmniDimen 3-4G，KV 在 GPU
//   offline：离线非视频 → OmniDimen 6G，KV 在 GPU
//   vision ：看视频 → OmniDimen 小 c + KV 放 CPU；Qwen3.5 分析
export const SCENE_CONFIG = {
  daily: { omni: { c: 4096, noKvOffload: false } },
  offline: { omni: { c: 8192, noKvOffload: false } },
  vision: { omni: { c: 1024, noKvOffload: true }, qwen25vl: { c: 2048, noKvOffload: false } },
}

export function portUp(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port, timeout: timeoutMs })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { resolve(false) })
  })
}

/** 剩余显存（MB） */
export function freeVramMB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000, encoding: 'utf8' })
    const n = parseInt(String(out).trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** 拉起服务（不等待就绪） */
const PID_FILE = `${globalThis.__HCEM_HOME__}/data/.llama-pids.json`

function readPids() {
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/** 判断该端口记录的 pid 是否还活着（用来识别「启动标记残留」） */
function recordedPidAlive(port) {
  try {
    const p = JSON.parse(readFileSync(PID_FILE, 'utf8'))
    const pid = Number(p[String(port)])
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 清掉启动标记（停服务时调用，避免残留把后续启动挡住） */
function clearStarting(port) {
  try {
    globalThis.__hcemStarting?.delete(port)
  } catch {}
}
function recordPid(port, pid) {
  try {
    const p = readPids()
    p[String(port)] = pid
    mkdirSync(`${globalThis.__HCEM_HOME__}/data`, { recursive: true })
    writeFileSync(PID_FILE, JSON.stringify(p, null, 2), 'utf8')
  } catch {}
}

/** 停掉所有 llama-server（不管哪个端口），用于 DSH/HCEM 退出时清理 */
export function stopAllServices(logger = console) {
  // 休眠/关闭时 TTS 也要停（它不在 SERVICES 里，单独处理）
  try {
    stopTtsSync() // 休眠/关闭时 TTS 也要停
  } catch {}
  const result = { killed: [] }
  // 先按端口停
  for (const key of Object.keys(SERVICES)) {
    try {
      if (isPortListening(SERVICES[key].port)) {
        stopService(key, logger)
        result.killed.push(SERVICES[key].port)
      }
    } catch {}
  }
  // 再按记录的 pid 兜底（端口可能已经变了）
  const pids = readPids()
  for (const [port, pid] of Object.entries(pids)) {
    try {
      process.kill(Number(pid), 0)
      process.kill(Number(pid), 'SIGKILL')
      result.killed.push('pid:' + pid)
    } catch {}
  }
  try {
    writeFileSync(PID_FILE, '{}', 'utf8')
  } catch {}
  logger.info?.('[hcem] 清理模型进程: ' + (result.killed.join(',') || '无'))
  return result
}

/** 同步检查端口是否已在监听（用 netstat，和 stopService 一套做法） */
function isPortListening(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 4000, encoding: 'utf8' })
    return String(out)
      .split('\n')
      .some((l) => l.includes(`:${port}`) && l.toUpperCase().includes('LISTENING'))
  } catch {
    return false
  }
}

/**
 * 每个功能开关对应哪些模型。
 * 用户要的是「各管各的」，不要一起开一起关。
 */
export const MOD_SERVICES = {
  video: ['qwen25vl'], // 看视频：Qwen2.5-VL
  audio: ['omni'], // 听声音：音乐情感
  // 本地分流：小模型 + 情绪。embedding 不在这里 —— 它是常驻的基础设施，见 ALWAYS_ON
  localRoute: ['qwen3', 'omni'],
  voiceOut: [], // 语音输出走 Python，不占 llama 端口
  voiceIn: [], // 语音输入走 Python
  desktop: ['qwen25vl'], // 看屏幕：Qwen2.5-VL
}

/**
 * 常驻服务：不受任何开关影响，始终在跑。
 *
 * Qwen3-Embedding 是记忆/语义检索的基础设施（记忆去重、语义缓存、情绪语义分析都用它）。
 * 之前它挂在「本地分流常驻」下面，关了分流向量就没了 —— 记忆仍然在写，但查不回来，
 * 表现就是「AI 记不住东西」。这类底座不该跟可选开关绑定。
 */
const ALWAYS_ON = ['embedding']

// ── 显存准入（同步）──────────────────────────────────────────
// 8 GB 卡上 Omni(2.5G) + VL(3.2G) + TTS(≈1.4G) 会顶满，llama.cpp 分配失败
// 就让那条链路直接不可用。这里在 spawn 之前算余量，不够按 TTS > VL > Omni 让位，
// 并把被踢掉的开关同步关掉（写 evicted.json，pipe-server 轮询后推给菜单）。
const VRAM_EST = { omni: 2700, qwen25vl: 3400, tts: 1600, embedding: 0, qwen3: 0 }
const EVICT_ORDER = ['tts', 'qwen25vl', 'omni']
const MODS_FILE = `${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`
const EVICT_FILE = `${globalThis.__HCEM_HOME__}/data/ui-state/evicted.json`

function vramFreeMB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      timeout: 4000,
      windowsHide: true,
      encoding: 'utf8',
    })
    const v = Number(String(out).trim().split('\n')[0])
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function sleepSync(ms) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${ms}`], {
      timeout: ms + 4000,
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {}
}

/** 杀掉 TTS 常驻服务（按端口 8099 找进程，插件重启后也能杀） */
/** 停掉 TTS 常驻服务（按端口 8099 找进程，插件重启后也能杀） */
export function stopTts() {
  stopTtsSync()
}

function stopTtsSync() {
  const script =
    "Get-NetTCPConnection -LocalPort 8099 -State Listen -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }"
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 6000,
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {}
}

function markEvictedSync(evicted) {
  try {
    const mods = JSON.parse(readFileSync(MODS_FILE, 'utf8'))
    const off = (k) => {
      if (mods[k] && typeof mods[k] === 'object') mods[k].enabled = false
      else mods[k] = { enabled: false }
    }
    for (const e of evicted) {
      if (e === 'tts') off('voiceOut')
      if (e === 'qwen25vl') {
        off('video')
        off('desktop')
      }
      if (e === 'omni') off('audio')
    }
    writeFileSync(MODS_FILE, JSON.stringify(mods, null, 2), 'utf8')
    writeFileSync(EVICT_FILE, JSON.stringify({ evicted, mods, ts: Date.now(), reason: 'vram' }, null, 2), 'utf8')
  } catch {}
}

/**
 * 启动前确保显存够用（同步）。
 * @returns {{ok:boolean, evicted:string[], free:number|null, need:number}}
 */
export function ensureVramFor(key, logger = console) {
  const need = VRAM_EST[key] || 0
  if (need <= 0) return { ok: true, evicted: [], free: null, need }
  let free = vramFreeMB()
  if (free === null) return { ok: true, evicted: [], free: null, need }
  if (free >= need + 300) return { ok: true, evicted: [], free, need }

  const evicted = []
  for (const victim of EVICT_ORDER) {
    if (victim === key) continue
    const running =
      victim === 'tts'
        ? isPortListening(8099)
        : Boolean(SERVICES[victim]) && isPortListening(SERVICES[victim].port)
    if (!running) continue
    logger.info?.(`[services] 显存不足（剩 ${free}MB，需 ${need}MB）→ 让位：${victim}`)
    if (victim === 'tts') stopTtsSync()
    else stopService(victim, logger)
    evicted.push(victim)
    for (let i = 0; i < 8; i += 1) {
      sleepSync(500)
      free = vramFreeMB()
      if (free === null || free >= need + 300) break
    }
    if (free === null || free >= need + 300) break
  }
  if (evicted.length) markEvictedSync(evicted)
  const ok = free === null || free >= need + 300
  if (!ok) logger.warn?.(`[services] 显存仍不足：剩 ${free}MB，需 ${need}MB；拒绝启动 ${key}`)
  return { ok, evicted, free, need }
}


/** 根据 mods 状态，把该开的开起来、该关的关掉 */
/**
 * 键名别名：菜单传的是扁平键（video-watch / local-route / desk-watch），
 * mods.json 里是嵌套对象（video / localRoute / desktop）。
 * 两套写法都要认，否则「开关开了但模型不启动」。
 */
const MOD_ALIASES = {
  video: ['video', 'video-watch'],
  audio: ['audio', 'audio-watch'],
  desktop: ['desktop', 'desk-watch'],
  localRoute: ['localRoute', 'local-route'],
  voiceOut: ['voiceOut', 'voice-out'],
  voiceIn: ['voiceIn', 'voice-in'],
}

function modOn(mods, canonical) {
  const names = MOD_ALIASES[canonical] || [canonical]
  for (const n of names) {
    const v = mods?.[n]
    if (typeof v === 'boolean') return v
    if (v && typeof v === 'object' && typeof v.enabled === 'boolean') return v.enabled
  }
  return false
}

let lastSyncKey = ''

/**
 * 根据 mods 状态，把该开的开起来、该关的关掉。
 *
 * @param {object} mods 开关状态
 * @param {object} logger
 * @param {{force?: boolean}} [opts] force=true 绕过「状态没变就不重复同步」的去重。
 *        休眠后唤醒必须传 force：开关状态没变，但模型确实被杀了，不去重就会跳过、醒不回来。
 */
export function syncServicesWithMods(mods, logger = console, opts = {}) {
  const force = opts.force === true
  // 防抖：同样的开关状态不重复同步（菜单会连续发多次 set_mods）
  const key = Object.keys(MOD_ALIASES)
    .map((k) => k + ':' + (modOn(mods, k) ? 1 : 0))
    .join(',')
  if (!force && key === lastSyncKey) return { skipped: 'unchanged' }
  lastSyncKey = key

  const want = new Set(ALWAYS_ON)
  for (const [canonical, list] of Object.entries(MOD_SERVICES)) {
    if (modOn(mods, canonical)) for (const s of list) want.add(s)
  }

  const result = { started: [], stopped: [], already: [], notStarted: [] }
  for (const [key2, spec] of Object.entries(SERVICES)) {
    if (want.has(key2)) {
      const listening = isPortListening(spec.port)
      const r = startService(key2, logger)
      if (r.ok) {
        // starting 表示「上一次启动还没落地」，不要谎报成已启动
        if (r.starting || listening) result.already.push(key2)
        else result.started.push(key2)
      }
    } else {
      if (isPortListening(spec.port)) {
        try {
          stopService(key2, logger)
          result.stopped.push(key2)
        } catch {}
      } else {
        result.notStarted.push(key2)
      }
    }
  }

  logger.info?.(
    '[hcem] 按开关同步模型：新起=' +
      (result.started.join(',') || '无') +
      ' 已在跑=' +
      (result.already.join(',') || '无') +
      ' 停掉=' +
      (result.stopped.join(',') || '无'),
  )
  return result
}

export function startService(key, logger = console, opts = {}) {
  const exclusive = opts.exclusive !== false
  const scene = opts.scene ? SCENE_CONFIG[opts.scene]?.[key] : null
  const spec = SERVICES[key]
  if (!spec) return { ok: false, error: 'unknown service' }
  if (!existsSync(LLAMA)) return { ok: false, error: 'llama-server missing' }
  if (!existsSync(spec.model)) return { ok: false, error: 'model missing: ' + spec.model }
  try {
    let args = spec.args.slice()
    if (scene?.c) {
      const i = args.indexOf('-c')
      if (i >= 0 && args[i + 1]) args[i + 1] = String(scene.c)
      else args.push('-c', String(scene.c))
    }
    const argv = ['-m', spec.model, '--host', '127.0.0.1', '--port', String(spec.port), ...args]
    if (scene?.noKvOffload) argv.push('--no-kv-offload')
    if (spec.mmproj) argv.push('--mmproj', spec.mmproj)
    // KV 三级存储：前缀复用 + 磁盘 slot 保存（三级存储的磁盘层）
    try {
      if (!existsSync(KV_DIR)) mkdirSync(KV_DIR, { recursive: true })
      argv.push('--kv-unified') // 多请求共享同一块 KV 缓冲池
      argv.push('--cache-reuse', '256')
      argv.push('--slot-save-path', KV_DIR)
    } catch {}
    // ── 防重复：端口已经在监听就直接复用，不再 spawn ──
    // 不检查的话，重复调用会起多个 llama-server 抢同一端口，
    // 绑定失败的进程依然占着显存不放（实测攒到 10 个把 8G 吃满）。
    if (isPortListening(spec.port)) {
      logger.info?.(`[hcem] ${spec.name} (:${spec.port}) 已在运行，跳过`)
      return { ok: true, port: spec.port, existing: true }
    }
    // 同一进程内也防一手（netstat 有延迟，连续调用可能漏判）
    if (globalThis.__hcemStarting?.has(spec.port)) {
      // 但「标记还在」不等于「真在启动」：进程被停掉后标记会残留 30 秒，
      // 这段时间里所有启动请求都会被静默跳过，表现为「说启动了其实没起」。
      if (recordedPidAlive(spec.port)) {
        logger.info?.(`[hcem] ${spec.name} (:${spec.port}) 正在启动中，跳过本次`)
        return { ok: true, port: spec.port, starting: true }
      }
      globalThis.__hcemStarting.delete(spec.port)
    }
    globalThis.__hcemStarting = globalThis.__hcemStarting || new Set()
    globalThis.__hcemStarting.add(spec.port)
    setTimeout(() => globalThis.__hcemStarting?.delete(spec.port), 30000)

    // 显存准入（同步）：不够就让位，并把菜单里对应开关同步关掉
    const admit = ensureVramFor(key, logger)
    if (!admit.ok) {
      return { ok: false, error: 'vram-insufficient', free: admit.free, need: admit.need, evicted: admit.evicted }
    }
    const child = spawn(LLAMA, argv, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    // 记下 pid：DSH/HCEM 退出时要把这些子进程一起收掉
    recordPid(spec.port, child.pid)
    logger.info?.(`[hcem] started ${spec.name} (:${spec.port}, pid ${child.pid})`)
    return { ok: true, port: spec.port, pid: child.pid }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 停止服务（kill 该端口的 llama-server） */
export function stopService(key, logger = console) {
  const spec = SERVICES[key]
  if (!spec) return { ok: false, error: 'unknown service' }
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000, encoding: 'utf8' })
    const pid = String(out).split('\n').find((l) => l.includes(`:${spec.port}`) && l.includes('LISTENING'))?.trim().split(/\s+/).pop()
    if (pid) {
      execFileSync('taskkill', ['/PID', pid, '/F'], { timeout: 5000 })
      logger.info?.(`[hcem] stopped ${spec.name} (:${spec.port}, pid ${pid})`)
      return { ok: true, port: spec.port, pid }
    }
    clearStarting(spec.port)
    return { ok: true, already: true }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 等待显存归零（最多 15s） */
export async function waitVramFreed(minFreeMB = 800) {
  for (let i = 0; i < 15; i += 1) {
    const free = freeVramMB()
    if (free === null || free >= minFreeMB) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * 错峰切换：先停 stopKeys，再起 startKey
 * @returns {{ ok: boolean, error?: string }}
 */
export async function switchServices({ stopKeys = [], startKey, logger = console, minFreeMB = 800 }) {
  for (const k of stopKeys) stopService(k, logger)
  const freed = await waitVramFreed(minFreeMB)
  if (!freed) {
    logger.warn?.(`[hcem] 显存不足（<${minFreeMB}MB），拒绝启动 ${startKey}`)
    return { ok: false, error: 'vram-insufficient' }
  }
  return startService(startKey, logger)
}

/**
 * 确保服务运行（健康检查 + 自动重试）
 * @param {string} key 服务键
 * @param {object} opts { logger, waitMs=40000, retries=3, checkMs=800 }
 * @returns {Promise<{ok:boolean, port?:number, pid?:number, error?:string, waited?:number}>}
 */
export async function ensureRunning(key, opts = {}) {
  const logger = opts.logger ?? console
  const waitMs = opts.waitMs ?? 40000
  const retries = opts.retries ?? 3
  const spec = SERVICES[key]
  if (!spec) return { ok: false, error: 'unknown service' }
  if (await portUp(spec.port, 500)) return { ok: true, port: spec.port, already: true }
  let lastError = ''
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    // 清理可能残留的同端口进程（僵尸）
    try { stopService(key, logger) } catch {}
    const r = startService(key, logger, { scene: opts.scene })
    if (!r.ok) { lastError = r.error; continue }
    const t0 = Date.now()
    while (Date.now() - t0 < waitMs) {
      await new Promise((res) => setTimeout(res, opts.checkMs ?? 800))
      if (await portUp(spec.port, 500)) {
        logger.info?.(`[hcem] ${spec.name} 就绪（${Date.now() - t0}ms，第 ${attempt} 次）`)
        return { ok: true, port: spec.port, pid: r.pid, waited: Date.now() - t0, attempt }
      }
    }
    lastError = `wait timeout (${waitMs}ms)`
    logger.warn?.(`[hcem] ${spec.name} 第 ${attempt} 次启动超时`)
    try { stopService(key, logger) } catch {}
    await new Promise((res) => setTimeout(res, 2000))
  }
  return { ok: false, error: lastError || 'failed to start' }
}

/**
 * 监控一组服务：定期检查，挂了自动重启（返回 stop 函数）
 * @param {string[]} keys
 * @param {object} opts { intervalMs=30000, logger }
 * @returns {() => void} stop
 */
export function monitorServices(keys = [], opts = {}) {
  const logger = opts.logger ?? console
  const intervalMs = opts.intervalMs ?? 30000
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      for (const key of keys) {
        const spec = SERVICES[key]
        if (!spec) continue
        try {
          if (await portUp(spec.port, 500)) continue
          logger.warn?.(`[hcem] 服务 ${spec.name} 掉线，尝试重启`)
          const r = await ensureRunning(key, { logger, waitMs: 40000, retries: 2 })
          if (!r.ok) logger.warn?.(`[hcem] ${spec.name} 重启失败: ${r.error}`)
        } catch (error) {
          logger.warn?.(`[hcem] monitor ${key} error: ${String((error && error.message) || error)}`)
        }
      }
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * 清理过期 KV 缓存（三级存储的「删除」层）
 * @param {number} maxAgeHours 超过多少小时的文件删除（默认 72）
 */
export function pruneKvCache(maxAgeHours = 72) {
  let removed = 0
  try {
    if (!existsSync(KV_DIR)) return 0
    const now = Date.now()
    for (const f of readdirSync(KV_DIR)) {
      try {
        const p = join(KV_DIR, f)
        const st = statSync(p)
        if (now - st.mtimeMs > maxAgeHours * 3600 * 1000) {
          unlinkSync(p)
          removed += 1
        }
      } catch {}
    }
  } catch {}
  return removed
}

/**
 * 切换场景：按 SCENE_CONFIG 停止多余模型、启动所需模型
 * @param {'daily'|'offline'|'vision'} scene
 * @param {object} opts { logger, waitMs }
 */
export async function switchScene(scene, opts = {}) {
  const logger = opts.logger ?? console
  const cfg = SCENE_CONFIG[scene]
  if (!cfg) return { ok: false, error: 'unknown scene' }
  const result = { scene, started: [], stopped: [] }
  // 停：当前场景不需要的（omni/qwen25vl）
  for (const key of ['omni', 'qwen25vl']) {
    if (!cfg[key] && (await portUp(SERVICES[key].port, 400))) {
      stopService(key, logger)
      result.stopped.push(key)
    }
  }
  // 起：当前场景需要的（带场景参数）
  for (const key of ['omni', 'qwen25vl']) {
    if (!cfg[key]) continue
    const spec = cfg[key]
    const running = await portUp(SERVICES[key].port, 400)
    if (running) {
      // 已在跑：检查参数是否匹配（c 不同 → 重启）
      // 简化：直接重启（确保配置生效）
      stopService(key, logger)
      await new Promise((r) => setTimeout(r, 2000))
    }
    const r = await ensureRunning(key, { logger, waitMs: opts.waitMs ?? 40000, retries: 2, scene })
    if (r.ok) result.started.push(key)
  }
  return { ok: result.started.length > 0 || Object.keys(cfg).length === 0, ...result }
}
