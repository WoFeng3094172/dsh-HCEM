// 音频管线（A1-A4）：WASAPI loopback 采集 → ASR（Qwen3-ASR，见 asr.mjs）→ emotion2vec 情绪 → 写记忆
import { execFile } from 'node:child_process'
import '../home.mjs'
import { classifySound, describeSound, CATEGORY_NAMES } from './classify.mjs'
import { analyzeMusic } from './music.mjs'
// 转出去，方便调用方只认 pipeline 这一个入口
export { analyzeMusic }
import { getGpuQueue, PRIORITY } from '../perception/gpu-queue.mjs'
import { getForegroundWindow, isVideoWindow } from '../capture/window.mjs'
import { resolvePython } from './python.mjs'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
// Python 脚本统一强制 UTF-8 输出（否则 Windows 下中文标签会变乱码）
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
const runPy = (args, opts = {}) => run(PYTHON, args, { ...opts, env: PY_ENV })
const __dirname = dirname(fileURLToPath(import.meta.url))
// Python 解释器：动态解析（见 python.mjs），不写死路径
const PYTHON = resolvePython()
const RECORD_PY = join(__dirname, 'record.py')
const E2V_PY = join(`${globalThis.__HCEM_HOME__}`, 'models', 'emotion2vec+base', 'e2v_test.py')
const E2V_MODEL_DIR = join(`${globalThis.__HCEM_HOME__}`, 'models', 'emotion2vec+base')
const PANNS_PY = join(__dirname, 'panns.py')
const VIBENET_PY = join(__dirname, 'vibenet.py')
const FPCALC = join(`${globalThis.__HCEM_HOME__}`, 'models', 'chromaprint', 'fpcalc.exe')
/**
 * 音乐分析（BPM/调性/和弦）的触发阈值。
 *
 * 0.35 ≈「音乐分量明显存在」，比 PRESENCE_THRESHOLD(0.15) 高一档：
 * 影视里的对白+弱配乐不该每次都触发，纯音乐/演出/音乐视频才该触发。
 */
const MUSIC_ANALYSIS_MIN_SCORE = 0.1

/**
 * 音乐深分析的录音长度。
 *
 * 5 秒不够：实测同一首歌 5 秒算出 220 BPM / A# 大调，30 秒算出 120 BPM / C 大调。
 * 速度要跨若干个拍周期才稳，调性要攒够色度帧。
 */
const MUSIC_WINDOW_SECONDS = Math.max(10, Math.min(60, Number(process.env.HCEM_MUSIC_WINDOW_SEC) || 20))

/** 最近一次音乐深分析的结果（后台任务写，别的地方读） */
let lastMusic = { ts: 0, info: null, file: null }

/** 取最近一次音乐分析，超过 maxAgeMs 视为过期 */
export function getLastMusicInfo(maxAgeMs = 180000) {
  if (!lastMusic.info || Date.now() - lastMusic.ts > maxAgeMs) return null
  return lastMusic.info
}

/** 音乐情感：VibeNet 的 valence/energy 翻成人话，措辞和 describeSound 保持一致 */
function musicEmotionText(e) {
  const v = Number(e?.valence ?? 0)
  const en = Number(e?.energy ?? 0)
  const feel = v >= 0.6 ? '偏明快' : v <= 0.4 ? '偏忧郁' : '中性'
  const power = en >= 0.6 ? '节奏强' : en <= 0.4 ? '安静' : '中等'
  return `${feel}、${power}`
}

/**
 * 音乐分析 + 音乐情感。
 *
 * 结构（BPM/调性/和弦）走 DSP，情绪走 VibeNet —— 两者并行跑。
 * VibeNet 要加载 Python 模型，慢十几秒；用户明确说了慢点不怕，
 * 这里就不做缓存优化，每次分析都给最新的情绪。
 *
 * @param {string} file 音频/视频文件
 * @param {object} [opts]
 * @param {number|null} [opts.maxSeconds] 只分析前多少秒；null=整个文件（analyzeMusic 内部封顶 180 秒）
 * @returns {Promise<object>} analyzeMusic 的结果，外加 emotion / emotionError
 */
export async function analyzeMusicDeep(file, { maxSeconds = null } = {}) {
  const [info, vibe] = await Promise.all([
    analyzeMusic(file, maxSeconds ? { maxSeconds } : {}),
    vibenetOf(file).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
  ])
  if (!info || !info.ok) return info
  // VibeNet 是音乐情感模型，用在人声上没有意义：判成人声就不挂情绪
  if (info.kind === 'speech') return info
  if (vibe && vibe.ok) {
    info.emotion = {
      valence: Number(vibe.valence ?? 0),
      energy: Number(vibe.energy ?? 0),
      acousticness: Number(vibe.acousticness ?? 0),
      instrumentalness: Number(vibe.instrumentalness ?? 0),
    }
    const base = String(info.text || '').replace(/。$/, '')
    info.text = `${base}，听感${musicEmotionText(info.emotion)}。`
  } else {
    info.emotionError = (vibe && vibe.error) || 'music emotion failed'
  }
  return info
}

/**
 * 录一段长音频并直接做音乐分析，同步返回。
 *
 * 给 hcem_listen(mode=music) 用：用户明确要「听这段音乐」，不需要再跑
 * ASR/情绪/PANNs 那一整套（那套要 60 秒），只录音 + 算 BPM/调性/和弦 + 音乐情感。
 */
export async function recordAndAnalyzeMusic({ dataDir, seconds = MUSIC_WINDOW_SECONDS } = {}) {
  const dir = join(dataDir, 'audio')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `music-${Date.now()}.wav`)
  const sec = Math.max(10, Math.min(60, Number(seconds) || MUSIC_WINDOW_SECONDS))
  let capturePid = null
  try {
    const win = getForegroundWindow()
    if (win && win.ok && win.pid && isVideoWindow(win)) capturePid = win.pid
  } catch {}
  if (capturePid) {
    const pr = await captureProcessAudio(capturePid, out, sec)
    if (!pr.ok) await captureAudio(out, sec)
  } else {
    await captureAudio(out, sec)
  }
  const info = await analyzeMusicDeep(out, { maxSeconds: sec })
  if (info.ok) lastMusic = { ts: Date.now(), info, file: out }
  return { ...info, seconds: sec, wav: out }
}

/** 深分析是否在跑，避免每次 tick 都重开一个 20 秒录音 */
let musicDeepRunning = false

/**
 * 音乐深分析：录一段长音频再算 BPM/调性/和弦。
 *
 * 为什么单独录：tick 里那段只有 5 秒，速度会算成两倍（实测 220 BPM）、
 * 调性会漂（A# 大调 vs 20 秒时的 C 大调）。速度要跨几个拍周期，调性要攒够色度帧。
 *
 * 为什么后台跑：20 秒录音串进 tick 会把 60 秒变成 80 秒。
 * 结果写进 lastMusic，下次 tick 或工具调用直接读。
 */
export function startMusicDeepAnalysis({ capturePid = null, dataDir, seconds = MUSIC_WINDOW_SECONDS, logger = null } = {}) {
  if (musicDeepRunning) return false
  if (!dataDir) return false
  musicDeepRunning = true
  const dir = join(dataDir, 'audio')
  const out = join(dir, `music-${Date.now()}.wav`)
  const started = Date.now()
  ;(async () => {
    try {
      mkdirSync(dir, { recursive: true })
      // 有 pid 就只听那个进程（视频里的配乐是干净的），否则系统回环
      if (capturePid) {
        const pr = await captureProcessAudio(capturePid, out, seconds)
        if (!pr.ok) await captureAudio(out, seconds)
      } else {
        await captureAudio(out, seconds)
      }
      const info = await analyzeMusicDeep(out, { maxSeconds: seconds })
      lastMusic = { ts: Date.now(), info, file: out }
      logger?.info?.(`[hcem] 音乐深分析 ${seconds}s 用时 ${Date.now() - started}ms：${info.ok ? info.text : info.error}`)
    } catch (error) {
      const info = { ok: false, error: String((error && error.message) || error) }
      lastMusic = { ts: Date.now(), info, file: out }
      logger?.warn?.('[hcem] 音乐深分析失败: ' + info.error)
    } finally {
      musicDeepRunning = false
    }
  })()
  return true
}

/** 录制系统音频（WASAPI loopback） */
export async function captureAudio(outPath, seconds = 5) {
  await runPy([RECORD_PY, outPath, String(seconds)], { timeout: (seconds + 10) * 1000, maxBuffer: 4 * 1024 * 1024 })
  return outPath
}

// ASR 搬到 asr.mjs（CrispASR + Qwen3-ASR-0.6B）。
// 必须先 import 再 export：`export { x } from '...'` 只做转发，
// 不会在本模块产生局部绑定，而下面 audioTick 里还要直接调用它。
import { transcribe } from './asr.mjs'
export { transcribe }

/** VibeNet 音乐情感（valence/energy） */
export async function vibenetOf(wavPath) {
  if (!existsSync(VIBENET_PY)) return { ok: false, error: 'vibenet.py missing' }
  try {
    const { stdout } = await runPy([VIBENET_PY, wavPath], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    const data = JSON.parse(String(stdout).trim().split('\n').pop())
    return data.ok
      ? { ok: true, valence: data.valence, energy: data.energy, acousticness: data.acousticness, instrumentalness: data.instrumentalness }
      : { ok: false, error: data.error }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** PANNs 场景音分类（voice/music/scene） */
export async function pannsOf(wavPath) {
  if (!existsSync(PANNS_PY)) return { ok: false, error: 'panns.py missing' }
  try {
    const { stdout } = await runPy([PANNS_PY, wavPath], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
    const data = JSON.parse(String(stdout).trim())
    return data.ok ? { ok: true, kind: data.kind, tags: data.tags } : { ok: false, error: data.error }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** Chromaprint 音乐指纹 */
export async function chromaprintOf(wavPath) {
  if (!existsSync(FPCALC)) return { ok: false, error: 'fpcalc missing' }
  try {
    const { stdout } = await run(FPCALC, ['-raw', wavPath], { timeout: 30000, maxBuffer: 1024 * 1024 })
    const m = String(stdout).match(/FINGERPRINT=([0-9,]+)/)
    const d = String(stdout).match(/DURATION=([0-9.]+)/)
    return { ok: true, fp: m ? m[1] : '', duration: d ? parseFloat(d[1]) : 0 }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** emotion2vec 语音情绪 */
export async function emotionOf(wavPath) {
  if (!existsSync(E2V_PY)) return { ok: false, error: 'emotion2vec script missing' }
  try {
    const { stdout } = await runPy([E2V_PY, wavPath], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
    const raw = String(stdout).trim()
    // 优先解析 e2v_test.py 的 JSON 输出（避免 Windows 控制台编码把中文标签弄坏）
    try {
      const line = raw.split('\n').reverse().find((x) => x.trim().startsWith('{'))
      const data = JSON.parse(line || '{}')
      if (data.ok && Array.isArray(data.labels) && data.labels.length > 0) {
        return { ok: true, label: String(data.labels[0]), score: Number(data.scores?.[0] || 0) }
      }
    } catch {}
    const lines = raw.split('\n')
    let label = ''
    let score = 0
    for (const line of lines) {
      const m = line.match(/^\s*([^:]+):\s*([0-9.]+)$/)
      if (m) {
        label = m[1].trim()
        score = parseFloat(m[2])
        break // 第一行 = top1
      }
    }
    return { ok: true, label, score }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 一次音频 tick：录制 → ASR → 情绪 → 返回结果
 * @param {object} opts { dataDir, seconds }
 */
export async function audioTick(opts = {}) {
  const dataDir = opts.dataDir
  const seconds = opts.seconds ?? 5
  const startedAt = Date.now()
  const dir = join(dataDir, 'audio')
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, `seg-${Date.now()}.wav`)
  // 采集方式：前台是视频窗口 → 按进程回环（只听那个进程）；否则系统回环
  let captureMode = 'system'
  let capturePid = null
  try {
    const win = getForegroundWindow()
    if (win && win.ok && win.pid && isVideoWindow(win)) {
      const pr = await captureProcessAudio(win.pid, wav, seconds)
      if (pr.ok) {
        captureMode = 'process:' + win.process
        capturePid = win.pid
      } else {
        // 进程回环失败就退回系统回环
        await captureAudio(wav, seconds)
      }
    } else {
      await captureAudio(wav, seconds)
    }
  } catch (error) {
    return { ok: false, error: 'record failed: ' + String((error && error.message) || error) }
  }
  // ── ① 先判「这是什么声音」──
  // PANNs 给 527 类 AudioSet 标签，翻译成中文类别（人声/音乐/警报/键鼠/碰撞/自然/动物/人群/噪声…）
  const panns = await pannsOf(wav)
  const cls = classifySound(panns.ok ? panns.tags : [])

  // ── ② 听觉模型协同工作（不是二选一）──
  //   看视频时对白和配乐同时存在，所以人声分量和音乐分量各自判断、各自跑
  //   人声分量 → 转写 + 情绪 +（声纹）
  //   音乐分量 → 音乐情感 + 指纹
  //   两个都没有 → 不跑重模型，只出一句「这是什么声音」
  let asr = { ok: false, text: '' }
  let emo = { ok: false }
  let vibe = { ok: false }
  let fp = { ok: false, fp: '' }
  // 音乐深分析是后台任务，这里只取最近一次的结果（可能是上一轮的）
  let musicInfo = getLastMusicInfo()

  const tasks = []
  // 音乐也要转写：歌词/人声常被判成“music”，但词必须拿到。
  // ASR 与 VibeNet 并行，两个都出。
  if (cls.hasVoice || cls.hasMusic) {
    tasks.push(getGpuQueue().run(() => transcribe(wav), { priority: PRIORITY.asr, label: 'asr' }).then((r) => (asr = r)))
  }
  if (cls.hasVoice) {
    tasks.push(getGpuQueue().run(() => emotionOf(wav), { priority: PRIORITY.emotion, label: 'emotion' }).then((r) => (emo = r)))
  }
  if (cls.hasMusic) {
    tasks.push(getGpuQueue().run(() => vibenetOf(wav), { priority: PRIORITY.music, label: 'vibenet' }).then((r) => (vibe = r)))
    tasks.push(chromaprintOf(wav).then((r) => (fp = r)))
    // 音乐深分析：录音要 20 秒，绝不能串在 tick 里（tick 本身已经 60 秒级）。
    // 起后台任务，结果进 lastMusic，下次 tick / 工具调用直接读。
    if (Number(cls.musicScore || 0) >= MUSIC_ANALYSIS_MIN_SCORE) {
      startMusicDeepAnalysis({ capturePid, dataDir, logger: opts.logger })
    }
  }
  // 人声里也可能是唱歌 → 顺手补一个指纹（只在没跑音乐链路时）
  if (cls.hasVoice && !cls.hasMusic) {
    tasks.push(chromaprintOf(wav).then((r) => (fp = r)))
  }
  if (tasks.length > 0) await Promise.all(tasks)

  const soundDesc = describeSound(cls, {
    text: asr.ok ? asr.text : '',
    emotion: emo.ok ? emo.label : '',
    music: vibe.ok ? { valence: vibe.valence, energy: vibe.energy } : null,
    fp: fp.ok ? fp.fp : '',
  })

  return {
    ok: true,
    wav,
    timeStart: startedAt,
    timeEnd: Date.now(),
    durationSec: seconds,
    captureMode,
    // 声音类别（新）
    category: cls.category,
    categoryName: CATEGORY_NAMES[cls.category] || cls.category,
    soundDesc,
    heavy: cls.heavy,
    confidence: cls.confidence,
    topLabel: cls.topLabel,
    // 转写（只有人声才有）
    text: asr.ok ? asr.text : '',
    asrSegments: asr.ok && Array.isArray(asr.segments) ? asr.segments : [],
    asrError: asr.ok ? undefined : asr.error,
    // 兼容旧字段：kind 仍是 voice/music/scene
    kind: cls.hasVoice ? 'voice' : cls.hasMusic ? 'music' : 'scene',
    components: cls.components,
    tags: panns.ok ? panns.tags : [],
    pannsError: panns.ok ? undefined : panns.error,
    // 语音情绪（emotion2vec）
    emotion: emo.ok ? emo.label : '',
    emotionScore: emo.ok ? emo.score : 0,
    emotionError: emo.ok ? undefined : emo.error,
    // 音乐情感（VibeNet）
    music: vibe.ok ? { valence: vibe.valence, energy: vibe.energy, acousticness: vibe.acousticness, instrumentalness: vibe.instrumentalness } : null,
    musicError: vibe.ok ? undefined : vibe.error,
    fp: fp.ok ? fp.fp : '',
    fpError: fp.ok ? undefined : fp.error,
    // 音乐分析（BPM/调性/和弦/段落）：只在音乐分量够重时才有
    musicInfo: musicInfo && musicInfo.ok ? musicInfo : null,
    musicInfoError: musicInfo && !musicInfo.ok ? musicInfo.error : undefined,
  }
}

/**
 * 按进程录音（Application Loopback）：只抓某个进程的声音
 * @param {number} pid 目标进程 ID
 * @param {string} outWav 输出 wav
 * @param {number} seconds 录多久
 */
export async function captureProcessAudio(pid, outWav, seconds = 5) {
  const script = join(__dirname, '..', 'capture', 'process-capture.ps1')
  if (!existsSync(script)) return { ok: false, error: 'process-capture.ps1 不存在' }
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid), outWav, String(seconds)],
      { timeout: (Number(seconds) + 20) * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: PY_ENV },
    )
    const line = String(stdout).trim().split(/\r?\n/).pop()
    const r = JSON.parse(line)
    return r && r.ok ? { ok: true, wav: outWav, samples: r.samples, seconds: r.seconds } : { ok: false, error: r?.error || 'process capture failed' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 从视频文件直接抽音轨（最干净的一档：不碰声卡、不混入其它声音）
 * @param {string} videoPath
 * @param {string} outWav
 * @returns {Promise<string>} 输出 wav 路径
 */
export async function extractAudioFromVideo(videoPath, outWav) {
  const ff = join(`${globalThis.__HCEM_HOME__}`, 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe')
  if (!existsSync(ff)) throw new Error('ffmpeg 不存在')
  mkdirSync(dirname(outWav), { recursive: true })
  // 统一转 16kHz 单声道（识别模型的要求）
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', outWav], {
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return outWav
}
