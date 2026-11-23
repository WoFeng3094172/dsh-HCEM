// 音频记忆写入（A4）：把 audioTick 结果写进 audio_buffer 区
// 规则：
//   · 有转写文本（语音）→ audio_kind='voice'，δ₀=1.5（对话珍贵）
//   · 无文本但有声音（音乐/场景）→ audio_kind='scene'，δ₀=0.5
//   · 情绪标签 → 记入 summary（供检索）
import { computeGamma } from '../memory.mjs'
import { gammaVideo, gammaAudio, gamma0, delta0 } from '../perception/value.mjs'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * @param {object} opts { store, tick: audioTick 结果, alpha?: {H,S} }
 * @returns {{ ok: boolean, id?: string, kind?: string }}
 */

/** 把要长期保留的音频复制进保护目录（记忆被遗忘时会连带删除） */
function keepAudio(srcPath, dataDir, sub) {
  try {
    if (!srcPath || !existsSync(srcPath)) return srcPath
    const dir = join(dataDir, 'keep', sub)
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, basename(srcPath))
    if (dest !== srcPath) copyFileSync(srcPath, dest)
    return dest
  } catch {
    return srcPath
  }
}
export async function putAudioMemory({ store, tick, alpha = { H: 360, S: 15 }, dataDir = null, embed = null, timeStart = null, timeEnd = null }) {
  if (!store || !tick || !tick.ok) return { ok: false }
  const text = String(tick.text || '').trim()
  const hasVoice = text.length > 0
  const emotion = String(tick.emotion || '')
  const score = Number(tick.emotionScore || 0)
  const kind = hasVoice ? 'voice' : 'scene'
  const deltaPool0 = hasVoice ? 1.5 : 0.5
  // 情绪强度 → S（用于 β 戳）
  const betaS = hasVoice ? Math.max(20, Math.min(100, score * 100)) : 15
  const beta = { H: 360, S: betaS }
  const gamma = computeGamma(alpha, beta, 1, 0)
  // v0.0.3 价值公式（音频权重：γ₀ = 0.2γᵥ + 0.6γₐ + 0.2γₘ）
  const S = Number(alpha?.S ?? 15)
  const gA = gammaAudio({ S, audioScore: hasVoice ? Math.min(1, score) : 0.2 })
  const gV = gammaVideo({ S, visionScore: 0 })
  const g0 = gamma0('audio', { gammaV: gV, gammaA: gA, gammaM: 0 })
  // δₐ：有转写文本按长度算信息量，否则按场景标签
  const deltaA = hasVoice ? Math.min(1, text.length / 80) : Math.min(1, 0.2 + (tick.tags?.length || 0) * 0.1)
  const d0 = delta0('audio', { deltaV: 0, deltaA, g0 })
  // 有转写的语音才值得留档；纯环境声不留文件
  const keptWav = hasVoice ? keepAudio(tick.wav, dataDir || globalThis.__HCEM_DATA__, 'audio') : null
  const musicDesc =
    tick.music && Number.isFinite(Number(tick.music.valence))
      ? '音乐 V=' + Number(tick.music.valence).toFixed(2) + ' E=' + Number(tick.music.energy || 0).toFixed(2)
      : ''
  const summary = [
    tick.categoryName || '',
    hasVoice ? text.slice(0, 60) : '(音乐/环境声)',
    emotion,
    musicDesc,
  ]
    .filter(Boolean)
    .join(' | ')
  try {
    const memText = hasVoice ? text : `[音频] ${emotion || '环境声'}`
    // 向量：以前这条路径完全不写 embedding，听觉记忆检索不到
    let vec = null
    if (typeof embed === 'function') {
      try {
        const out = await embed([memText])
        if (Array.isArray(out) && Array.isArray(out[0])) vec = out[0]
      } catch {}
    }
    const id = store.putMemory({
      text: memText,
      summary,
      embedding: vec || undefined,
      zone: 'audio_context', // 起点是听觉上下文（2h）
      timeStart,
      timeEnd,
      modality: 'audio',
      sensory: hasVoice ? 1 : 0.6,
      alphaH: alpha.H,
      alphaS: alpha.S,
      betaH: beta.H,
      betaS: beta.S,
      gamma: gamma,
      gammaValue: gamma,
      L: 0.9,
      deltaPool: deltaPool0,
      deltaLong: 0,
      avMeta: {
        audio_kind: kind,
        category: tick.category || '',
        categoryName: tick.categoryName || '',
        soundDesc: tick.soundDesc || '',
        emotion,
        score,
        tags: tick.tags || [],
        music: tick.music || null,
        musicInfo: tick.musicInfo || null,
        fp: tick.fp || '',
        segments: Array.isArray(tick.asrSegments) ? tick.asrSegments : [],
        wav: keptWav,
        timeStart,
        timeEnd,
      },
    })
    try {
      store.setAvMeta(id, { videoGamma0: g0, videoDelta0: d0, audioKind: kind, audioFp: tick.fp || null })
    } catch {}
    return { ok: true, id, kind }
  } catch {
    return { ok: false }
  }
}
