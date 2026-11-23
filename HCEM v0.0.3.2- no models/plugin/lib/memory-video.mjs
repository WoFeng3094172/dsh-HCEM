// 视频记忆写入/检索（video_buffer → video_1 → video_2）
// v0.0.3 价值公式：γ₀ = 0.5γᵥ+0.3γₐ+0.2γₘ、δ₀ = 0.5(0.6δᵥ+0.4δₐ)+γ₀、p₀ = pᵥ+pₐ
import { computeGamma } from './memory.mjs'
import './home.mjs'
import { gammaVideo, gammaAudio, gamma0, delta0, behaviorAdjust } from './perception/value.mjs'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

/** 把要长期保留的媒体复制进保护目录（记忆被遗忘时会连带删除） */
function keepMedia(srcPath, dataDir, sub) {
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

/**
 * 写一条视频记忆
 * @param {object} p
 *   store, description, image, dataDir, screen, diff, priority, notes, alpha
 *   modelScore: 视觉模型给的喜好分（0~1），没有就用帧差近似
 *   p0: 已有喜好度（用户/AI 已经给过的）
 *   repeated: 是否重复播放（p₀ +0.2）
 *   type: short / series / episode（影响Ⅰ区周期）
 *   embed: 可选，async (texts: string[]) => number[][]。给了就算向量，
 *          这样视觉记忆也能被语义检索（以前完全不写 embedding，47 条全是空的）
 */
export async function putVideoMemory({
  store,
  description,
  image = null,
  dataDir = null,
  screen = 0,
  diff = 0,
  priority = 'mid',
  notes = null,
  alpha = { H: 360, S: 15 },
  modelScore = null,
  p0: p0In = 0,
  repeated = false,
  type = 'short',
  embed = null,
  timeStart = null,
  timeEnd = null,
} = {}) {
  if (!store || !description) return { ok: false }
  const beta = { H: 360, S: Math.max(20, Math.min(100, diff * 100 * 3)) }
  const gamma = computeGamma(alpha, beta, 1, 0)

  // ===== v0.0.3 价值公式 =====
  const S = Number(alpha?.S ?? 15)
  const gV = gammaVideo({ S, visionScore: modelScore === null ? clamp01(diff * 1.5) : clamp01(modelScore) })
  const gA = gammaAudio({ S, audioScore: 0 })
  const g0 = gamma0('video', { gammaV: gV, gammaA: gA, gammaM: 0 })
  const dV = clamp01(Number(diff) * 2) // 帧差 → 信息量
  const d0 = delta0('video', { deltaV: dV, deltaA: 0, g0 })
  const p0 = behaviorAdjust(Number(p0In) || 0, { repeated, staticScene: Number(diff) < 0.02 })

  // 关键帧先记原路径，写入拿到 id 后再复制成 {id}.png（便于孤儿清理）
  const keepDir = dataDir || `${globalThis.__HCEM_HOME__}/data`

  try {
    const memText = String(description).slice(0, 500)
    // 向量：有 embed 就算，失败不影响写入（宁可有记忆没向量，也别丢记忆）
    let vec = null
    if (typeof embed === 'function') {
      try {
        const out = await embed([memText])
        if (Array.isArray(out) && Array.isArray(out[0])) vec = out[0]
      } catch {}
    }
    const id = store.putMemory({
      text: memText,
      summary: String(description).slice(0, 80),
      embedding: vec || undefined,
      zone: 'video_context',
      timeStart,
      timeEnd, // 按 11-06 设计：起点是视觉上下文（2h）
      modality: 'video',
      sensory: Math.max(0.3, Math.min(1, diff * 2)),
      alphaH: alpha.H,
      alphaS: alpha.S,
      betaH: beta.H,
      betaS: beta.S,
      gamma,
      gammaValue: gamma,
      L: 0.9,
      deltaPool: priority === 'high' ? 1.2 : 0.8,
      timeStart: Date.now() / 1000,
      avMeta: { screen, diff, priority, image, notes, type },
    })
    // 价值字段单独写（p₀ / δ₀ / γ₀ / 类型）
    // 写入成功后把关键帧复制成 {id}.png
    let keptImage = null
    try {
      if (image && existsSync(image)) {
        const dir = join(keepDir, 'keep', 'video')
        mkdirSync(dir, { recursive: true })
        keptImage = join(dir, id + '.png')
        copyFileSync(image, keptImage)
      }
    } catch {}
    try {
      store.setAvMeta(id, {
        videoP: p0,
        videoDelta0: d0,
        videoGamma0: g0,
        avMeta: { screen, diff, priority, image: keptImage, notes, type, timeStart, timeEnd },
      })
    } catch {}
    return { ok: true, id, value: { g0: Number(g0.toFixed(3)), d0: Number(d0.toFixed(3)), p0 } }
  } catch {
    return { ok: false }
  }
}

/** 检索视频记忆（最近 N 条） */
export function recallVideoMemories(store, limit = 20) {
  if (!store) return []
  const out = []
  for (const zone of ['video_context', 'video_fast', 'video_observe', 'video_keep', 'video_1', 'video_2']) {
    try {
      out.push(...store.listMemories({ zone, limit }))
    } catch {}
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit)
}
