/**
 * 视听记忆的「抢救」（到期前加分）
 *
 * 规则（v0.0.3 原版）：
 *   · AI 可以在**记忆到期之前**给 p₀ + w₆（w₆ = 0.4）
 *   · 被 +w₆ 救过（已延寿）的记忆不能再加 → 它只能靠 δ₀ 达标转区
 *   · 用户只在**看视频时**按评价加分（走同一套加分，来源不同）
 *
 * 这个模块只做两件事：
 *   1. 列出「快到期、p₀ 不够、还没被救过」的记忆（给 AI 看 / 给界面显示）
 *   2. 执行一次抢救（加分 + 延寿 30 天）
 */

import { W6 } from './perception/value.mjs'

const DAY_MS = 86400000
/** 到期前多久开始进入「可抢救」窗口 */
export const RESCUE_WINDOW_HOURS = 24
/** 延寿天数 */
export const EXTEND_DAYS = 30

/**
 * 列出可抢救的记忆
 * @param {object} store
 * @param {object} opts { windowHours, limit }
 */
export function listRescueCandidates(store, opts = {}) {
  if (!store) return []
  const windowHours = Number(opts.windowHours ?? RESCUE_WINDOW_HOURS)
  const limit = Number(opts.limit ?? 20)
  const now = Date.now()
  const out = []

  // 只关心会在窗口内到期的区（保留池 72h、视觉Ⅰ区、音频Ⅰ区）
  const zones = ['video_keep', 'video_1', 'audio_buffer', 'audio_1']
  for (const zone of zones) {
    let rows = []
    try {
      rows = store.listMemories({ zone, limit: 10000 })
    } catch {
      continue
    }
    // 这些区的到期时长（小时）
    const maxAgeHours = zone === 'video_keep' ? 72 : zone === 'audio_buffer' ? 72 : 0
    for (const m of rows) {
      const p0 = Number(m.video_p ?? 0)
      if (p0 >= 1) continue // 已经够了，不用救
      if (m.extended_until) continue // 延过寿的永久排除
      // 计算剩余时间
      const born = m.zone_since || m.created_at || m.updated_at
      const since = born ? Date.parse(born) || now : now
      const ageHours = (now - since) / 3600000
      const leftHours = maxAgeHours > 0 ? maxAgeHours - ageHours : null
      if (leftHours !== null && (leftHours <= 0 || leftHours > windowHours)) continue
      out.push({
        id: m.id,
        zone,
        summary: String(m.summary || m.text || '').slice(0, 120),
        p0,
        delta0: Number(m.video_delta0 ?? 0),
        gamma0: Number(m.video_gamma0 ?? 0),
        leftHours: leftHours === null ? null : Number(leftHours.toFixed(1)),
        modality: m.modality || 'text',
      })
    }
  }
  return out.sort((a, b) => (a.leftHours ?? 999) - (b.leftHours ?? 999)).slice(0, limit)
}

/**
 * 抢救一条记忆：p₀ + w₆，并延寿 30 天
 * @param {object} store
 * @param {string} id
 * @param {object} opts { by: 'ai'|'user', reason }
 */
export function rescueMemory(store, id, opts = {}) {
  if (!store || !id) return { ok: false, error: '参数缺失' }
  const m = store.getMemory(id)
  if (!m) return { ok: false, error: '记忆不存在' }
  const now = Date.now()
  // 每块记忆只能延寿一次：只要延过（不看是否过期）就永久拒绝
  if (m.extended_until) {
    return { ok: false, error: '这条已经延寿过，不能再延（每块只能延一次）' }
  }
  const p0 = Number(m.video_p ?? 0)
  const nextP = Number((p0 + W6).toFixed(3))
  // 延寿上限检查（原版：短片 40 天 / 系列 180 天 / 单集 210 天）
  const type = (() => {
    try {
      const meta = typeof m.av_meta === 'string' ? JSON.parse(m.av_meta) : m.av_meta || {}
      return meta.type || 'short'
    } catch {
      return 'short'
    }
  })()
  const capDays = type === 'series' ? 180 : type === 'episode' ? 210 : 40
  const born = m.zone_since || m.created_at
  const ageDays = born ? (now - (Date.parse(born) || now)) / DAY_MS : 0
  const remainCap = capDays - ageDays
  if (remainCap <= 0) return { ok: false, error: `已达该类型的延寿上限（${capDays} 天）` }
  const addDays = Math.min(EXTEND_DAYS, remainCap)
  try {
    store.setAvMeta(id, { videoP: nextP })
    store.extendMemory(id, new Date(now + addDays * DAY_MS).toISOString())
    return {
      ok: true,
      p0: nextP,
      by: String(opts.by || 'ai'),
      extendedUntil: new Date(now + addDays * DAY_MS).toISOString(),
      extendedDays: addDays,
      reason: String(opts.reason || ''),
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 用户对视频的评价 → 替用户加分
 *
 * 说明（用户定）：不需要界面按钮。
 * 由 AI 从对话里判断——用户明确说喜欢/一般/不喜欢时，AI 替用户打分；
 * 用户没评价就是弃权，什么都不做。
 *
 * @param {object} store
 * @param {string} [id] 不传则作用于「最近 30 分钟内的视频记忆」
 * @param {'like'|'normal'|'dislike'} rating
 */
export function rateWhileWatching(store, id, rating = 'normal') {
  const table = { like: 0.4, normal: 0.1, dislike: 0 }
  const add = table[String(rating)] ?? 0
  if (!store) return { ok: false, error: '参数缺失' }
  if (add === 0) return { ok: true, p0: null, added: 0, rating, note: '不喜欢不扣分，也不加分' }

  // 没指定 id：找最近的视频记忆
  let target = id
  if (!target) {
    try {
      const recent = []
      for (const zone of ['video_context', 'video_buffer', 'video_1']) {
        try {
          recent.push(...store.listMemories({ zone, limit: 20 }))
        } catch {}
      }
      const cutoff = Date.now() - 30 * 60 * 1000
      const fresh = recent
        .filter((m) => {
          const t = Date.parse(m.created_at || m.updated_at || 0) || 0
          return t >= cutoff
        })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      if (fresh.length > 0) target = fresh[0].id
    } catch {}
  }
  if (!target) return { ok: false, error: '最近没有正在看的视频记忆' }

  const m = store.getMemory(target)
  if (!m) return { ok: false, error: '记忆不存在' }
  const p0 = Number(m.video_p ?? 0)
  const nextP = Number((p0 + add).toFixed(3))
  try {
    store.setAvMeta(target, { videoP: nextP })
    return { ok: true, id: target, p0: nextP, added: add, rating }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
