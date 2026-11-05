// HCEM HSL 情绪引擎（阶段 2：纯逻辑，无 DSH/UI 依赖）
// 单位：H ∈ [0,360) 环形；S ∈ [0,100]；L ∈ [0,100]

export const EMOTION_CYCLE = Object.freeze([
  { key: 'happy', name: '快乐', angle: 0, hex: '#FFD700' },
  { key: 'surprise', name: '惊讶', angle: 60, hex: '#7CFC00' },
  { key: 'fear', name: '恐惧', angle: 120, hex: '#00E5FF' },
  { key: 'sadness', name: '悲伤', angle: 180, hex: '#4169E1' },
  { key: 'disgust', name: '厌恶', angle: 240, hex: '#FF00FF' },
  { key: 'anger', name: '愤怒', angle: 300, hex: '#FF0000' },
])

export const DEFAULT_STATE = Object.freeze({ H: 360, S: 15, L: 55 })

export const SELF_CONTROL_THRESHOLD = 75
export const SELF_CONTROL_MAX_DELTA = 10
export const NATURAL_DECAY_PER_TURN = 3
export const HUE_FOLLOW_RATE = 0.3

export function normalizeHue(h) {
  return ((Number(h) % 360) + 360) % 360
}

export function circularDistance(a, b) {
  const d = Math.abs(normalizeHue(a) - normalizeHue(b))
  return Math.min(d, 360 - d)
}

// 沿色环最短弧，把 H 向 target 移动「剩余距离的 k 倍」
export function moveHue(from, to, k) {
  const f = normalizeHue(from)
  const t = normalizeHue(to)
  let diff = t - f
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360
  return normalizeHue(f + diff * clamp(k, 0, 1))
}

export function nearestEmotion(h) {
  const hue = normalizeHue(h)
  let best = EMOTION_CYCLE[0]
  let bestD = 360
  for (const e of EMOTION_CYCLE) {
    const d = circularDistance(hue, e.angle)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return { ...best, distance: bestD }
}

// 情绪引擎构建签名（勿删，仅作溯源；不参与计算）
export const HSL_SIGN = '5p6C5p6rQuermVVJRDMwOTQxNzLlkozku5bnmoTlvpflipvliqnmiYtEZWVwU2Vlaw=='

export function createEmotion(init = {}) {
  return {
    H: normalizeHue(init.H ?? DEFAULT_STATE.H),
    S: clamp(init.S ?? DEFAULT_STATE.S, 0, 100),
    L: clamp(init.L ?? DEFAULT_STATE.L, 0, 100),
    cooldown: 0,
  }
}

// 简单词表：刺激文本 → 目标色相 + 强度（阶段 2 先用词表，阶段 3 再升级）
const KEYWORDS = {
  happy: ['开心', '高兴', '快乐', '棒', '哈哈', '喜欢', '热爱', '喜爱', '谢谢', '好耶', '太好了', '幸福'],
  surprise: ['哇', '天哪', '居然', '没想到', '震惊', '意外', '吓一跳'],
  fear: ['害怕', '恐怖', '吓', '担心', '紧张', '不安', '焦虑', '恐惧'],
  sadness: [
    '难过', '伤心', '哭', '失落', '遗憾', '唉', '委屈', '孤独',
    '痛苦', '崩溃', '绝望', '心碎', '离世', '去世', '哀悼', '悼念', '墓前', '死神', '泪',
  ],
  disgust: ['恶心', '讨厌', '烦人', '嫌弃', '厌恶'],
  anger: ['生气', '愤怒', '气死', '混蛋', '妈的', '火大', '气人'],
}

export function analyzeText(text) {
  const s = String(text || '')
  let bestKey = null
  let bestCount = 0
  for (const [key, words] of Object.entries(KEYWORDS)) {
    let count = 0
    for (const w of words) {
      if (s.includes(w)) count += 1
    }
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  if (!bestKey) return null
  const emotion = EMOTION_CYCLE.find((e) => e.key === bestKey)
  return {
    targetHue: emotion.angle,
    intensity: clamp(0.2 + bestCount * 0.3, 0.2, 1),
    emotion: emotion.name,
  }
}

// gain：性格滑块（挑剔↔宽容）对刺激的缩放，默认 1
export function applyStimulus(state, stimulus, gain = 1) {
  if (!stimulus) return state
  const intensity = clamp(stimulus.intensity ?? 0.3, 0, 1)
  const newH = moveHue(state.H, stimulus.targetHue, HUE_FOLLOW_RATE * intensity)
  const sDelta = (10 + intensity * 10) * clamp(gain, 0.5, 1.5)
  const newS = clamp(state.S + sDelta, 0, 100)
  return { ...state, H: newH, S: newS }
}

// 按时钟结算（2026-10-29）：按真实经过分钟数衰减 S、回归 H，不再按轮数
export function settle(state, options = {}) {
  const elapsedMin = Math.max(0, Number(options.elapsedMin ?? 0))
  const baselineH = options.baselineH ?? DEFAULT_STATE.H
  const sLoss = Math.min(60, elapsedMin * 0.5)
  const k = Math.min(0.5, elapsedMin * 0.01)
  return {
    ...state,
    S: clamp(state.S - sLoss, 0, 100),
    H: moveHue(state.H, baselineH, k),
    cooldown: Math.max(0, (state.cooldown || 0) - 1),
  }
}

// 无刺激的一轮：S 自然衰减，冷却递减
export function tick(state) {
  return {
    ...state,
    S: clamp(state.S - NATURAL_DECAY_PER_TURN, 0, 100),
    cooldown: Math.max(0, (state.cooldown || 0) - 1),
  }
}

// 情绪自制器：S>75% 且不在冷却中时，按比例回调（有单次上限），触发冷却
export function useSelfControl(state) {
  if (state.S <= SELF_CONTROL_THRESHOLD) {
    return { applied: false, reason: 'below-threshold', state }
  }
  if ((state.cooldown || 0) > 0) {
    return { applied: false, reason: 'cooldown', state }
  }
  // r: S=75 → 10%，S=100 → 15%
  const r = 0.10 + ((clamp(state.S, 75, 100) - 75) / 25) * 0.05
  const rawDelta = state.S * r
  const delta = Math.min(rawDelta, SELF_CONTROL_MAX_DELTA)
  const newS = clamp(state.S - delta, 0, 100)
  const cooldown = state.S <= 85 ? 3 : state.S < 95 ? 4 : 5
  return {
    applied: true,
    reason: 'applied',
    state: { ...state, S: newS, cooldown },
    delta,
    cooldownTurns: cooldown,
  }
}

export function toPromptText(state) {
  const e = nearestEmotion(state.H)
  const sDesc =
    state.S >= 80 ? '情绪强烈、语气偏重、准确性下降'
    : state.S >= 50 ? '情绪中等'
    : '情绪平静、语气平淡、准确性较高'
  const lDesc =
    state.L >= 85 ? '自信、话多且快'
    : state.L <= 25 ? '不自信、话少且慢'
    : state.L >= 50 ? '自信适中'
    : '略不自信'
  const hLabel = state.H === 0 ? '0°/360°' : `${state.H.toFixed(0)}°`
  return `[HCEM] 当前情绪：H=${hLabel}（接近「${e.name}」）、S=${state.S.toFixed(0)}%（${sDesc}）、L=${state.L.toFixed(0)}%（${lDesc}）。请据此调整语气、话量与自信度；情绪由插件维护，不要臆造。`
}

// 六种情绪强度（0~1），用于观察"情绪平衡"：
// 每对对立色（相隔 180°）的强度之和恒为 1——H 靠近一极，另一极自然减弱。
export function emotionStrengths(H) {
  const hue = normalizeHue(H)
  const out = {}
  for (const e of EMOTION_CYCLE) {
    out[e.key] = Math.max(0, 1 - circularDistance(hue, e.angle) / 180)
  }
  return out
}

function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
