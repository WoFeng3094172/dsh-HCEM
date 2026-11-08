// HCEM 设置（阶段 5）：性格滑块 → HSL 基线
// 三组滑轨（范围 -5~5，对应"左右最多滑动 5%"）：
//   warmth     青 ↔ 红：冷漠 ↔ 热情（情绪唤起基线，影响 S 与 H 偏向）
//   tolerance  洋红 ↔ 绿：挑剔 ↔ 宽容（对刺激的接纳度，影响刺激增益）
//   optimism   黄 ↔ 蓝：悲观 ↔ 乐观（情绪明度基线，影响 L 与 H 偏向）
// natural：AI 自然发展的性格，左右最多 15（阶段 5 仅预留，不参与计算）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { colorBalance } from './emotion.mjs'

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  enabled: true,
  sliders: { warmth: 0, tolerance: 0, optimism: 0 },
  natural: { warmth: 0, tolerance: 0, optimism: 0, hue: 0 },
  // 搭话程度：0 安静（L≤55）｜1 好奇（55<L≤60）｜2 话痨（L>60）
  talkativeness: 0,
  // 用户填写的紧急联络人（最多 2 个）
  emergencyContacts: [],
  // 清空数据的删除密码（空 = 只用双重确认）
  deletePassword: '',
})

export const SLIDER_LIMIT = 5
export const NATURAL_LIMIT = 15

// 满行程（5%）对应的 HSL 偏移量
export const HUE_BIAS_MAX = 9 // ±9°
export const SAT_BIAS_MAX = 5 // ±5%
export const LIGHT_BIAS_MAX = 5 // ±5%
export const STIMULUS_SCALE_MAX = 0.05 // ±5%（宽容 → 刺激变弱）

function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(min, n))
}

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const s = r.sliders && typeof r.sliders === 'object' ? r.sliders : {}
  const n = r.natural && typeof r.natural === 'object' ? r.natural : {}
  return {
    version: 1,
    enabled: r.enabled !== false,
    sliders: {
      warmth: clamp(s.warmth, -SLIDER_LIMIT, SLIDER_LIMIT),
      tolerance: clamp(s.tolerance, -SLIDER_LIMIT, SLIDER_LIMIT),
      optimism: clamp(s.optimism, -SLIDER_LIMIT, SLIDER_LIMIT),
    },
    natural: {
      warmth: clamp(n.warmth, -NATURAL_LIMIT, NATURAL_LIMIT),
      tolerance: clamp(n.tolerance, -NATURAL_LIMIT, NATURAL_LIMIT),
      optimism: clamp(n.optimism, -NATURAL_LIMIT, NATURAL_LIMIT),
      hue: clamp(n.hue, -NATURAL_LIMIT, NATURAL_LIMIT),
    },
    talkativeness: Math.min(2, Math.max(0, Math.round(clamp(r.talkativeness ?? 0, 0, 2)))),
    emergencyContacts: Array.isArray(r.emergencyContacts)
      ? r.emergencyContacts.slice(0, 2).map((c) => ({
          name: String(c?.name ?? '').slice(0, 20),
          contact: String(c?.contact ?? '').slice(0, 60),
        }))
      : [],
    deletePassword: typeof r.deletePassword === 'string' ? r.deletePassword.slice(0, 64) : '',
  }
}

// 搭话档位提示（给 AI 的，不是台词）
// 由当前 L（明度/自信）推导：安静（≤55）/ 好奇（55<L≤60）/ 话痨（>60）
export function talkativenessPrompt(settings, L = 55) {
  const t = Number(L) > 60 ? 2 : Number(L) > 55 ? 1 : 0
  const label =
    t >= 2
      ? '话痨（L>60%）：主动多聊、多问，别等对方开口'
      : t === 1
        ? '好奇（55%<L≤60%）：适度主动搭话、问问题'
        : '安静（L≤55%）：少主动搭话，对方问才答'
  return `[HCEM 搭话] 当前档位：${label}。你可以主动向用户提问（例如了解 ta 的作息、喜好、最近在忙什么），并把得到的回答写进用户卡（hcem_user_card_write）。`
}

export function loadSettings(path) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return normalizeSettings(null)
  }
}

export function saveSettings(path, settings) {
  const normalized = normalizeSettings(settings)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

// 滑块 → HSL 基线（默认 H=0°/360° 黄、S=15、L=55）
export function baselineFromSliders(sliders = {}, natural = {}) {
  const warmth = clamp(sliders.warmth, -SLIDER_LIMIT, SLIDER_LIMIT) / SLIDER_LIMIT
  const tolerance = clamp(sliders.tolerance, -SLIDER_LIMIT, SLIDER_LIMIT) / SLIDER_LIMIT
  const optimism = clamp(sliders.optimism, -SLIDER_LIMIT, SLIDER_LIMIT) / SLIDER_LIMIT
  const natHue = clamp(natural.hue, -NATURAL_LIMIT, NATURAL_LIMIT)

  // 热情偏向红 300°（负方向），悲观偏向蓝 180°（正方向）
  // 色彩平衡：三滑块 → 互补色轴上移动基线色相（距目标色越近权重越高，±12°）
  // 注意：滑块传原始值（-15~15），colorBalance 内部按 ±15 归一化
  const baseHue = 0
  const balancedHue = colorBalance(
    baseHue,
    {
      warmth: warmth * SLIDER_LIMIT,
      tolerance: tolerance * SLIDER_LIMIT,
      optimism: optimism * SLIDER_LIMIT,
    },
    HUE_BIAS_MAX + 3,
  )
  const hueBias = ((balancedHue + 540) % 360) - 180 + -natHue * 1.8
  const H = ((360 + hueBias) % 360 + 360) % 360
  const S = clamp(15 + warmth * SAT_BIAS_MAX, 0, 100)
  const L = clamp(55 + optimism * LIGHT_BIAS_MAX, 0, 100)
  // 挑剔（tolerance<0）→ 刺激更强；宽容 → 刺激更弱
  const stimulusScale = 1 - tolerance * STIMULUS_SCALE_MAX

  return { H, S, L, stimulusScale, hueBias }
}