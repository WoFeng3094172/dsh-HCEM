/**
 * 语音输入（对讲机模式）
 *
 * 语义（用户定）：
 *   · 「语音输入常驻」开着，不代表麦克风常开；
 *   · 用户**长按悬浮球**才开麦；
 *   · 长按期间说的话一句不能漏（分段录音 + 累积识别）；
 *   · 松开即提交；
 *   · 长按时如果 AI 正在说话，立刻打断。
 *
 * 实现要点：
 *   1. 每段 2 秒录音，**累积**拼成一个 wav；
 *   2. 每段录完就把「从开始到现在」的完整音频送识别（重叠识别，不怕切断词）；
 *   3. 松开时用最后一次识别结果作为最终文本；
 *   4. 长按开始就尝试打断正在播放的合成语音。
 */

import { execFile, spawn } from 'node:child_process'
import '../home.mjs'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.mjs'
// 三件套：说了什么（带 VAD）/ 什么语气 / 谁在说
import { transcribe, emotionOf } from './pipeline.mjs'
import { resolvePython } from './python.mjs'

const run = promisify(execFile)

const DATA_DIR = `${globalThis.__HCEM_HOME__}/data`
const MODELS_DIR = `${globalThis.__HCEM_HOME__}/models`
const PYTHON = resolvePython()

// 语音输入用**麦克风**脚本；record.py 是 WASAPI loopback（录系统播放声），
// 拿它做语音输入会卡住并超时（日志里表现为「分段录音失败 exit 2」）。
const RECORD_PY = join(`${globalThis.__HCEM_HOME__}/plugin/lib/audio`, 'record_mic.py')

const SEGMENT_MS = 2000 // 每段 2 秒

let session = null

/** 把多个 wav 拼起来（同格式，直接拼数据块） */
function concatWavs(inputs, outPath) {
  if (inputs.length === 0) return false
  mkdirSync(join(outPath, '..'), { recursive: true })
  const bufs = inputs.map((p) => readFileSync(p))
  if (bufs.length === 1) {
    writeFileSync(outPath, bufs[0])
    return true
  }
  // 取第一个的头部（44 字节标准 PCM wav 头），重写长度
  const head = Buffer.from(bufs[0].subarray(0, 44))
  const data = Buffer.concat(bufs.map((b) => b.subarray(44)))
  const total = 36 + data.length
  head.writeUInt32LE(total - 8, 4)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(outPath, Buffer.concat([head, data]))
  return true
}

/** 识别一个 wav（CrispASR + Qwen3-ASR，见 asr.mjs） */
async function recognize(wavPath) {
  return transcribe(wavPath)
}

/** 打断正在播放的合成语音 */
export function interruptPlayback() {
  try {
    // 播放用的是 PowerShell 的 SoundPlayer，进程名 powershell.exe；只杀带播放命令的
    const p = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'SoundPlayer' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    p.unref()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}


/** 声纹识别：返回 { ok, best, score }，best 是 voiceprints 目录里的名字（owner / unknown） */
async function identifySpeaker(wavPath) {
  try {
    const vp = join(`${globalThis.__HCEM_HOME__}`, 'plugin', 'lib', 'audio', 'voiceprint.py')
    const libDir = join(DATA_DIR, 'voiceprints')
    if (!existsSync(vp)) return { ok: false, error: 'voiceprint.py missing' }
    if (!existsSync(libDir)) return { ok: false, error: 'no voiceprint library' }

    const py = PYTHON
    const { stdout } = await run(py, [vp, 'identify', wavPath, libDir], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    const s = String(stdout)
    // 找 "best=xxx score=0.8123"
    const m = s.match(/best=(\S+)\s+score=([0-9.]+)/)
    if (!m) {
      // 库里空着 → 用这段音频注册成 owner
      if (s.includes('库是空的')) {
        const reg = await run(py, [vp, 'embed', wavPath, join(libDir, 'owner.npy')], {
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        })
        if (String(reg.stdout).includes('ok:')) {
          return { ok: true, best: 'owner', score: 1.0, registered: true }
        }
      }
      return { ok: false, error: 'parse failed: ' + s.slice(0, 200) }
    }
    const score = parseFloat(m[2])
    // 阈值 0.5：低于它说明不是库里那个人（实测不同内容的两段话可能掉到 0.1 甚至负值）
    if (score < 0.5) {
      return { ok: true, best: 'unknown', score, matched: m[1], registered: false }
    }
    // 文件名即人名：owner.npy → owner（用户本人），张三.npy → 张三
    return { ok: true, best: m[1], score, registered: false }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 开始一段语音输入（长按） */
/** 读 mods.json 的语音输入开关（voice-in / voiceIn.enabled） */
function voiceInEnabled() {
  try {
    const p = `${globalThis.__HCEM_DATA__}/ui-state/mods.json`
    const m = JSON.parse(readFileSync(p, 'utf8'))
    if (m?.voiceIn && typeof m.voiceIn.enabled === 'boolean') return m.voiceIn.enabled
    if (m && typeof m['voice-in'] === 'boolean') return m['voice-in']
  } catch {}
  return false
}

/**
 * 开始一段语音输入（长按）
 *
 * 2026-11-19 改成「一次连续录音」：
 *   以前是每 2 秒切一段再拼接，拼接点会丢几十毫秒，用户听感是"吃字"。
 *   现在启动一个 record_mic.py（时长 0 = 一直录），松手时发 stop，
 *   整个按住期间是一段连续音频，中间没有断点。
 */
export function startVoiceInput() {
  if (!voiceInEnabled()) {
    log('INFO', 'voice', '语音输入未开启，忽略长按')
    return { ok: false, error: '语音输入未开启' }
  }
  if (session) return { ok: true, already: true }

  const dir = join(DATA_DIR, 'voice-input')
  mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const wav = join(dir, `take-${stamp}.wav`)

  // 立刻打断 AI 说话
  interruptPlayback()

  // 启动长录进程（时长 0 = 一直录到 stdin 收到 stop）
  const child = spawn(PYTHON, [RECORD_PY, wav, '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  session = {
    stamp,
    dir,
    wav,
    child,
    startedAt: Date.now(),
    stopped: false,
  }

  child.stdout?.on('data', (b) => {
    const s = String(b).trim()
    if (s) log('INFO', 'voice', '录音进程: ' + s.slice(0, 160))
  })
  child.stderr?.on('data', (b) => {
    const s = String(b).trim()
    if (s) log('WARN', 'voice', '录音进程错误: ' + s.slice(0, 200))
  })
  child.on('exit', (code) => {
    if (session && session.child === child) {
      log('WARN', 'voice', '录音进程提前退出 code=' + code)
    }
  })

  log('INFO', 'voice', '长按开麦（连续录音）')
  return { ok: true }
}
/**
 * 录「一句话」，自动断句。
 *
 * 和 startVoiceInput 的区别：那个靠「按住/松开」控制，这个自己判断说完没有。
 * 通话模式用它——没人按按钮。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.continuation] true 用 -2 模式：不等人声，从第一帧开始录
 *        （判断「用户是不是还在接着说」时用）
 * @param {number} [opts.timeoutMs] 保险丝，进程卡住就杀掉
 * @returns {Promise<{ok:boolean, wav?:string, nospeech?:boolean, line?:string, error?:string}>}
 */
export function recordUtterance({ continuation = false, timeoutMs = 45000, onStart = null, onLevel = null } = {}) {
  return new Promise((resolve) => {
    const dir = join(DATA_DIR, 'voice-input')
    mkdirSync(dir, { recursive: true })
    const wav = join(dir, `utt-${Date.now()}.wav`)
    const mode = continuation ? '-2' : '-1'
    const child = spawn(PYTHON, [RECORD_PY, wav, mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    let out = ''
    let done = false
    let started = false
    // 流式解析：一次 data 事件可能是半行或多行
    let tail = ''
    const finish = (r) => {
      if (done) return
      done = true
      resolve(r)
    }

    const timer = setTimeout(() => {
      try {
        child.stdin?.end()
        child.kill()
      } catch {}
      finish({ ok: false, error: '录音超时' })
    }, timeoutMs)

    child.stdout?.on('data', (b) => {
      const s = String(b)
      out += s
      tail += s
      let idx
      while ((idx = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, idx).trim()
        tail = tail.slice(idx + 1)
        if (line === 'start') {
          // 开口瞬间上报：打断播放要用，不能等整句录完
          if (!started) {
            started = true
            try {
              if (typeof onStart === 'function') onStart()
            } catch {}
          }
        } else if (line.startsWith('lvl ')) {
          const v = Number(line.slice(4))
          if (Number.isFinite(v)) {
            try {
              if (typeof onLevel === 'function') onLevel(Math.max(0, Math.min(1, v)))
            } catch {}
          }
        }
      }
    })
    child.stderr?.on('data', (b) => {
      const s = String(b).trim()
      if (s) log('WARN', 'voice', '断句录音 stderr: ' + s.slice(0, 160))
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: String((e && e.message) || e) })
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const lines = String(out).trim().split(/\r?\n/).filter(Boolean)
      const okLine = lines.find((l) => l.startsWith('ok:'))
      const noSpeak = lines.find((l) => l.startsWith('nospeech:'))
      if (okLine) finish({ ok: true, wav, line: okLine })
      else if (noSpeak) finish({ ok: true, nospeech: true, line: noSpeak })
      else finish({ ok: false, error: '没有识别到录音结果: ' + (lines.pop() || '(空输出)') })
    })
  })
}

/**
 * 录一句并识别。通话模式的最小单元。
 *
 * @returns {Promise<{ok:boolean, text?:string, wav?:string, nospeech?:boolean, error?:string}>}
 */
export async function listenUtterance({ continuation = false, onStart = null, onLevel = null } = {}) {
  const rec = await recordUtterance({ continuation, onStart, onLevel })
  if (!rec.ok) return { ok: false, error: rec.error }
  if (rec.nospeech) return { ok: true, nospeech: true, text: '' }
  const asr = await recognize(rec.wav)
  if (!asr.ok) return { ok: false, wav: rec.wav, error: asr.error || '识别失败' }
  return { ok: true, wav: rec.wav, text: String(asr.text || '').trim() }
}

/** 结束语音输入（松开）：停止录音 → 识别整段 */
export async function stopVoiceInput() {
  const s = session
  if (!s) return { ok: false, error: '没有进行中的语音输入' }
  session = null

  const durationMs = Date.now() - s.startedAt

  // 让 record_mic.py 写完 wav 再退出
  try {
    if (s.child && s.child.stdin) {
      s.child.stdin.write('stop\n')
      s.child.stdin.end()
    }
  } catch {}

  // 等进程退出（最多 5 秒）
  const exited = await new Promise((resolve) => {
    if (!s.child) return resolve(true)
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        try {
          s.child.kill()
        } catch {}
        resolve(false)
      }
    }, 5000)
    s.child.once('exit', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(true)
    })
  })

  if (!exited) log('WARN', 'voice', '录音进程超时未退出')

  // 三件套并行：说了什么 / 什么语气 / 谁在说
  let text = ''
  let emotion = null
  let speaker = null
  try {
    if (existsSync(s.wav)) {
      // 先跑 ASR（快，几秒）
      const asr = await transcribe(s.wav).catch((e) => ({
        ok: false,
        error: String((e && e.message) || e),
      }))
      if (asr.ok && asr.text) text = String(asr.text).trim()

      // 只有识别出文字才跑情绪和声纹。
      // 原因：emotion2vec 每次 spawn 要加载 torch 模型，静音也要烧 10+ 秒，
      //       而空文本本来也没法送进会话，跑它纯属浪费。
      if (text) {
        const [emo, spk] = await Promise.all([
          emotionOf(s.wav).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
          identifySpeaker(s.wav).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
        ])
        if (emo.ok) emotion = { label: emo.label, score: emo.score }
        if (spk.ok) {
        speaker = {
          who: spk.best,
          score: spk.score,
          registered: Boolean(spk.registered),
          // owner 是用户本人；其它名字对应 data/zones/cold/people.md 里的人物卡
          label:
            spk.best === 'owner'
              ? '用户本人'
              : spk.best === 'unknown'
                ? '不认识的说话人'
                : spk.best,
        }
      }
      } else {
        log('INFO', 'voice', '没识别出文字，跳过情绪/声纹')
      }

      log('INFO', 'voice', '三件套结果', {
        text: String(text).slice(0, 80),
        emotion: emotion ? emotion.label + '(' + emotion.score + ')' : '(无)',
        speaker: speaker ? speaker.who + '(' + speaker.score + ')' : '(无)',
      })
    }
  } catch (e) {
    log('WARN', 'voice', '识别失败: ' + String((e && e.message) || e))
  }

  log('INFO', 'voice', '松开结束', {
    durationMs,
    file: s.wav.split(/[\\/]/).pop(),
    text: String(text).slice(0, 120),
  })

  if (text) {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      // 写两处：
      //   voice-input.json  → 最近一次（给 UI 看）
      //   voice-inbox.json  → 待送进会话的队列（DSH 插件侧读）
      const payload = {
        ts: Date.now(),
        text,
        emotion,
        speaker,
        source: 'push-to-talk',
        durationMs,
        file: s.wav.split(/[\\/]/).pop(),
      }
      writeFileSync(join(DATA_DIR, 'voice-input.json'), JSON.stringify(payload, null, 2), 'utf8')
      appendFileSync(join(DATA_DIR, 'voice-inbox.jsonl'), JSON.stringify(payload) + '\n', 'utf8')
      // 事件驱动推给 DSH 插件（不等结果，失败只记日志）
      notifyPlugin(payload).catch(() => {})
    } catch (e) {
      log('WARN', 'voice', '写入结果失败: ' + String((e && e.message) || e))
    }
  }
  return { ok: true, text, emotion, speaker, durationMs, file: s.wav }
}
/**
 * 把识别结果推给 DSH 插件（事件驱动，插件监听 127.0.0.1:8097/voice）。
 * 推送失败不影响本地文件写入——插件没启动时照样留档。
 */
async function notifyPlugin(payload) {
  const port = Number(process.env.HCEM_VOICE_PORT || 8097)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    const j = await res.json().catch(() => ({}))
    log('INFO', 'voice', '事件已推送: ' + JSON.stringify(j))
  } catch (e) {
    log('WARN', 'voice', `事件推送失败（插件未启动或端口 ${port} 未监听）: ` + String((e && e.message) || e))
  }
}

/** 取消本次录音（拖拽/短按）：停掉进程，删掉文件，不识别 */
export function cancelVoiceInput() {
  const s = session
  if (!s) return { ok: false, error: '没有进行中的语音输入' }
  session = null
  try {
    if (s.child && s.child.stdin) {
      // 发一个特殊标记，让 record_mic.py 直接退出不写文件
      s.child.stdin.write('abort\n')
      s.child.stdin.end()
    }
  } catch {}
  setTimeout(() => {
    try {
      if (s.child && !s.child.killed) s.child.kill()
    } catch {}
  }, 800)
  setTimeout(() => {
    try {
      if (existsSync(s.wav)) unlinkSync(s.wav)
    } catch {}
  }, 1500)
  log('INFO', 'voice', '取消录音（拖拽/短按）')
  return { ok: true }
}

/** 当前状态 */
export function voiceInputStatus() {
  return {
    active: Boolean(session),
    // 现在是连续录音，没有"分段"概念了，改成报已录时长
    durationMs: session ? Date.now() - session.startedAt : 0,
    file: session ? session.wav : null,
  }
}
