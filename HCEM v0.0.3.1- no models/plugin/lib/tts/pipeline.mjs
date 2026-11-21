// TTS 管线：CosyVoice3（CrispASR）→ 情绪参考 + 语速挂 L（ffmpeg atempo）
// 依赖：crispasr.exe（models/CrispASR-*）、emotion-refs（models/Fun-CosyVoice3-0.5B-2512/emotion-refs）
import { execFile, spawn } from 'node:child_process'
import '../home.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS = process.env.HCEM_MODELS_DIR || globalThis.__HCEM_MODELS__
const CRISP = join(MODELS, 'CrispASR-v0.8.53-win-x64-cuda', 'crispasr.exe')
const COSY_DIR = join(MODELS, 'Fun-CosyVoice3-0.5B-2512')
const LLM = join(COSY_DIR, 'cosyvoice3-llm-rl-q4_k.gguf')
const REFS = join(COSY_DIR, 'emotion-refs')
const FFMPEG = join(MODELS, '..', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe')
const FFPLAY = join(MODELS, '..', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffplay.exe')
const DATA_DIR = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__

/**
 * 当前音量（0~100）。菜单设置页把音量写进 data/ui-state/volume.json，
 * 但以前播放走 Media.SoundPlayer，根本不读这个值——所以滑杆怎么拖都没反应。
 */
export function volumeNow() {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, 'ui', 'volume.json'), 'utf8'))
    const v = Math.round(Number(j?.volume))
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, v))
  } catch {}
  return 60
}


// ── 语速：L + S 两路一起驱动，档位离散、先平后陡 ──────────────
//
// 设计要求（用户原话）：
//   · L 和 S 都要做参数
//   · 不要平滑变化（连续 atempo 听不出差别，还随 L 漂移）
//   · 递增先平后陡：情绪平稳时语速稳定，情绪激动才陡增
//
// 做法：
//   1) 把两路合成一个「唤醒度」 A = 0.6·S + 0.4·L
//      S（饱和度）= 情绪强度，是「激动」的主因（权重 0.6）；L（明度）= 精神/生动度（权重 0.4）
//   2) A 落到 6 个离散档位，相邻档位的差值递增（+0.05 / +0.05 / +0.09 / +0.15 / +0.22）
//
// 典型状态：S≈15、L≈55 → A≈31 → 0.93 倍（略慢于自然，安静陪伴感）
// 情绪上来：S≈70、L≈70 → A≈70 → 1.10
// 非常激动：S≈95、L≈85 → A≈91 → 1.50
export const SPEED_TIERS = [
  { max: 20, speed: 0.88, name: '迟缓' },
  { max: 35, speed: 0.92, name: '自然偏慢' },
  { max: 50, speed: 0.97, name: '自然' },
  { max: 65, speed: 1.05, name: '略快' },
  { max: 80, speed: 1.18, name: '快' },
  { max: 101, speed: 1.40, name: '很急' },
]

/** 唤醒度：0~100。S 权重高（它是「激动」），L 次之（「精神」） */
export function arousalOf(L = 55, S = 15) {
  const l = Math.max(0, Math.min(100, Number(L ?? 55)))
  const s = Math.max(0, Math.min(100, Number(S ?? 15)))
  return Math.round((0.6 * s + 0.4 * l) * 10) / 10
}

/**
 * 按 L 和 S 取语速档。
 * @returns {{speed:number, name:string, arousal:number}}
 */
export function speedFor(L = 55, S = 15) {
  const a = arousalOf(L, S)
  for (const t of SPEED_TIERS) {
    if (a < t.max) return { speed: t.speed, name: t.name, arousal: a }
  }
  const last = SPEED_TIERS[SPEED_TIERS.length - 1]
  return { speed: last.speed, name: last.name, arousal: a }
}

/** 兼容旧调用（只给 L，S 取中性 15） */
export function speedForL(L) {
  return speedFor(L, 15)
}

/** 情绪 → 参考音频（emotion-refs 里的 wav） */
export function refForEmotion(emotion) {
  const map = {
    快乐: 'happy',
    开心: 'happy',
    悲伤: 'sad',
    愤怒: 'angry',
    恐惧: 'fearful',
    惊讶: 'surprise',
    厌恶: 'angry', // 无厌恶参考 → 用 angry 近似
    neutral: 'neutral',
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    fearful: 'fearful',
    surprise: 'surprise',
    playfulness: 'playfulness',
  }
  const name = map[String(emotion || 'neutral')] || 'neutral'
  const p = join(REFS, name + '.wav')
  return existsSync(p) ? p : join(REFS, 'neutral.wav')
}

/**
 * 合成语音
 * @param {object} opts { text, emotion, L, outPath, refText? }
 * @returns {Promise<{ok:boolean, path?:string, speed?:number, ref?:string, error?:string}>}
 */
/** 读取参考文本（emotion-refs/refs.json） */
export function refTextForEmotion(emotion) {
  const name = String(emotion || 'neutral')
  try {
    const p = join(REFS, 'refs.json')
    if (!existsSync(p)) return ''
    const refs = JSON.parse(readFileSync(p, 'utf8'))
    return refs[name] ?? refs['neutral'] ?? ''
  } catch {
    return ''
  }
}

export async function synthesize({ text, emotion = 'neutral', L = 55, S = 15, outPath, refText = '' }) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'empty text' }
  mkdirSync(dirname(outPath), { recursive: true })
  const rate = speedFor(L, S)
  const speed = rate.speed
  const rawPath = outPath.replace(/\.wav$/i, '') + '.raw.wav'
  const args = ['--backend', 'cosyvoice3-tts', '-m', LLM, '--tts', t, '--tts-output', rawPath, '--speaker-identity', 'synthetic', '--no-spoken-disclaimer', '--accept-marking-responsibility']

  // 选音色（优先级：用户克隆音色 > 英文用内置 fleurs-en > 情绪参考音）
  //
  // 为什么英文要单独走：中文参考音去合成英文会出胡话（CosyVoice 的跨语种克隆
  // 对参考音语言很敏感）。CosyVoice 自带 fleurs-en 等母语音色，直接用它最稳。
  const pick = pickVoice(t, emotion, refText)
  if (pick.kind === 'clone' || pick.kind === 'emotion') {
    args.push('--voice', pick.wav)
    if (pick.refText) args.push('--ref-text', pick.refText)
    args.push('--i-have-rights')
  } else if (pick.kind === 'preset') {
    // 内置音色（fleurs-en 等）在 CLI 里也算"克隆库"音色，同样要 --i-have-rights
    args.push('--voice', pick.name, '--i-have-rights')
  }
  const ref = pick.wav || pick.name || null
  try {
    await run(CRISP, args, { timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  if (!existsSync(rawPath)) return { ok: false, error: 'tts output missing' }
  // 语速后处理（L 档位）
  try {
    await run(FFMPEG, ['-y', '-i', rawPath, '-filter:a', `atempo=${speed}`, outPath], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    return { ok: false, error: 'atempo failed: ' + String((error && error.message) || error) }
  }
  try { (await import('node:fs')).rmSync(rawPath) } catch {}
  return { ok: true, path: outPath, speed, rate: rate.name, arousal: rate.arousal, ref }
}

/** 读取用户配置的音色（data/ui-state/voice.json）：{ mode:'preset'|'clone', wav, refText } */
export function voiceConfig() {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, 'ui', 'voice.json'), 'utf8'))
    if (j && typeof j === 'object') return j
  } catch {}
  return { mode: 'preset' }
}

/** 这段文本是不是以英文为主（≥60% 的字母是 ASCII） */
export function isLatinText(text) {
  const s = String(text || '')
  const letters = s.match(/[A-Za-z\u4e00-\u9fff]/g) || []
  if (letters.length === 0) return false
  const ascii = letters.filter((c) => /[A-Za-z]/.test(c)).length
  return ascii / letters.length >= 0.6
}

/**
 * 选音色。
 * @returns {{kind:'clone'|'preset'|'emotion', wav?:string, name?:string, refText?:string}}
 */
export function pickVoice(text, emotion = 'neutral', refText = '') {
  const cfg = voiceConfig()
  // ① 用户克隆音色：任何语言都用它（跨语种克隆是 CosyVoice3 的强项）
  if (cfg.mode === 'clone' && cfg.wav && existsSync(cfg.wav)) {
    return { kind: 'clone', wav: cfg.wav, refText: String(cfg.refText || '') }
  }
  // ② 英文为主：用内置母语音色，避免中文参考音念英文变胡话
  if (isLatinText(text)) {
    return { kind: 'preset', name: 'fleurs-en' }
  }
  // ③ 默认：情绪参考音
  const ref = refForEmotion(emotion)
  if (!existsSync(ref)) return { kind: 'preset', name: 'zero_shot' }
  return { kind: 'emotion', wav: ref, refText: refText || refTextForEmotion(emotion) }
}

/**
 * 整段播报（一次合成 + ffplay 播放）。
 *
 * 为什么不用 `--tts-stream`：实测这个 build 的流式输出是噪声
 * （峰值恒 1、幅度直方图均匀分布、ASR 只能识别出「啊啊啊」），
 * 换成能正常出声的 `--tts-output` wav 路线。
 *
 * 为什么整段一次合成：老实现按句合成、每句新起一次 crispasr，
 * 模型每句都重新加载，句间空白很长。整段一次合成只有一次加载。
 *
 * 音量：ffplay 的 -volume，读设置页写下的 ui/volume.json
 * （原来的 Media.SoundPlayer 根本没有音量参数）。
 *
 * @param {object} o { text, emotion, L, refText, volume, dataDir }
 * @returns {Promise<{ok:boolean, muted?:boolean, error?:string}>}
 */
export async function speakWhole({ text, emotion = 'neutral', L = 55, S = 15, refText = '', volume = null, dataDir = null } = {}) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'empty text' }
  const vol = volume === null ? volumeNow() : Math.max(0, Math.min(100, Math.round(Number(volume))))
  if (vol <= 0) return { ok: true, muted: true }
  if (!existsSync(FFPLAY)) return { ok: false, error: 'ffplay missing' }

  const dir = join(dataDir || DATA_DIR, 'tts')
  mkdirSync(dir, { recursive: true })
  // WAV 里最长留 6 分钟，足够一整轮回复
  const outPath = join(dir, `say-${Date.now()}.wav`)
  const r = await synthesize({ text: t, emotion, L, S, outPath, refText })
  if (!r.ok) return { ok: false, error: String(r.error || 'synth failed') }

  try {
    await run(FFPLAY, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(vol), outPath], {
      timeout: 600000,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, path: outPath }
  } catch (error) {
    return { ok: false, error: 'play failed: ' + String((error && error.message) || error) }
  }
}