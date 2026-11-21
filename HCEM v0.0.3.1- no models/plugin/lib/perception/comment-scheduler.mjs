// 评论调度器：把 L（明度/自信）翻译成「说不说、说多少」
// 设计：L 五档 → 评论概率 + 最大字数；无硬冷却（用概率避免机械感）
// 触发时机：场景组结束（情绪浮动大 / 新场景 / 用户刚互动）

export const L_TIERS = [
  { min: 0, max: 20, name: '疲惫', probability: 0.1, maxChars: 15 },
  { min: 20, max: 40, name: '安静', probability: 0.3, maxChars: 30 },
  { min: 40, max: 60, name: '适中', probability: 0.5, maxChars: 50 },
  { min: 60, max: 80, name: '活跃', probability: 0.7, maxChars: 80 },
  { min: 80, max: 100, name: '兴奋', probability: 0.9, maxChars: 120 },
]

export function tierOf(L) {
  const l = Math.max(0, Math.min(100, Number(L ?? 55)))
  for (const t of L_TIERS) {
    if (l < t.max) return t
  }
  return L_TIERS[L_TIERS.length - 1]
}

/**
 * 判断是否评论
 * @param {object} input { L, emotionDelta, newScene, recentUserMessage, rng }
 * @returns {{ speak: boolean, tier: object, probability: number, maxChars: number, reason: string }}
 */
export function shouldComment(input = {}) {
  const tier = tierOf(input.L)
  let p = tier.probability
  const reasons = []
  // 情绪浮动大：+0.2
  if (Number(input.emotionDelta ?? 0) >= 0.3) {
    p += 0.2
    reasons.push('情绪浮动大')
  }
  // 新场景类型：+0.1
  if (input.newScene) {
    p += 0.1
    reasons.push('新场景')
  }
  // 用户刚互动：+0.2
  if (input.recentUserMessage) {
    p += 0.2
    reasons.push('用户在互动')
  }
  p = Math.max(0, Math.min(1, p))
  const rng = typeof input.rng === 'function' ? input.rng : Math.random
  const speak = rng() < p
  return {
    speak,
    tier,
    probability: Number(p.toFixed(2)),
    maxChars: tier.maxChars,
    reason: reasons.length > 0 ? reasons.join('、') : '普通场景',
  }
}
