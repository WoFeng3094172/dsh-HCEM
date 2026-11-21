/**
 * 视听记忆 · 价值计算（v0.0.3 原版公式）
 *
 *   γᵥ = clamp(0.6 × (S_α/100 + 视觉评分), 0, 1)
 *   γₐ = clamp(0.6 × (S_α/100 + 音频评分), 0, 1)
 *   γ₀ = 0.5γᵥ + 0.3γₐ + 0.2γₘ        （视频）
 *   γ₀ = 0.2γᵥ + 0.6γₐ + 0.2γₘ        （音频）
 *   δ₀ = 0.5×(0.6δᵥ + 0.4δₐ) + γ₀     （视频）
 *   δ₀ = 0.5×(0.2δᵥ + 0.8δₐ) + γ₀     （音频）
 *   p₀ = pᵥ + pₐ
 *   V_Ⅱ = 2.5γ₀ + 3.5p₀ + 4δ₀
 *
 * p₀ 约束：pᵥ = 0.4x，pₐ = 0.4y，x ≥ 0，且 −0.5 ≤ x+y ≤ 4
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))

/** AI 到期前单次加分幅度 */
export const W6 = 0.4
/** p₀ 衰减周期（天）与系数 */
export const P_DECAY_DAYS = 10
export const P_DECAY_FACTOR = 0.7
/** δ₀ 衰减周期（天）与系数 */
export const D0_DECAY_DAYS = 30
export const D0_DECAY_FACTOR = 0.7

/** Ⅰ区周期（天）：短片 / 系列 / 单集 */
export const VIDEO_LIFE_DAYS = { short: 10, series: 150, episode: 180 }
/** 延寿上限（天） */
export const VIDEO_LIFE_MAX_DAYS = { short: 40, series: 180, episode: 210 }

/**
 * 视频情绪强度
 * @param {object} p { S（AI 当时饱和度）, visionScore（视觉模型评分 0~1） }
 */
export function gammaVideo({ S = 15, visionScore = 0.5 } = {}) {
  return clamp(0.6 * (clamp(S, 0, 100) / 100 + clamp(visionScore, 0, 1)), 0, 1)
}

/** 音频情绪强度 */
export function gammaAudio({ S = 15, audioScore = 0.5 } = {}) {
  return clamp(0.6 * (clamp(S, 0, 100) / 100 + clamp(audioScore, 0, 1)), 0, 1)
}

/**
 * γ₀ 合成
 * @param {'video'|'audio'} kind
 * @param {object} p { gammaV, gammaA, gammaM }
 */
export function gamma0(kind, { gammaV = 0, gammaA = 0, gammaM = 0 } = {}) {
  const gv = clamp(gammaV, 0, 1)
  const ga = clamp(gammaA, 0, 1)
  const gm = clamp(gammaM, 0, 1)
  return kind === 'audio' ? 0.2 * gv + 0.6 * ga + 0.2 * gm : 0.5 * gv + 0.3 * ga + 0.2 * gm
}

/**
 * δ₀ 合成
 * @param {'video'|'audio'} kind
 * @param {object} p { deltaV, deltaA, g0 }
 */
export function delta0(kind, { deltaV = 0, deltaA = 0, g0 = 0 } = {}) {
  const dv = clamp(deltaV, 0, 1)
  const da = clamp(deltaA, 0, 1)
  const base = kind === 'audio' ? 0.5 * (0.2 * dv + 0.8 * da) : 0.5 * (0.6 * dv + 0.4 * da)
  return base + clamp(g0, 0, 1)
}

/**
 * p₀ 合法性校验（AI 给分）
 * @param {{x:number,y:number}} p x 对应视频喜好、y 对应音频喜好
 */
export function validateP({ x = 0, y = 0 } = {}) {
  const xx = Number(x)
  const yy = Number(y)
  if (!Number.isFinite(xx) || !Number.isFinite(yy)) return { ok: false, error: '必须为数字' }
  if (xx < 0) return { ok: false, error: 'x 不能小于 0' }
  const sum = xx + yy
  if (sum < -0.5 || sum > 4) return { ok: false, error: `x+y 必须在 −0.5 ~ 4 之间（当前 ${sum.toFixed(2)}）` }
  return { ok: true, pv: Number((0.4 * xx).toFixed(3)), pa: Number((0.4 * yy).toFixed(3)), p0: Number((0.4 * (xx + yy)).toFixed(3)) }
}

/** 把 p₀ 拆回 pᵥ / pₐ（读旧记忆时用） */
export function splitP(p0) {
  const v = clamp(p0, -0.2, 1.6)
  return { pv: v, pa: Math.max(0, v - 1.6) }
}

/** Ⅱ区价值 */
export function valueII({ g0 = 0, p0 = 0, d0 = 0 } = {}) {
  return 2.5 * clamp(g0, 0, 1) + 3.5 * Math.max(0, Number(p0) || 0) + 4 * Math.max(0, Number(d0) || 0)
}

/**
 * Ⅱ区压缩决策：留几张关键帧
 * @returns {{ keepFrames: number, reason: string }}
 */
export function compressDecision({ g0 = 0, p0 = 0, d0 = 0, ageYears = 0 } = {}) {
  const v = valueII({ g0, p0, d0 })
  if (v >= 3) return { keepFrames: 99, v, reason: '价值高：保留关键帧 + 摘要' }
  if (v >= 1) return { keepFrames: 1, v, reason: '中等：摘要 + 1 枚关键帧' }
  if (v >= 0.3) return { keepFrames: 0, v, reason: '偏低：只留摘要' }
  if (ageYears > 2) return { keepFrames: 0, v, reason: '极低且超过 2 年：遗忘' }
  return { keepFrames: 0, v, reason: '极低：只留摘要（未到 2 年）' }
}

/**
 * p₀ / δ₀ 的时间衰减（幂等：按经过的整周期数衰减）
 * @param {object} p { p0, d0, pDecayedAt, d0DecayedAt, now }
 */
export function decayValues({ p0 = 0, d0 = 0, pDecayedAt = 0, d0DecayedAt = 0, now = Date.now() } = {}) {
  const DAY = 86400000
  let nextP = Number(p0) || 0
  let nextD = Number(d0) || 0
  let pChanged = false
  let dChanged = false

  if (pDecayedAt) {
    const periods = Math.floor((now - pDecayedAt) / (P_DECAY_DAYS * DAY))
    if (periods > 0) {
      nextP = nextP * Math.pow(P_DECAY_FACTOR, periods)
      pChanged = true
    }
  }
  if (d0DecayedAt) {
    const periods = Math.floor((now - d0DecayedAt) / (D0_DECAY_DAYS * DAY))
    if (periods > 0) {
      nextD = nextD * Math.pow(D0_DECAY_FACTOR, periods)
      dChanged = true
    }
  }
  return {
    p0: Number(nextP.toFixed(4)),
    d0: Number(nextD.toFixed(4)),
    pChanged,
    dChanged,
    pDecayedAt: pChanged ? now : pDecayedAt,
    d0DecayedAt: dChanged ? now : d0DecayedAt,
  }
}

/**
 * 到期前 AI 加分（w₆）
 * 规则：被 +w₆ 救过（已延寿）的记忆不能再加
 * @returns {{ ok:boolean, p0?:number, error?:string }}
 */
export function addW6(memory) {
  if (!memory) return { ok: false, error: '记忆不存在' }
  const p0 = Number(memory.video_p ?? memory.p0 ?? 0)
  const extended = memory.extended_until && Date.parse(memory.extended_until) > 0
  if (extended) return { ok: false, error: '已延寿过的记忆不能再加分' }
  return { ok: true, p0: Number((p0 + W6).toFixed(3)) }
}

/** 行为修正：重复播放 / 静态画面 */
export function behaviorAdjust(p0, { repeated = false, staticScene = false } = {}) {
  let v = Number(p0) || 0
  if (repeated) v += 0.2
  if (staticScene) v -= 0.2
  return Number(v.toFixed(3))
}
