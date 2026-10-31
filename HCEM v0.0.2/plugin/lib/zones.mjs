// HCEM 记忆分区与转区（每区独立 SQLite 文件版）
// 路径：context → pool_fast(2h) → pool_observe(24h) → pool_keep(72h)
//        → life（δ≥4 或 pinned>0）或 knowledge（δ≥3）；其余遗忘
//        → 生活 90 天 / 知识 120 天到期：
//            pinned≥1 或 δ≥2.6（生活）/2.1（知识）→ 冷存
//            δ≥2.3（生活）/1.6（知识）→ 延寿 30 天
//            其余 → 遗忘
// 执行顺序（方案 A）：每轮先结算 δ 衰减，再做转区/遗忘判断
import { decayDelta } from './memory.mjs'

export const ZONE_FLOW = Object.freeze({
  context: { maxAgeHours: 2, next: 'pool_fast' },
  pool_fast: { maxAgeHours: 2, next: 'pool_observe' },
  pool_observe: { maxAgeHours: 24, next: 'pool_keep' },
  // 保留池 72h：按 δ / pinned 分流（promote 里特判）
  pool_keep: { maxAgeHours: 72, next: null },
  life: { maxAgeHours: 2160, next: null }, // 90 天
  knowledge: { maxAgeHours: 2880, next: null }, // 120 天
  cold: { maxAgeHours: Infinity, next: null }, // 冷存：永不遗忘
})

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

export function zoneOf(memory) {
  return ZONE_FLOW[memory?.zone] ? memory.zone : 'context'
}

function ageHoursOf(memory, now) {
  const stamps = [memory.last_accessed_at, memory.updated_at, memory.created_at]
    .map((v) => Date.parse(v || 0) || 0)
    .filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / HOUR)
}

function daysSince(memory, now) {
  const stamps = [memory.last_accessed_at, memory.updated_at, memory.created_at]
    .map((v) => Date.parse(v || 0) || 0)
    .filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / DAY)
}

export function promoteMemories(store, now = Date.now()) {
  const iso = new Date(now).toISOString()
  let moved = 0
  let forgotten = 0

  // ① 先结算 δ 衰减（方案 A：保证「先衰减、后判断」）
  for (const zone of Object.keys(ZONE_FLOW)) {
    if (!Number.isFinite(ZONE_FLOW[zone].maxAgeHours)) continue
    let rows = []
    try {
      rows = store.listMemories({ zone, limit: 100000 })
    } catch {
      continue
    }
    for (const m of rows) {
      const next = decayDelta(Number(m.access_count ?? 0), daysSince(m, now))
      if (Math.abs(next - Number(m.access_count ?? 0)) > 1e-9) store.setAccessCount(m.id, next)
    }
  }

  // ② 转区 / 遗忘（读到的 δ 已是衰减后的值）
  for (const zone of Object.keys(ZONE_FLOW)) {
    const rule = ZONE_FLOW[zone]
    if (!Number.isFinite(rule.maxAgeHours)) continue
    let rows = []
    try {
      rows = store.listMemories({ zone, limit: 100000 })
    } catch {
      continue
    }
    for (const m of rows) {
      const ageHours = ageHoursOf(m, now)
      if (ageHours < rule.maxAgeHours) continue

      const delta = Number(m.access_count ?? 0)
      const pinned = Number(m.pinned ?? 0)

      if (zone === 'pool_keep') {
        // 保留池 72h：δ≥4 或 pinned>0 → 生活；δ≥3 → 知识；其余遗忘
        if (delta >= 4 || pinned > 0) {
          store.updateZone(m.id, 'life', iso)
          moved += 1
        } else if (delta >= 3) {
          store.updateZone(m.id, 'knowledge', iso)
          moved += 1
        } else {
          store.deleteMemory(m.id, true)
          forgotten += 1
        }
      } else if (zone === 'life') {
        // 生活区 90 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || delta >= 2.6) {
          store.updateZone(m.id, 'cold', iso)
          moved += 1
        } else if (delta >= 2.3) {
          store.extendMemory(m.id, new Date(now + 30 * DAY).toISOString())
          moved += 1
        } else {
          store.deleteMemory(m.id, true)
          forgotten += 1
        }
      } else if (zone === 'knowledge') {
        // 知识区 120 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || delta >= 2.1) {
          store.updateZone(m.id, 'cold', iso)
          moved += 1
        } else if (delta >= 1.6) {
          store.extendMemory(m.id, new Date(now + 30 * DAY).toISOString())
          moved += 1
        } else {
          store.deleteMemory(m.id, true)
          forgotten += 1
        }
      } else if (rule.next) {
        store.updateZone(m.id, rule.next, iso)
        moved += 1
      } else {
        store.deleteMemory(m.id, true)
        forgotten += 1
      }
    }
  }

  return { moved, forgotten }
}
