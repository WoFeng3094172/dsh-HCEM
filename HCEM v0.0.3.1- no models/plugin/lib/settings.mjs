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
  // 常驻监听（音频/桌面感知）：由 UI 多模态开关同步写入
  listening: false,
  // 语音输出（TTS 播报）：由 UI「语音输出常驻」同步写入
  ttsEnabled: false,
  // 主动搭话只在 DSH 前台时进行：DSH 后台（最小化/切到别的应用）就不冒泡。
  // 默认 true——否则人不在电脑前会积一堆没人看的气泡。
  bubbleRequireFocus: true,
  // 运行模式：normal / eco（离线节能）
  mode: 'normal',
  // 无会话超过多少分钟后，常驻模型休眠
  idleMinutes: 10,
})

export const SLIDER_LIMIT = 5
// 滑块 UI 只到 ±5，但 AI 自己可以写到 ±15（hcem_profile target=traits）
export const TRAIT_LIMIT = 15
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
      warmth: clamp(s.warmth, -TRAIT_LIMIT, TRAIT_LIMIT),
      tolerance: clamp(s.tolerance, -TRAIT_LIMIT, TRAIT_LIMIT),
      optimism: clamp(s.optimism, -TRAIT_LIMIT, TRAIT_LIMIT),
    },
    natural: {
      warmth: clamp(n.warmth, -NATURAL_LIMIT, NATURAL_LIMIT),
      tolerance: clamp(n.tolerance, -NATURAL_LIMIT, NATURAL_LIMIT),
      optimism: clamp(n.optimism, -NATURAL_LIMIT, NATURAL_LIMIT),
      hue: clamp(n.hue, -NATURAL_LIMIT, NATURAL_LIMIT),
    },
    talkativeness: Math.min(2, Math.max(0, Math.round(clamp(r.talkativeness ?? 0, 0, 2)))),
    listening: r.listening === true,
    ttsEnabled: r.ttsEnabled === true,
    // 未显式设置时默认 true（旧配置文件没有这个字段）
    bubbleRequireFocus: r.bubbleRequireFocus !== false,
    emergencyContacts: Array.isArray(r.emergencyContacts)
      ? r.emergencyContacts.slice(0, 2).map((c) => ({
          name: String(c?.name ?? '').slice(0, 20),
          contact: String(c?.contact ?? '').slice(0, 60),
        }))
      : [],
    deletePassword: typeof r.deletePassword === 'string' ? r.deletePassword.slice(0, 64) : '',
    mode: ['normal', 'eco'].includes(r.mode) ? r.mode : 'normal',
    idleMinutes: Math.max(1, Math.min(120, Number(r.idleMinutes) || 10)),
  }
}

// 搭话档位提示（给 AI 的，不是台词）
//
// 档位以**用户选的** settings.talkativeness 为准（0 话痨 / 1 好奇 / 2 安静）。
// 以前的实现只看 L 推档位，会出现「菜单选安静、提示词却说你在话痨」的矛盾。
// L 现在只做一点语气上的修正：精神好时同一档位可以稍微主动些。
export function talkativenessPrompt(settings, L = 55) {
  const t = Math.min(2, Math.max(0, Math.round(Number(settings?.talkativeness ?? 0))))
  const label =
    t === 0
      ? '话痨：主动多聊、多问，别等对方开口'
      : t === 1
        ? '好奇：适度主动搭话、问问题'
        : '安静：少主动搭话，对方问才答'
  const l = Number(L)
  const tone = Number.isFinite(l) && l > 60 ? '（你现在精神不错，可以稍微活泼一点）' : ''
  return `[HCEM 搭话] 用户给你定的档位是「${label}」。${tone}可以主动向用户提问（例如了解 ta 的作息、喜好、最近在忙什么），并把得到的回答写进用户卡（hcem_profile）。`
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
  const warmth = clamp(sliders.warmth, -TRAIT_LIMIT, TRAIT_LIMIT) / SLIDER_LIMIT
  const tolerance = clamp(sliders.tolerance, -TRAIT_LIMIT, TRAIT_LIMIT) / SLIDER_LIMIT
  const optimism = clamp(sliders.optimism, -TRAIT_LIMIT, TRAIT_LIMIT) / SLIDER_LIMIT
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
