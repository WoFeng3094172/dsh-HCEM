// HCEM 记忆分区与转区（每区独立 SQLite 文件版）
// 路径：context → pool_fast(2h) → pool_observe(24h) → pool_keep(72h)
//        → life（δ₁≥1.2 或 pinned>0）或 knowledge（δ₁≥0.8）；其余遗忘
//        → 生活 90 天 / 知识 120 天到期：
//            生活：pinned≥1 或 δ₂≥1.0 → 冷存；δ₂≥0.6 → 延寿 30 天；其余遗忘
//            知识：pinned≥1 或 δ₂≥0.8 → 冷存；δ₂≥0.5 → 延寿 30 天；其余遗忘
// δ₁（缓冲池）每 3 小时 ×0.95；δ₂（生活/知识）每 30 天 ×0.7
// 执行顺序（方案 A）：每轮先结算 δ 衰减，再做转区/遗忘判断
import { decayDeltaPool, decayDeltaLong } from './memory.mjs'

export const ZONE_FLOW = Object.freeze({
  context: { maxAgeHours: 2, next: 'pool_fast' },
  reincarnation: { maxAgeHours: 24, target: 'pool_fast' },
  pool_fast: { maxAgeHours: 2, next: 'pool_observe' },
  pool_observe: { maxAgeHours: 24, next: 'pool_keep' },
  // 保留池 72h：按 δ₁ / pinned 分流（promote 里特判）
  pool_keep: { maxAgeHours: 72, next: null },
  life: { maxAgeHours: 2160, next: null }, // 90 天
  knowledge: { maxAgeHours: 2880, next: null }, // 120 天
  cold: { maxAgeHours: Infinity, next: null }, // 冷存：永不遗忘
})

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const POOL_ZONES = new Set(['context', 'pool_fast', 'pool_observe', 'pool_keep'])

export function zoneOf(memory) {
  return ZONE_FLOW[memory?.zone] ? memory.zone : 'context'
}

function hoursSince(memory, now) {
  const stamps = [memory.last_accessed_at, memory.created_at]
    .map((v) => (v ? Date.parse(v) || 0 : 0))
    .filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / HOUR)
}

function daysSince(memory, now) {
  const stamps = [memory.last_accessed_at, memory.created_at]
    .map((v) => (v ? Date.parse(v) || 0 : 0))
    .filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / DAY)
}

function ageHoursOf(memory, now, zone = 'context') {
  // 生活/知识区：从「进入该区时间」算（转区刷新，保证 90/120 天逻辑）
  // 缓冲池：只看最后调用/创建时间（转区不返老还童）
  const raw =
    zone === 'life' || zone === 'knowledge'
      ? [memory.zone_since, memory.last_accessed_at, memory.created_at]
      : [memory.last_accessed_at, memory.created_at]
  const stamps = raw.map((v) => (v ? Date.parse(v) || 0 : 0)).filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / HOUR)
}

export function promoteMemories(store, now = Date.now()) {
  const iso = new Date(now).toISOString()
  let moved = 0
  let forgotten = 0

  // ① 先结算 δ 衰减（方案 A）
  for (const zone of Object.keys(ZONE_FLOW)) {
    if (!Number.isFinite(ZONE_FLOW[zone].maxAgeHours)) continue
    let rows = []
    try {
      rows = store.listMemories({ zone, limit: 100000 })
    } catch {
      continue
    }
    for (const m of rows) {
      // 幂等衰减：只对「自上次衰减以来」的周期数做衰减
      const lastDecay = m.delta_decayed_at ? Date.parse(m.delta_decayed_at) || 0 : 0
      if (POOL_ZONES.has(zone)) {
        // δ₁：每 3 小时 ×0.95
        const elapsedH = lastDecay ? (now - lastDecay) / HOUR : hoursSince(m, now)
        const periods = Math.floor(elapsedH / 3)
        if (periods > 0) {
            const next = Number(m.delta_pool ?? 0) * Math.pow(0.95, periods)
          store.setDeltas(m.id, next, Number(m.delta_long ?? 0), iso)
        }
      } else if (zone === 'life' || zone === 'knowledge') {
        // δ₂：每 30 天 ×0.7
        const elapsedD = lastDecay ? (now - lastDecay) / DAY : daysSince(m, now)
        const periods = Math.floor(elapsedD / 30)
        if (periods > 0) {
          const next = Number(m.delta_long ?? 0) * Math.pow(0.7, periods)
          store.setDeltas(m.id, Number(m.delta_pool ?? 0), next, iso)
        }
      }
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
      const ageHours = ageHoursOf(m, now, zone)
      if (ageHours < rule.maxAgeHours) continue

      const deltaPool = Number(m.delta_pool ?? 0)
      const deltaLong = Number(m.delta_long ?? 0)
      const pinned = Number(m.pinned ?? 0)

      if (zone === 'pool_keep') {
        // 保留池 72h：δ₁≥1.2 或 pinned>0 → 生活；δ₁≥0.8 → 知识；其余遗忘
        if (deltaPool >= 1.2 || pinned > 0) {
          store.updateZone(m.id, 'life', iso)
          store.setDeltas(m.id, deltaPool, 0) // δ₂ 从 0 开始
          moved += 1
        } else if (deltaPool >= 0.8) {
          store.updateZone(m.id, 'knowledge', iso)
          store.setDeltas(m.id, deltaPool, 0)
          moved += 1
        } else {
          store.deleteMemory(m.id, true)
          forgotten += 1
        }
      } else if (zone === 'life') {
        // 生活区 90 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || deltaLong >= 1.0) {
          store.updateZone(m.id, 'cold', iso)
          moved += 1
        } else if (deltaLong >= 0.6) {
          store.extendMemory(m.id, new Date(now + 30 * DAY).toISOString())
          moved += 1
        } else {
          store.deleteMemory(m.id, true)
          forgotten += 1
        }
      } else if (zone === 'knowledge') {
        // 知识区 120 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || deltaLong >= 0.8) {
          store.updateZone(m.id, 'cold', iso)
          moved += 1
        } else if (deltaLong >= 0.5) {
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
