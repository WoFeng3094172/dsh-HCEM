/**
 * 音乐分析：一个音频文件进来，节奏 / 调性 / 结构 / 内容类型出去。
 *
 * DSP 来自 dsh-better-ears（Apache-2.0），四个模块原样搬在 ./dsp/ 下：
 *   core.js（FFT/STFT/高通/谐波分离）、rhy.js（速度/拍/强拍）、
 *   tonal.js（色度/调性/和弦/旋律）、structure.js（段落/自相似/新颖度）。
 *
 * 这里只做 HCEM 需要的那一层：解码、编排、说人话。
 *
 * 为什么不用 panns 代替：
 *   panns 回答「这是什么声音」（527 类分类），这里回答「这段音乐长什么样」
 *   （120 BPM、C 大调、副歌在哪）。两者互补，不是替代。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { DEFAULT_FFMPEG } from '../perception/storyboard/probe.js'
import { harmonicMags, highpass, stft } from './dsp/core.js'
import { estimateDownbeat, estimateDownbeatChroma, estimateTempo, onsetEnvelope, onsetTimes, rhythmSummary, trackBeats } from './dsp/rhy.js'
import { chromagram, detectChords, estimateKey, melodyTrack } from './dsp/tonal.js'
import { beatSyncChroma, detectSections, labelSections, meanVector, noveltyCurve, sectionChain, selfSimilarity } from './dsp/structure.js'

const run = promisify(execFile)

export const ANALYSIS_SR = 22050
/** 音高折叠从 150 Hz 起：不砍掉踢鼓，色度图会变成一张踢鼓地图 */
const TONAL = { highpassHz: 150, nfft: 8192, hop: 2048, fmin: 150, fmax: 4000 }
/** 节奏用短窗：1024 点 22050 Hz ≈ 46 ms，够抓 onsets */
const RHYTHM = { nfft: 1024, hop: 256 }

const MAX_SECONDS = 180

/**
 * 解码成单声道 f32（-1..1），走 ffmpeg。
 * HCEM 自带 ffmpeg（tools/ 下），不需要用户装。
 */
export async function decodeAudio(file, { sr = ANALYSIS_SR, maxSeconds = MAX_SECONDS, startSeconds = 0, ffmpeg = DEFAULT_FFMPEG } = {}) {
  if (!existsSync(file)) throw new Error('文件不存在：' + file)
  const bin = existsSync(ffmpeg) ? ffmpeg : 'ffmpeg'
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i', file,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sr),
    ...(maxSeconds ? ['-t', String(maxSeconds)] : []),
    '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
  ]
  let stdout
  try {
    ;({ stdout } = await run(bin, args, { timeout: 300000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }))
  } catch (error) {
    const msg = String((error && error.stderr) || (error && error.message) || error)
    if (/does not contain any stream|Stream map .* matches no streams/i.test(msg)) {
      throw new Error('这个文件没有音轨')
    }
    throw new Error('解码失败：' + msg.slice(0, 200))
  }
  if (!stdout || stdout.length < 4) throw new Error('解码出 0 个采样点（可能没有音轨或音轨是空的）')
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4))
  return { samples: Float32Array.from(samples), sr, seconds: samples.length / sr }
}

/** 节奏：速度、拍点、强拍、脉冲清晰度 */
function rhythmFrom({ samples, sr }) {
  const env = onsetEnvelope(samples, sr, { ...RHYTHM, lowBand: [30, 150] })
  const onsets = onsetTimes(env)
  const tempo = estimateTempo(env, onsets)
  const tracked = trackBeats(env, tempo)
  const downbeat = estimateDownbeat(tracked.beats, env.lowBand)
  const summary = rhythmSummary(tempo, tracked, downbeat)
  return { tempo, tracked, downbeat, onsetCount: onsets.times.length, summary }
}

/** 调性：色度、调、和弦、旋律 */
function tonalFrom({ samples, sr }, { beats = null } = {}) {
  const filtered = highpass(samples, sr, { fc: TONAL.highpassHz })
  const S = stft(filtered, sr, { nfft: TONAL.nfft, hop: TONAL.hop })
  const harmonic = harmonicMags(S.mags)
  const chroma = chromagram(harmonic, S.nfft, sr, {
    frameHop: S.hop,
    fmin: TONAL.fmin,
    fmax: TONAL.fmax,
    power: 2,
  })
  const key = estimateKey(chroma)
  const chords = detectChords(chroma, { beats, key })
  const melody = melodyTrack(samples, sr, { fmin: 80, fmax: 1200, frame: 2048, hop: 512 })
  melody.tonal = Boolean(melody.rangeName) && melody.voicedFraction >= 0.3 && melody.octaveJumpRate <= 0.2
  melody.confidence = melody.tonal
    ? Math.min(1, Math.max(0, 0.5 * melody.voicedFraction + 0.5 * (1 - Math.min(1, melody.octaveJumpRate * 4))))
    : 0
  return { stft: { nfft: S.nfft, hop: S.hop, sr, mags: S.mags }, chroma, key, chords, melody }
}

/** 结构：段落、分界、谐波强拍 */
function structureFrom(tonal, rhythm) {
  const beats = rhythm?.tracked?.beats ?? []
  const beatChroma = beatSyncChroma(tonal.chroma, beats)
  const vectors = beatChroma.map((b) => b.vector)
  const ssm = selfSimilarity(vectors)
  const { novelty } = noveltyCurve(ssm, 8)
  const beatTimes = beatChroma.length ? beatChroma.map((b) => b.start) : [0]
  const detected = detectSections(novelty, beatTimes, { sigma: 1.2, minBeats: 16 })
  const tonalDuration = tonal.stft?.mags ? tonal.stft.mags.length * (tonal.chroma?.secondsPerFrame ?? 0.1) : 0
  const lastEnd = beatChroma.length ? beatChroma[beatChroma.length - 1].end : tonalDuration
  // 没有切点也要给一整段：否则 sections 为空，lowBandShare / vocalBandShare
  // 这两个内容类型判定的证据会一起消失（静态段落就是这样丢的）。
  const times = detected.boundaries.length
    ? [...detected.boundaries.map((b) => b.time), lastEnd]
    : [0, lastEnd]
  const sections = []
  for (let i = 0; i < times.length - 1; i += 1) {
    const start = i === 0 ? 0 : times[i]
    const end = times[i + 1]
    if (end - start < 1) continue
    const step = beatTimes[1] - beatTimes[0] || 1
    const fromIdx = Math.max(0, Math.round(start / step))
    const toIdx = Math.max(fromIdx + 1, Math.round(end / step))
    sections.push({
      time: start,
      strength: i === 0 ? 1 : (detected.boundaries[i - 1]?.strength ?? 0),
      vector: meanVector(beatChroma, fromIdx, toIdx),
    })
  }
  const labeled = labelSections(sections)
  const chain = sectionChain(
    labeled,
    beatChroma.length ? beatChroma : [{ start: 0, end: tonalDuration }],
    tonal.stft.mags,
    tonal.stft.nfft,
    tonal.stft.sr,
    tonal.stft.hop,
  )
  return { sections: chain, boundaries: detected.boundaries, downbeatHarmonic: estimateDownbeatChroma(beatChroma.map((b) => b.vector)) }
}

/**
 * 音乐还是语音？
 *
 * 关键判据：调性置信度。真语音实测 0.28–0.30，真歌曲 0.88–0.96，
 * 0.7 以上直接判音乐——这是语音伪造不出来的东西。
 */
export function contentKind({ rhythm, structure, tonal } = {}) {
  const reasons = []
  let score = 0
  const sections = structure?.sections ?? []
  const low = sections.length ? sections.reduce((s, x) => s + (x.lowBandShare ?? 0), 0) / sections.length : null
  const vocal = sections.length ? sections.reduce((s, x) => s + (x.vocalBandShare ?? 0), 0) / sections.length : null
  if (low !== null) {
    if (low >= 0.35) { score += 2; reasons.push(`低频占比 ${(low * 100).toFixed(0)}%`) }
    else if (low >= 0.18) { score += 1; reasons.push(`低频占比 ${(low * 100).toFixed(0)}%`) }
  }
  const keyConfidence = tonal?.key?.confidence ?? 0
  const voiced = tonal?.melody?.voicedFraction ?? 0
  if (keyConfidence >= 0.55) {
    score += 2
    reasons.push(`调性明确（${tonal.key.key}，置信 ${(keyConfidence * 100).toFixed(0)}%）`)
  } else if (keyConfidence >= 0.35) score += 1
  if (voiced >= 0.45 && keyConfidence >= 0.35) { score += 2; reasons.push(`持续音高线占 ${(voiced * 100).toFixed(0)}%`) }
  else if (voiced >= 0.25 && keyConfidence >= 0.35) score += 1
  if (vocal !== null && vocal >= 0.5 && (low ?? 0) < 0.15 && keyConfidence < 0.35) {
    score -= 2
    reasons.push(`人声频段占 ${(vocal * 100).toFixed(0)}% 且无稳定调性`)
  }
  const clarity = rhythm?.tracked?.pulseClarity ?? 0
  if (clarity >= 15) score += 2
  else if (clarity >= 8) score += 1
  else { score -= 1; reasons.push(`脉冲不清晰（${clarity.toFixed(1)}）`) }
  const tempoScore = rhythm?.tempo?.score ?? 0
  if (tempoScore >= 0.8) score += 2
  else if (tempoScore >= 0.5) score += 1
  else { score -= 1; reasons.push(`速度不自证（${tempoScore.toFixed(2)}）`) }
  const musical = keyConfidence >= 0.7 ? true : null
  if (musical) reasons.push('调性置信度本身就是音乐的强证据')
  const kind = musical ? 'music' : score >= 4 ? 'music' : score <= -1 ? 'speech' : 'unclear'
  return { kind, score, lowShare: low, vocalShare: vocal, pulseClarity: clarity, tempoScore, keyConfidence, voicedFraction: voiced, reasons }
}

/** 不安全值（NaN/Infinity）转成 null，方便 JSON */
function safe(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 分析一个音频文件。
 *
 * @param {string} file
 * @param {object} [opts] { maxSeconds, startSeconds, withChords, withSections }
 * @returns {Promise<{ok:boolean, kind?:string, bpm?:number, key?:string, text?:string, error?:string}>}
 */
export async function analyzeMusic(file, { maxSeconds = MAX_SECONDS, startSeconds = 0, withChords = true, withSections = true } = {}) {
  try {
    const audio = await decodeAudio(file, { maxSeconds, startSeconds })
    const rhythm = rhythmFrom(audio)
    const beats = rhythm.tracked?.beats ?? null
    const tonal = tonalFrom(audio, { beats })
    const structure = withSections ? structureFrom(tonal, rhythm) : { sections: [], boundaries: [] }
    const kind = contentKind({ rhythm, structure, tonal })

    const result = {
      ok: true,
      seconds: safe(audio.seconds),
      kind: kind.kind,
      kindScore: kind.score,
      kindReasons: kind.reasons,
      bpm: safe(rhythm.tempo?.bpm),
      bpmConfidence: safe(rhythm.tempo?.score),
      pulseClarity: safe(rhythm.tracked?.pulseClarity),
      key: tonal.key?.key ?? null,
      keyConfidence: safe(tonal.key?.confidence),
      /** 语音不冒充音乐：判成 speech 时不给调性/和弦 */
      chords:
        kind.kind === 'speech' || !withChords
          ? []
          : (tonal.chords?.segments ?? []).slice(0, 24).map((c) => ({
              label: c.label ?? null,
              start: safe(c.start),
              end: safe(c.end),
              outOfKey: Boolean(c.outOfKey),
            })),
      sections:
        kind.kind === 'speech'
          ? []
          : (structure.sections ?? []).map((s) => ({
              label: s.label ?? null,
              start: safe(s.start),
              end: safe(s.end),
              lowBandShare: safe(s.lowBandShare),
              vocalBandShare: safe(s.vocalBandShare),
            })),
      melody: {
        range: tonal.melody?.rangeName ?? null,
        voicedFraction: safe(tonal.melody?.voicedFraction),
        tonal: Boolean(tonal.melody?.tonal),
      },
    }
    result.text = describeMusic(result)
    return result
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** "C major" → "C 大调"；"A minor" → "A 小调"。DSP 那边固定输出英文，这里只做显示层转换。 */
function keyZh(key) {
  const s = String(key || '').trim()
  if (!s) return null
  return s.replace(/\bmajor\b/i, '大调').replace(/\bminor\b/i, '小调').replace(/\s+/g, ' ')
}

/** 把结果说成人话，给 AI 直接读 */
export function describeMusic(r) {
  if (!r || !r.ok) return ''
  const bits = []
  if (r.kind === 'music') bits.push('这是一段音乐')
  else if (r.kind === 'speech') bits.push('这段主要是人声，不像音乐')
  else bits.push('这段说不太准是音乐还是人声')
  // 判成人声时不给 BPM/调性：语音上算出来的 112 BPM 是噪声，说了只会误导
  if (r.kind !== 'speech' && r.bpm) {
    const c = r.bpmConfidence ?? 0
    bits.push(`${Math.round(r.bpm)} BPM${c < 0.5 ? '（速度不太确定）' : ''}`)
  }
  if (r.kind !== 'speech' && r.key) {
    const c = r.keyConfidence ?? 0
    bits.push(`${keyZh(r.key)}${c < 0.35 ? '（调性存疑）' : ''}`)
  }
  if (r.kind === 'music' && Array.isArray(r.chords) && r.chords.length) {
    const seq = r.chords.map((c) => c.label).filter(Boolean)
    if (seq.length === 1) bits.push(`和弦主要走 ${seq[0]}`)
    else if (seq.length <= 8) bits.push(`和弦走向 ${seq.join('→')}`)
    else bits.push(`和弦 ${seq.length} 段（${seq.slice(0, 6).join('→')}…）`)
  }
  if (Array.isArray(r.sections) && r.sections.length > 1) {
    bits.push(`结构 ${r.sections.map((s) => s.label || '段').join('→')}`)
  }
  return bits.join('，') + '。'
}
