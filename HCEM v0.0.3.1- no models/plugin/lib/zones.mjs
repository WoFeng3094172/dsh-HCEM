// HCEM 记忆分区与转区（每区独立 SQLite 文件版）
// 路径：context → pool_fast(2h) → pool_observe(24h) → pool_keep(72h)
//        → life（δ₁≥1.2 或 pinned>0）或 knowledge（δ₁≥0.8）；其余遗忘
//        → 生活 90 天 / 知识 120 天到期：
//            生活：pinned≥1 或 δ₂≥1.0 → 冷存；δ₂≥0.6 → 延寿 30 天；其余遗忘
//            知识：pinned≥1 或 δ₂≥0.8 → 冷存；δ₂≥0.5 → 延寿 30 天；其余遗忘
// δ₁（缓冲池）每 3 小时 ×0.95；δ₂（生活/知识）每 30 天 ×0.7
// 执行顺序（方案 A）：每轮先结算 δ 衰减，再做转区/遗忘判断
import { decayDeltaPool, decayDeltaLong } from './memory.mjs'
import { decayValues, compressDecision, valueII } from './perception/value.mjs'
import { existsSync, unlinkSync } from 'node:fs'

export const ZONE_FLOW = Object.freeze({
  context: { maxAgeHours: 2, next: 'pool_fast' },
  pool_fast: { maxAgeHours: 2, next: 'pool_observe' },
  pool_observe: { maxAgeHours: 24, next: 'pool_keep' },
  // 保留池 72h：按 δ₁ / pinned 分流（promote 里特判）
  pool_keep: { maxAgeHours: 72, next: null },
  life: { maxAgeHours: 2160, next: null }, // 90 天
  knowledge: { maxAgeHours: 2880, next: null }, // 120 天
  cold: { maxAgeHours: Infinity, next: null }, // 冷存：永不遗忘
  // ===== 视频记忆区（与文本区同构：上下文→快池→观察池→保留池→Ⅰ→Ⅱ）=====
  video_context: { maxAgeHours: 2, next: 'video_fast' },
  video_fast: { maxAgeHours: 2, next: 'video_observe' },
  video_observe: { maxAgeHours: 24, next: 'video_keep' },
  // 保留池 72h：p₀≥1 或 δ₀≥1.2 → 视频Ⅰ区；否则遗忘
  video_keep: { maxAgeHours: 72, next: null },
  // 周更池（连续剧/番剧）：192h 后直接进Ⅰ区
  video_weekly: { maxAgeHours: 192, next: 'video_1' },
  // 视频Ⅰ区：按类型周期（短片 10 天 / 连续剧 150 天 / 单集 180 天）；p₀≥1 或 δ₀≥1.0 → Ⅱ区
  video_1: { maxAgeHours: 0, next: null },
  // 视频Ⅱ区：长期
  video_2: { maxAgeHours: Infinity, next: null },

  // ===== 音频记忆区 =====
  audio_context: { maxAgeHours: 2, next: 'audio_buffer' },
  // 缓冲池 72h：去重/筛噪后进Ⅰ区
  audio_buffer: { maxAgeHours: 72, next: null },
  audio_1: { maxAgeHours: 1, next: 'audio_2' },
  audio_2: { maxAgeHours: Infinity, next: null },
})

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const POOL_ZONES = new Set([
  'context', 'pool_fast', 'pool_observe', 'pool_keep',
  // 视觉/听觉的缓冲链也吃 δ₁ 衰减
  'video_context', 'video_fast', 'video_observe', 'video_keep',
  'audio_context', 'audio_buffer',
])

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
    zone === 'life' || zone === 'knowledge' || zone === 'video_2' || zone === 'audio_2'
      ? [memory.zone_since, memory.last_accessed_at, memory.created_at]
      : [memory.last_accessed_at, memory.created_at]
  const stamps = raw.map((v) => (v ? Date.parse(v) || 0 : 0)).filter((v) => v > 0)
  const last = stamps.length > 0 ? Math.max(...stamps) : now
  return Math.max(0, (now - last) / HOUR)
}


/**
 * 遗忘一条记忆时，连带删掉它绑定的媒体文件（保护目录里的音频/图片）
 * 绑定关系存在 avMeta 里：audio 用 wav，video 用 image
 */
function forgetMemory(store, m) {
  const paths = []
  // 注意：store 返回的列名是 av_meta（下划线），不是 avMeta
  const meta = m?.av_meta ?? m?.avMeta ?? {}
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta)
      if (parsed?.wav) paths.push(parsed.wav)
      if (parsed?.image) paths.push(parsed.image)
    } catch {}
  } else if (meta && typeof meta === 'object') {
    if (meta.wav) paths.push(meta.wav)
    if (meta.image) paths.push(meta.image)
  }
  for (const p of paths) {
    try {
      if (typeof p === 'string' && existsSync(p)) unlinkSync(p)
    } catch {}
  }
  try {
    store.deleteMemory(m.id, true)
  } catch {}
}
export function promoteMemories(store, now = Date.now()) {
  const iso = new Date(now).toISOString()
  let moved = 0
  let forgotten = 0
  // 同一轮转区后不再参与后续区的判决（否则 buffer→1 会立刻又 1→2）
  const justMoved = new Set()

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
      // 视听记忆的 p₀（每 10 天 ×0.7）/ δ₀（每 30 天 ×0.7）衰减
      if (zone.startsWith('video_') || zone.startsWith('audio_')) {
        try {
          const dv = decayValues({
            p0: Number(m.video_p ?? 0),
            d0: Number(m.video_delta0 ?? 0),
            pDecayedAt: m.delta_decayed_at ? Date.parse(m.delta_decayed_at) || 0 : 0,
            d0DecayedAt: m.delta_decayed_at ? Date.parse(m.delta_decayed_at) || 0 : 0,
            now,
          })
          if (dv.pChanged || dv.dChanged) {
            store.setAvMeta(m.id, { videoP: dv.p0, videoDelta0: dv.d0 })
            store.setDeltas(m.id, Number(m.delta_pool ?? 0), Number(m.delta_long ?? 0), new Date(dv.pDecayedAt || now).toISOString())
          }
        } catch {}
        continue
      }
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
      if (justMoved.has(m.id)) continue
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
          forgetMemory(store, m)
          forgotten += 1
        }
      } else if (zone === 'video_keep') {
        // 视频保留池 72h：p₀≥1 或 δ₀≥1.2 → 视频Ⅰ区；否则遗忘（连带删关键帧）
        const p0 = Number(m.video_p ?? 0)
        const d0 = Number(m.video_delta0 ?? 0)
        if (p0 >= 1 || d0 >= 1.2) {
          store.updateZone(m.id, 'video_1', iso)
          justMoved.add(m.id)
          moved += 1
        } else {
          forgetMemory(store, m)
          forgotten += 1
        }
      } else if (zone === 'video_weekly') {
        // 周更池：192h 后直接进Ⅰ区
        store.updateZone(m.id, 'video_1', iso)
        justMoved.add(m.id)
        moved += 1
      } else if (zone === 'video_1') {
        // 视频Ⅰ区：p₀≥1 或 δ₀≥1.0 → Ⅱ区；否则按类型周期到期遗忘
        const p0 = Number(m.video_p ?? 0)
        const d0 = Number(m.video_delta0 ?? 0)
        const kind = String(m.av_meta ? (() => { try { return JSON.parse(m.av_meta).type || 'short' } catch { return 'short' } })() : 'short')
        const lifeDays = kind === 'series' ? 150 : kind === 'episode' ? 180 : 10
        if (p0 >= 1 || d0 >= 1.0) {
          store.updateZone(m.id, 'video_2', iso)
          justMoved.add(m.id)
          moved += 1
        } else if (ageHours >= lifeDays * 24) {
          forgetMemory(store, m)
          forgotten += 1
        }
      } else if (zone === 'audio_buffer') {
        // 音频缓冲池 72h：去重/筛噪后进Ⅰ区
        store.updateZone(m.id, 'audio_1', iso)
        justMoved.add(m.id)
        moved += 1
      } else if (zone === 'audio_1') {
        // 音频Ⅰ区：1h 后进Ⅱ区
        store.updateZone(m.id, 'audio_2', iso)
        justMoved.add(m.id)
        moved += 1
      } else if (zone === 'life') {
        // 生活区 90 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || deltaLong >= 1.0) {
          store.updateZone(m.id, 'cold', iso)
          justMoved.add(m.id)
          moved += 1
        } else if (deltaLong >= 0.6) {
          store.extendMemory(m.id, new Date(now + 30 * DAY).toISOString())
          moved += 1
        } else {
          forgetMemory(store, m)
          forgotten += 1
        }
      } else if (zone === 'knowledge') {
        // 知识区 120 天到期；延寿未到期则跳过
        if (m.extended_until && Date.parse(m.extended_until) > now) continue
        if (pinned >= 1 || deltaLong >= 0.8) {
          store.updateZone(m.id, 'cold', iso)
          justMoved.add(m.id)
          moved += 1
        } else if (deltaLong >= 0.5) {
          store.extendMemory(m.id, new Date(now + 30 * DAY).toISOString())
          moved += 1
        } else {
          forgetMemory(store, m)
          forgotten += 1
        }
      } else if (rule.next) {
        store.updateZone(m.id, rule.next, iso)
        moved += 1
      } else {
        forgetMemory(store, m)
        forgotten += 1
      }
    }
  }

  // ③ 视频Ⅱ区压缩：按 V_Ⅱ 决定留几张关键帧
  let compressed = 0
  try {
    const rows = store.listMemories({ zone: 'video_2', limit: 100000 })
    for (const m of rows) {
      const v = valueII({ g0: Number(m.video_gamma0 ?? 0), p0: Number(m.video_p ?? 0), d0: Number(m.video_delta0 ?? 0) })
      const ageYears = ageHoursOf(m, now, 'video_2') / (24 * 365)
      const d = compressDecision({ g0: Number(m.video_gamma0 ?? 0), p0: Number(m.video_p ?? 0), d0: Number(m.video_delta0 ?? 0), ageYears })
      // 极低价值且超过两年 → 遗忘（连带删关键帧）
      if (v < 0.3 && ageYears > 2) {
        forgetMemory(store, m)
        forgotten += 1
        continue
      }
      // 只留摘要：删掉关键帧文件，但记忆本身保留
      if (d.keepFrames === 0) {
        const meta = (() => {
          try {
            return typeof m.av_meta === 'string' ? JSON.parse(m.av_meta) : m.av_meta || {}
          } catch {
            return {}
          }
        })()
        const img = meta?.image
        if (img && existsSync(img)) {
          try {
            unlinkSync(img)
            compressed += 1
          } catch {}
        }
      }
    }
  } catch {}

  return { moved, forgotten, compressed }
}
