/**
 * 记忆种子选择（Q5）
 *
 * 输入：recallRanked() 给出的候选（已按 γ/α/δ 排好序）
 * 输出：路径 + 实际注入的种子
 *
 * 三条路径：
 *   fact      事实型：top-3 直接注入
 *   reasoning 推理型：top-1 作种子，沿 causal 边扩展 1 跳（最多 2 条）
 *   emotional 情感型：按 α 色相接近度 + γ 取 2 条
 *
 * 注意：它不负责“检索”（embedding + recallRanked 已做），也不改记忆本身。
 */

const REASONING_RE = /(为什么|怎么回?事|原因|因为|所以|后来|结果|导致|怎么会|凭什么)/
const EMOTIONAL_RE = /(感觉|心情|难过|开心|高兴|害怕|担心|焦虑|生气|委屈|孤单|想你了)/

export function pickPath(queryText = '') {
  const s = String(queryText || '')
  if (REASONING_RE.test(s)) return 'reasoning'
  if (EMOTIONAL_RE.test(s)) return 'emotional'
  return 'fact'
}

function hueSim(a, b) {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return 0
  const d = Math.abs((((Number(a) - Number(b)) % 360) + 360) % 360)
  return 1 - Math.min(d, 360 - d) / 180
}

/**
 * @param {{hits:Array, queryText?:string, state?:object, store?:object, maxSeeds?:number, maxExpand?:number}} o
 * @returns {{path:string, seeds:Array, expanded:number, reason?:string}}
 */
export function chooseSeeds({ hits = [], queryText = '', state = null, store = null, maxSeeds = 3, maxExpand = 2 } = {}) {
  const list = Array.isArray(hits) ? hits.filter((h) => String(h.modality || '') !== 'note') : []
  if (list.length === 0) return { path: 'none', seeds: [], expanded: 0, reason: 'no-hits' }
  const path = pickPath(queryText)

  if (path === 'reasoning') {
    const seed = list[0]
    const seeds = [seed]
    let expanded = 0
    if (store && typeof store.edgesOf === 'function') {
      try {
        const edges = store.edgesOf(seed.id, { kind: 'causal', dir: 'both', limit: 8 })
        for (const e of edges) {
          if (expanded >= maxExpand) break
          const otherId = e.from_id === seed.id ? e.to_id : e.from_id
          const row = store.getMemory ? store.getMemory(otherId) : null
          if (!row || String(row.modality || '') === 'note') continue
          if (seeds.some((x) => x.id === row.id)) continue
          seeds.push({ ...row, score: Number(seed.score || 0) * 0.6, similarity: 0, expandedFrom: seed.id })
          expanded += 1
        }
      } catch {}
    }
    return { path, seeds, expanded }
  }

  if (path === 'emotional') {
    const scored = list
      .map((h) => ({
        h,
        s: Number(h.score || 0) + 0.1 * (state ? hueSim(h.alpha_H, state.H) : 0),
      }))
      .sort((a, b) => b.s - a.s)
    return { path, seeds: scored.slice(0, Math.min(2, maxSeeds)).map((x) => x.h), expanded: 0 }
  }

  return { path: 'fact', seeds: list.slice(0, maxSeeds), expanded: 0 }
}
