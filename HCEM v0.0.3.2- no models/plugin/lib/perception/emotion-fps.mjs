// 情绪 → 抽帧率曲线（方案 A：三次多项式，先平缓后陡峭，奇函数）
//   L_norm = (L - 50) / 50      ∈ [-1, 1]
//   γ_norm = (γ - 0.5) / 0.5    ∈ [-1, 1]
//   x      = 0.30 × L_norm + 0.20 × γ_norm   ∈ [-0.5, 0.5]
//   g(x)   = (0.2x + 4x³) / 0.6              // 奇函数，g(±0.5)=±1
//   fps    = 0.6 + 0.4 × g(x)                ∈ [0.2, 1.0]
// 曲线：原点斜率 0.33（平缓）→ 两端斜率 5.33（陡峭），先平后陡。
export const FPS_MIN = 0.2
export const FPS_MAX = 1.0
export const FPS_CENTER = 0.6
export const FPS_AMPLITUDE = 0.4
export const L_WEIGHT = 0.3
export const GAMMA_WEIGHT = 0.2
// g(x) = (a·x + b·x³) / norm，norm = a·0.5 + b·0.125
export const CURVE_A = 0.2
export const CURVE_B = 4
const CURVE_NORM = CURVE_A * 0.5 + CURVE_B * 0.125 // = 0.6

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v)))
}

/**
 * 情绪 → 目标抽帧率（fps）
 * @param {{L?: number, gamma?: number, S?: number}} emotion
 * @param {number} [sWeight=0] S 唤醒度权重（默认 0，不参与）
 * @returns {number} fps（0.2 ~ 1.0）
 */
export function fpsFromEmotion(emotion = {}, sWeight = 0) {
  const l = clamp(emotion.L ?? 55, 0, 100)
  const g = clamp(emotion.gamma ?? 0.5, 0, 1)
  const s = clamp(emotion.S ?? 0, 0, 100)
  const lNorm = (l - 50) / 50
  const gNorm = (g - 0.5) / 0.5
  const sNorm = (s - 50) / 50
  const x = L_WEIGHT * lNorm + GAMMA_WEIGHT * gNorm + sWeight * sNorm
  const gx = (CURVE_A * x + CURVE_B * x * x * x) / CURVE_NORM
  const fps = FPS_CENTER + FPS_AMPLITUDE * gx
  return clamp(fps, FPS_MIN, FPS_MAX)
}

/** 曲线斜率（调试用）：g'(x)/norm = (a + 3b·x²)/norm */
export function curveSlope(x) {
  const xx = clamp(x, -0.5, 0.5)
  return (CURVE_A + 3 * CURVE_B * xx * xx) / CURVE_NORM
}
