// HCEM 记忆系统（阶段 4 最小版）
// 记忆分区、清晰度衰减、检索
import { circularDistance } from './emotion.mjs'

// γ 戳（清醒度）：α、β、δ 三重合，0~1；越相似/越常被想起 γ 越大
// sensory：多模态感官强度（0~1），v0.0.1 文本恒为 1
// delta：价值戳 δ（被检索命中的累计次数）；δn = 1 − exp(−δ/5)
// 公式：γ = (αβ重合度 + (1 − αβ重合度) × 0.3 × δn) × (0.7 + 0.3 × sensory)
// δ 只做「补足」：不会把新记忆的 γ 拖低，δ 越高 γ 越接近 1
export function computeGamma(alpha, beta, sensory = 1, delta = 0) {
  if (!alpha || beta == null || beta.H == null) return 0
  const hueSim = 1 - circularDistance(alpha.H, beta.H) / 180
  const satSim = 1 - Math.abs(Number(alpha.S ?? 0) - Number(beta.S ?? 0)) / 100
  const abSim = 0.6 * hueSim + 0.4 * satSim
  const deltaN = deltaNorm(delta)
  const merged = abSim + (1 - abSim) * 0.3 * deltaN
  const s = Math.max(0, Math.min(1, Number(sensory ?? 1)))
  return Math.max(0, Math.min(1, merged * (0.7 + 0.3 * s)))
}

// δ₁（缓冲池）：每满 3 小时未调用 × 0.95
export function decayDeltaPool(delta, hoursSinceAccess) {
  const d = Math.max(0, Number(delta ?? 0))
  const hours = Math.max(0, Number(hoursSinceAccess ?? 0))
  const periods = Math.floor(hours / 3)
  if (periods <= 0) return d
  return d * Math.pow(0.95, periods)
}

// δ₂（生活/知识区）：每满 30 天未调用 × 0.7
export function decayDeltaLong(delta, daysSinceAccess) {
  const d = Math.max(0, Number(delta ?? 0))
  const days = Math.max(0, Number(daysSinceAccess ?? 0))
  const periods = Math.floor(days / 30)
  if (periods <= 0) return d
  return d * Math.pow(0.7, periods)
}

// 兼容旧接口：总 δ 衰减（按 30 天，仅供 γ 等旧调用）
export function decayDelta(delta, daysSinceAccess) {
  return decayDeltaLong(delta, daysSinceAccess)
}

// 显式指令检测：命中 → pinned +0.5
const PIN_PATTERNS = /(帮我记|记住|记一下|别忘了|提醒我|一定要记|帮我留个心)/
export function detectPinIntent(text) {
  return PIN_PATTERNS.test(String(text ?? '')) ? 0.5 : 0
}

// δ → δn（0~1）：δ=1→0.18，δ=5→0.63，δ=10→0.86，δ=20→0.98
export function deltaNorm(delta) {
  const d = Math.max(0, Number(delta ?? 0))
  return 1 - Math.exp(-d / 5)
}

// 记忆清晰度 → L（明度/自信）基线：记忆越清晰、价值越高，AI 越自信、越愿意说话
// δ 联动：L 基线 = 55 + (平均清晰度 − 0.5) × 30 + 平均 δn × 10
export function lightnessFromMemories(memories) {
  const list = Array.isArray(memories) ? memories : []
  if (list.length === 0) return 55
  const avg = list.reduce((sum, m) => sum + Number(m.L ?? 0), 0) / list.length
  // δ 拆分：δ₁（缓冲池）权重 0.6，δ₂（长期区）权重 0.4
  const avgPoolN = list.reduce((sum, m) => sum + deltaNorm(m.delta_pool ?? 0), 0) / list.length
  const avgLongN = list.reduce((sum, m) => sum + deltaNorm(m.delta_long ?? 0), 0) / list.length
  // L 不再硬锁 20-80：给软范围 10-95（由情绪平衡模块负责回归，而非硬 clamp）
  return Math.max(10, Math.min(95, 55 + (avg - 0.5) * 30 + (0.6 * avgPoolN + 0.4 * avgLongN) * 10))
}

// 搭话档位由 L 决定：安静（≤55）/ 好奇（55<L≤60）/ 话痨（>60）
export function talkativenessFromL(L) {
  const l = Number(L ?? 55)
  return l > 60 ? 2 : l > 55 ? 1 : 0
}

export const ZONES = ['context', 'pool_fast', 'pool_observe', 'pool_keep', 'life', 'knowledge', 'cold']

// 是否值得写成记忆（简单规则：过滤寒暄/过短/过长）
export function shouldRemember(text) {
  const t = String(text || '').trim()
  if (t.length < 8) return false
  if (t.length > 4000) return false
  if (/^(你好|您好|嗨|哈喽|在吗|谢谢|再见|晚安|早安|好的|嗯|哦)/.test(t)) return false
  return true
}

// 规则摘要（首句，约 80 字）
export function summarize(text, maxLen = 80) {
  const t = String(text || '').trim()
  const first = t.split(/[。！？!?\n]/)[0] || t
  return first.length > maxLen ? first.slice(0, maxLen) + '…' : first
}

// 按清晰度等级返回「记忆此刻的样子」：完整原文 → 摘要 → 短句 → 关键词
export function displayText(memory) {
  const t = String(memory?.text ?? '')
  switch (memory?.level) {
    case 'keyword':
      return t.replace(/[，。！？、；：""''（）\s]/g, ' ').trim().slice(0, 20)
    case 'short':
      return t.slice(0, 40) + '…'
    case 'summary':
      return (memory.summary || t.slice(0, 80)) + '…'
    default:
      return t
  }
}

// 记忆原文（截断，避免整段过长）
export function extractMemoryText(text, maxLen = 500) {
  const t = String(text || '').trim()
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t
}

// 清晰度衰减（每区独立库、幂等、按分区差异化）
// rate：缓冲池/上下文 240h 归零；生活常识区 2400h（100 天，给转冷存留 10 天缓冲）；
// 知识区 2600h（约 108 天，给转冷存留缓冲）；冷存 87600h（10 年，几乎不归零）
const ZONE_RATE = {
  context: 240,
  pool_fast: 240,
  pool_observe: 240,
  pool_keep: 240,
  life: 2400,
  knowledge: 2600,
  cold: 87600,
}

export function decayMemories(store, now = Date.now()) {
  const iso = new Date(now).toISOString()
  const ageExpr =
    '(julianday(?) - julianday(MAX(COALESCE(last_accessed_at, created_at), COALESCE(updated_at, created_at), created_at))) * 24'
  let touched = 0
  for (const [zone, rate] of Object.entries(ZONE_RATE)) {
    let dbs
    try {
      // 冷存按年分文件：遍历所有年份库
      dbs = zone === 'cold' ? store.coldDbs() : [store.zoneDb(zone)]
    } catch {
      continue
    }
    for (const db of dbs) {
      // 冷存只压缩不遗忘：L 最低压到 0.1，且永不删除
      const floor = zone === 'cold' ? '0.1' : '0'
      const r = db
        .prepare(
          `UPDATE memories SET L = MAX(${floor}, MIN(L, 1 - (${ageExpr} / ${rate}.0) * (1 - 0.5 * COALESCE(gamma_value, 0))))
           WHERE deleted_at IS NULL AND zone = ?`,
        )
        .run(iso, zone)
      touched += Number(r.changes ?? 0)
      db.prepare(
        `UPDATE memories SET level = CASE WHEN L < 0.25 THEN 'keyword' WHEN L < 0.5 THEN 'short' WHEN L < 0.75 THEN 'summary' ELSE level END WHERE deleted_at IS NULL AND zone = ?`,
      ).run(zone)
      if (zone !== 'cold') {
        const delResult = db.prepare('DELETE FROM memories WHERE deleted_at IS NULL AND zone = ? AND L <= 0.001').run(zone)
        touched += Number(delResult.changes ?? 0)
      }
    }
  }
  return touched
}
// 回忆时刷新清晰度：γ 越高，刷新越多（0.1 ~ 0.3）
export function refreshAmount(gamma) {
  return 0.1 + 0.2 * Math.max(0, Math.min(1, Number(gamma ?? 0)))
}

// 回忆反哺情绪：命中记忆的 γ 越高，越能唤起当时的情绪（S 抬升，单轮上限 maxBoost）
export function applyRecallToEmotion(state, hits, maxBoost = 8) {
  if (!Array.isArray(hits) || hits.length === 0) return state
  let boost = 0
  for (const h of hits) boost += Number(h.gamma_value ?? 0) * 2
  boost = Math.min(maxBoost, boost)
  if (boost <= 0) return state
  return { ...state, S: Math.min(100, Number(state.S) + boost) }
}

// 检索：query embedding → topK 相关记忆（相似度阈值）
export function recall(store, queryVec, topK = 3, minSim = 0.45) {
  const hits = store.searchMemories(queryVec, topK)
  const kept = hits.filter((h) => h.similarity >= minSim)
  // 被调用即刷新清晰度（last_accessed_at / access_count），配合 γ 让「调用率越高越不易模糊」生效
  for (const hit of kept) {
    try {
      store.touchMemory(hit.id, refreshAmount(hit.gamma_value))
    } catch {
      // ignore
    }
  }
  return kept
}
