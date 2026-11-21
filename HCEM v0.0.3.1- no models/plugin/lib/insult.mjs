// 辱骂/羞辱检测（trauma 戳用）：关键词规则（宁漏勿误伤）
// 只对「直接、非引用」的辱骂打戳；玩笑/引用 → 不打
export const INSULT_WORDS = [
  '傻逼', '傻子', '笨蛋', '蠢货', '废物', '垃圾', '白痴', '弱智', '神经病', '有病',
  '去死', '滚开', '闭嘴', '妈的', '操你', '滚蛋', '不要脸', '下贱', '恶心',
]

// 引用/玩笑的排除词（出现这些 → 视为非直接辱骂）
const QUOTE_MARKERS = ['他说', '她说', '有人说', '台词', '引用', '假如', '如果我是', '扮演']

/**
 * 检测辱骂
 * @returns {{ hit: boolean, words: string[], severity: number, quoted: boolean }}
 */
export function detectInsult(text) {
  const t = String(text || '')
  const quoted = QUOTE_MARKERS.some((m) => t.includes(m))
  const words = INSULT_WORDS.filter((w) => t.includes(w))
  const hit = words.length > 0 && !quoted
  return {
    hit,
    words,
    quoted,
    severity: hit ? Math.min(1, 0.4 + words.length * 0.15) : 0,
  }
}
