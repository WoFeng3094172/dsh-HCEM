// TTS 桥：对话回复 → 语音（OmniDimen 文本 → CosyVoice3 → 播放）
// 情绪：HSL → 音色；语速：L+S → atempo
import { synthesize, speedFor, refForEmotion, speakWhole, volumeNow, voiceConfig, isLatinText } from './pipeline.mjs'
import '../home.mjs'
import { ensureServer, requestSpeech } from './server.mjs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const FFPLAY = `${globalThis.__HCEM_HOME__}/tools/ffmpeg-9.0.2-essentials_build/bin/ffplay.exe`
const FFMPEG = `${globalThis.__HCEM_HOME__}/tools/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe`
const DATA_FALLBACK = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__

import { log } from '../log.mjs'

/** 统一日志（写文件，便于排查） */
function tlog(level, msg) {
  try {
    log(level, 'tts', String(msg))
  } catch {}
}

/** 用 ffplay 播放（能控制音量；Media.SoundPlayer 不能） */
async function playWithVolume(path, volume = null) {
  const vol = volume === null ? volumeNow() : volume
  if (vol <= 0) return { ok: true, muted: true }
  await run(FFPLAY, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(vol), path], {
    timeout: 300000,
    maxBuffer: 1024 * 1024,
  })
  return { ok: true }
}

/** HSL → 情绪名（用于选参考音频） */
export function emotionFromHSL(H, S, L) {
  const h = ((Number(H ?? 360) % 360) + 360) % 360
  const s = Number(S ?? 15)
  const bands = [
    [30, '快乐'],
    [90, '惊讶'],
    [150, '恐惧'],
    [210, '悲伤'],
    [270, '厌恶'],
    [330, '愤怒'],
    [360, '快乐'],
  ]
  if (s < 25) return 'neutral' // 低饱和 → 中性
  for (const [max, name] of bands) {
    if (h < max) return name
  }
  return 'neutral'
}

/**
 * 回复 → 语音
 * @param {object} opts { text, H, S, L, outPath, play }
 * @returns {Promise<{ok:boolean, path?:string, speed?:number, emotion?:string, error?:string}>}
 */
export async function speakReply({ text, H = 360, S = 15, L = 55, outPath, play = false }) {
  const emotion = emotionFromHSL(H, S, L)
  const r = await synthesize({ text, emotion, L, S, outPath })
  if (!r.ok) return r
  if (play) {
    try {
      await playWithVolume(outPath)
    } catch (error) {
      return { ...r, played: false, playError: String((error && error.message) || error) }
    }
  }
  return { ...r, emotion, played: play }
}

/** 播放 wav（辅助） */
export async function playWav(path) {
  try {
    await playWithVolume(path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 按句切分（中英文标点都切），过滤纯标点/空白。
 * 目标：每句 10–80 字，太长再按逗号切，太短并到下一句。
 */
export function splitSentences(text, { maxChars = 80, minChars = 6 } = {}) {
  const src = String(text || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!src) return []
  const raw = src.split(/(?<=[。！？!?；;…\n])|(?<=[.]\s)/).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const piece of raw) {
    if (piece.length <= maxChars) {
      out.push(piece)
      continue
    }
    // 太长：按逗号再切
    const parts = piece.split(/(?<=[，,、：:])/).map((s) => s.trim()).filter(Boolean)
    let buf = ''
    for (const p of parts) {
      if (buf && buf.length + p.length > maxChars) {
        out.push(buf)
        buf = p
      } else {
        buf += p
      }
    }
    if (buf) out.push(buf)
  }
  // 太短的并到前一句，避免一字一句地合成
  const merged = []
  for (const s of out) {
    const clean = s.replace(/^[\s，,、：:。.!！？?；;…]+|[\s，,、：:。.!！？?；;…]+$/g, '')
    if (!clean) continue
    if (merged.length && clean.length < minChars) {
      merged[merged.length - 1] += s
    } else {
      merged.push(s)
    }
  }
  return merged
}

/**
 * 流式播报：按句合成，第一句出来就播，后面并发预合成。
 *
 * 解决的是「整轮结束才开始合成一整段」导致的严重滞后：
 *   旧：turn/end → 合成 500 字（10~20s）→ 播放
 *   新：turn/end → 切 8 句 → 第 1 句合成（2~3s）就播 → 其余并发 → 顺序播放
 *
 * @param {object} opts { text, H, S, L, dataDir, play, concurrency }
 * @returns {Promise<{ok:boolean, sentences:number, played:number, errors:string[]}>}
 */
export async function speakStream({ text, H = 360, S = 15, L = 55, dataDir, play = true }) {
  const emotion = emotionFromHSL(H, S, L)
  const outDir = dataDir ? join(String(dataDir), 'tts') : join(DATA_FALLBACK, 'tts')
  try {
    mkdirSync(outDir, { recursive: true })
  } catch {}

  // 首选：常驻 TTS 服务，分句合成、边合成边播。
  // 冷启动（首次用某音色）要 ~10s，热态 ~0.7~0.95s/句，首句就能马上开口。
  if (play) {
    try {
      const ready = await ensureServer({ log: { info: (m) => tlog('INFO', m) } })
      if (ready) {
        const r = await speakViaServer({ text, emotion, L, S, outDir })
        if (r.ok) return r
        tlog('WARN', '常驻服务播放失败，退回整段合成: ' + (r.errors || []).join(';').slice(0, 160))
      }
    } catch (e) {
      tlog('WARN', '常驻服务不可用: ' + String((e && e.message) || e).slice(0, 160))
    }
  }

  // 兜底：整段一次合成（一次模型加载，无句间空白，但首句要等全段）
  if (play) {
    try {
      const r = await speakWhole({ text, emotion, L, S, dataDir })
      if (r.ok) return { ok: true, sentences: 0, played: 1, errors: [], via: r.muted ? 'muted' : 'whole' }
    } catch {}
  }

  // 最后兜底：旧的按句 CLI 合成（极慢，仅在服务与整段都失败时用）
  return speakSentencesCli({ text, emotion, L, S, dataDir, play })
}

/** 常驻服务模式：分句 + 预取 + 顺序播放 */
async function speakViaServer({ text, emotion, L, S, outDir }) {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return { ok: false, sentences: 0, played: 0, errors: ['empty'] }
  const voice = serverVoiceFor(emotion, text)
  const rate = speedFor(L, S)
  const volume = volumeNow()
  const errors = []
  let played = 0

  const synth = async (i) => {
    try {
      const buf = await requestSpeech({ input: sentences[i], ...(voice ? { voice } : {}) })
      const raw = join(outDir, `srv-${Date.now()}-${i}.wav`)
      writeFileSync(raw, buf)
      // 语速在播放时用 ffplay -af atempo 处理，这里不转码
      return { path: raw }
    } catch (e) {
      errors.push(String((e && e.message) || e).slice(0, 120))
      return { error: String((e && e.message) || e).slice(0, 120) }
    }
  }

  // 预取下一句，边播边合成
  let pending = synth(0)
  for (let i = 0; i < sentences.length; i += 1) {
    const got = await pending
    const next = i + 1 < sentences.length ? synth(i + 1) : null
    if (got && got.path) {
      try {
        await playWavAt(got.path, volume, rate.speed)
        played += 1
      } catch (e) {
        errors.push('play: ' + String((e && e.message) || e).slice(0, 100))
      }
      try {
        rmSync(got.path, { force: true })
      } catch {}
    }
    pending = next
  }
  return { ok: played > 0, sentences: sentences.length, played, errors, via: 'server', rate: rate.name, voice }
}

/** 情绪/语言 → voice-dir 里的音色名 */
function serverVoiceFor(emotion, text) {
  // 用户克隆音色优先
  // 常驻服务对 voice-dir 里的音色（全是克隆音色）会**强制**加一句英文 AI 声明，
  // 且 server 模式不认 --no-spoken-disclaimer（实测）。所以：
  //   · 普通模式：不带 voice，用内置 zero_shot 音色 → 无前缀、热态 ~0.6s/句
  //   · 克隆/情绪音色：走 CLI 整段合成（那里能用 --no-spoken-disclaimer）
  try {
    const cfg = voiceConfig()
    // 克隆音色：server 会强制加声明 → 交给 CLI（返回 null 表示"别用 server"）
    if (cfg.mode === 'clone' && cfg.wav) return null
  } catch {}
  // 返回 undefined = 用 server 但不带 voice（内置音色，无声明、最快）
  return undefined
}

/** 播放一个 wav，等它放完。speed≠1 时用 ffplay 的 -af atempo 直接变速，
 *  不再先转一份文件（省 100~300ms/句，也少一次磁盘往返）。 */function playWavAt(path, volume, speed = 1) {
  return new Promise((resolve, reject) => {
    if (volume <= 0) return resolve()
    const args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(volume)]
    if (Math.abs(speed - 1) >= 0.005) args.push('-af', 'atempo=' + speed)
    args.push(path)
    const p = spawn(FFPLAY, args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    p.on('exit', () => resolve())
    p.on('error', reject)
  })
}

/** 最后的兜底：逐句 CLI 合成（每句重新加载模型，慢） */
async function speakSentencesCli({ text, emotion, L, S, dataDir, play }) {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return { ok: false, sentences: 0, played: 0, errors: ['empty'] }
  const errors = []
  let played = 0
  for (let i = 0; i < sentences.length; i += 1) {
    const outPath = dataDir ? `${dataDir}\\tts\\stream-${Date.now()}-${i}.wav` : undefined
    const r = await synthesize({ text: sentences[i], emotion, L, S, outPath })
    if (!r.ok) {
      errors.push(`#${i}: ${r.error}`)
      continue
    }
    if (play) {
      try {
        await playWavAt(r.path || outPath, volumeNow())
        played += 1
      } catch (e) {
        errors.push(`play#${i}: ${String((e && e.message) || e)}`)
      }
    }
  }
  return { ok: played > 0, sentences: sentences.length, played, errors, via: 'cli' }
}

/**
 * 说一句（供「流式接文本」用）：模型还在生成时，一凑满一句就送进来。
 * 首句因此能比整段回完早 1~3 秒出声。
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
 */
export async function speakSentence({ text, H = 360, S = 15, L = 55 }) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'empty' }
  const rate = speedFor(L, S)
  const volume = volumeNow()
  if (volume <= 0) return { ok: true, via: 'muted' }
  const emotion = emotionFromHSL(H, S, L)
  const voice = serverVoiceFor(emotion, t)
  if (voice === null) {
    // 配了克隆音色：server 会强制加声明，只能走 CLI
    const outPath = join(DATA_FALLBACK, 'tts', 'say-' + Date.now() + '.wav')
    const r = await synthesize({ text: t, emotion, L, S, outPath })
    if (!r.ok) return { ok: false, error: String(r.error || 'synth failed') }
    await playWavAt(r.path || outPath, volume, rate.speed)
    try {
      rmSync(r.path || outPath, { force: true })
    } catch {}
    return { ok: true, via: 'cli' }
  }
  try {
    const ready = await ensureServer({ log: { info: (m) => tlog('INFO', m) } })
    if (!ready) return { ok: false, error: 'server not ready' }
    const buf = await requestSpeech({ input: t })
    const p = join(DATA_FALLBACK, 'tts', 'say-' + Date.now() + '.wav')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, buf)
    await playWavAt(p, volume, rate.speed)
    try {
      rmSync(p, { force: true })
    } catch {}
    return { ok: true, via: 'server' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}