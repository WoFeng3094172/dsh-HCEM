// MD（Memory Distortion）：记忆失真数值（0-1，连续）
// 设计：MD 在「压缩 + 调用 + 联想」后计算
//       MD 高 → 不进推理（但仍可检索/随口提及）；软标签（自然说「记不清」）
//       MD 影响 L：baseL 向中性收（1-MD），L 波动 ±2×MD（平滑）

export const MD_CONFIG = Object.freeze({
  compressWeight: 0.3, // 压缩贡献
  recallWeight: 0.2, // 调用（二次调用）贡献
  associativeWeight: 0.5, // 联想生成贡献（最大）
  max: 1,
})

/** clamp 0-1 */
function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0))
}

/**
 * 计算 MD（0-1）
 * @param {object} opts { compressed:0-1（压缩程度）, recalled:次数/0-1, associative:0-1（联想生成比例）}
 * @returns {number}
 */
export function computeMD({ compressed = 0, recalled = 0, associative = 0 } = {}) {
  const c = clamp01(compressed)
  const r = clamp01(recalled)
  const a = clamp01(associative)
  const md = c * MD_CONFIG.compressWeight + r * MD_CONFIG.recallWeight + a * MD_CONFIG.associativeWeight
  return clamp01(md)
}

/** 合并 MD（父记忆 MD + 子记忆附加） */
export function inheritMD({ parentMD = 0, compressed = 0, recalled = 0, associative = 0 } = {}) {
  return clamp01(Math.max(Number(parentMD) || 0, computeMD({ compressed, recalled, associative })))
}

/** MD 是否允许进入推理（达最大值 → 否） */
export function canReason(md, { maxForReason = 0.85 } = {}) {
  return Number(md) < maxForReason
}

/** MD → 软标签文本（自然措辞，非模板） */
export function mdSoftLabel(md) {
  const v = Number(md) || 0
  if (v < 0.3) return ''
  if (v < 0.6) return '好像/大概'
  if (v < 0.85) return '记不太清'
  return '记不清了'
}

/** MD → 提示词（注入 system prompt，让 AI 自然处理模糊记忆） */
export function mdPrompt(md, text = '') {
  const label = mdSoftLabel(md)
  if (!label) return ''
  return `【模糊记忆】以下记忆的清晰度较低（MD=${Number(md).toFixed(2)}），
回忆时可以用"${label}"这类自然说法带过，不要追问细节，不要过度联想。${text ? `\n记忆：${String(text).slice(0, 200)}` : ''}`
}

/** MD → baseL 权重（1=完整基线；0=中性 55） */
export function baseLWeight(md) {
  return 1 - clamp01(md)
}

/** MD → L 波动幅度（±2×MD） */
export function mdLightnessJitter(md, rng = Math.random) {
  const mdv = clamp01(md)
  return (rng() - 0.5) * 2 * mdv * 2
}
