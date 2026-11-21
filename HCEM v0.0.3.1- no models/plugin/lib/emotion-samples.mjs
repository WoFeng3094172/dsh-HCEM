// 情绪样本与基线（2026-10-29 设计）
// - 记录六色强度样本，长期做圆均值 → 可变化的 HSL 基线
// - 多模态多戳聚合：避免多个 α/β/γ 同时叠加导致数值爆掉
import { emotionStrengths, normalizeHue, circularDistance } from './emotion.mjs'

const WINDOW_MS = 7 * 24 * 3600 * 1000
const ANGLES = { happy: 0, surprise: 60, fear: 120, sadness: 180, disgust: 240, anger: 300 }

export function appendSample(samples, state, now = Date.now()) {
  const list = Array.isArray(samples) ? samples : []
  const entry = {
    at: now,
    H: normalizeHue(state.H),
    S: Number(state.S ?? 0),
    L: Number(state.L ?? 55),
    strengths: emotionStrengths(state.H),
  }
  const next = list.filter((x) => x && now - Number(x.at) <= WINDOW_MS)
  next.push(entry)
  return next.slice(-600)
}

// 六色长期强度 → 圆均值 H；S/L 取长期均值；natural 是相对默认基线的滑块偏移（±15）
export function computeBaseline(samples, fallback = { H: 0, S: 15, L: 55 }) {
  const list = Array.isArray(samples) ? samples.filter((x) => x && x.strengths) : []
  if (list.length === 0) return { ...fallback, natural: 0, count: 0 }
  let x = 0
  let y = 0
  let sSum = 0
  let lSum = 0
  for (const s of list) {
    for (const [key, w] of Object.entries(s.strengths)) {
      const angle = (ANGLES[key] * Math.PI) / 180
      x += Number(w) * Math.cos(angle)
      y += Number(w) * Math.sin(angle)
    }
    sSum += Number(s.S)
    lSum += Number(s.L)
  }
  const H = normalizeHue((Math.atan2(y, x) * 180) / Math.PI)
  const S = sSum / list.length
  const L = lSum / list.length
  const offset = ((H + 540) % 360) - 180
  const natural = Math.max(-15, Math.min(15, Math.round(offset / 1.8)))
  return { H, S, L, natural, count: list.length }
}

// 多模态多戳聚合：色相圆均值、S 按 γ 加权、γ 用概率或（永不超 1）
export function aggregateStamps(stamps) {
  const list = (Array.isArray(stamps) ? stamps : []).filter((s) => s && Number.isFinite(Number(s.H)))
  if (list.length === 0) return null
  let x = 0
  let y = 0
  let wSum = 0
  let sSum = 0
  let gammaProduct = 1
  for (const s of list) {
    const w = Math.max(0, Math.min(1, Number(s.gamma ?? 0.5)))
    const angle = (Number(s.H) * Math.PI) / 180
    x += w * Math.cos(angle)
    y += w * Math.sin(angle)
    wSum += w
    sSum += w * Number(s.S ?? 50)
    gammaProduct *= 1 - Math.max(0, Math.min(1, Number(s.gamma ?? 0)))
  }
  const H = normalizeHue((Math.atan2(y, x) * 180) / Math.PI)
  return {
    H,
    S: wSum > 0 ? sSum / wSum : 0,
    gamma: Math.min(1, 1 - gammaProduct),
    count: list.length,
  }
}