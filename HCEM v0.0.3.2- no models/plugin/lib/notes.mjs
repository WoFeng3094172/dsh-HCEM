/**
 * 视频/音频「笔记」：一场一条，作为 Graph-RAG 的索引节点
 *
 * 设计约束（来自夜里的决定）：
 *   - 一场一 note，场内时间轴放在 av_meta.segments，不单独建节点
 *   - note 是记忆表里的一行（modality='note'），所以**直接沿用记忆区的转存/遗忘规则**
 *   - note 与对应视频记忆共用 p₀/δ₀（由调用方传入或取首条记忆的值）
 *   - 笔记删除不影响记忆；记忆被忘 → note 里的 memoryIds 自然断链
 *   - 系列识别：note 累积到 N 条后离线聚类，写回 av_meta.seriesId
 */
import { readFileSync } from 'node:fs'

const NOTE_ZONES = ['video_context', 'video_fast', 'video_observe', 'video_keep', 'video_1', 'video_2']

function noteOf(row) {
  try {
    const meta = JSON.parse(String(row.av_meta || '{}'))
    return { ...meta, modality: row.modality }
  } catch {
    return { modality: row.modality }
  }
}

/** 新建一条笔记（一场一条） */
export function createNote(
  store,
  {
    summary = '',
    sessionId = '',
    media = 'video',
    segments = [],
    characters = [],
    background = '',
    title = '',
    memoryIds = [],
    frameIds = [],
    audioIds = [],
    storyboard = '',
    alpha = { H: 360, S: 15 },
    p0 = 0.9,
    delta0 = 1.0,
  } = {},
) {
  if (!store) return { ok: false, error: 'no-store' }
  const text = String(summary || '').trim()
  if (!text) return { ok: false, error: 'empty-summary' }
  try {
    const id = store.putMemory({
      text,
      summary: text.slice(0, 80),
      zone: 'video_context',
      modality: 'note',
      alphaH: Number(alpha.H ?? 360),
      alphaS: Number(alpha.S ?? 15),
      gammaValue: 0.8,
      L: 0.9,
      deltaPool: 1.0,
      avMeta: {
        kind: 'note',
        sessionId,
        media,
        title,
        segments: Array.isArray(segments) ? segments.slice(0, 60) : [],
        characters: Array.isArray(characters) ? characters.slice(0, 20) : [],
        background: String(background || '').slice(0, 400),
        memoryIds: Array.isArray(memoryIds) ? memoryIds.slice(0, 200) : [],
        frameIds: Array.isArray(frameIds) ? frameIds.slice(0, 200) : [],
        audioIds: Array.isArray(audioIds) ? audioIds.slice(0, 200) : [],
        seriesId: null,
        storyboard: String(storyboard || ''),
      },
    })
    // 共用 p₀/δ₀（与视频记忆同寿命）
    try {
      store.setAvMeta(id, { videoP: Number(p0) || 0.9, videoDelta0: Number(delta0) || 1.0 })
    } catch {}
    // evidence 边：笔记 → 每条记忆
    for (const mid of Array.isArray(memoryIds) ? memoryIds : []) {
      try {
        store.addEdge({ fromId: id, toId: mid, kind: 'evidence', conf: 0.9 })
      } catch {}
    }
    // temporal 边：场内相邻片段（如果传了 noteId 序列）
    for (let i = 1; i < segments.length; i += 1) {
      const a = segments[i - 1]?.noteId
      const b = segments[i]?.noteId
      if (a && b) {
        try {
          store.addEdge({ fromId: a, toId: b, kind: 'temporal', conf: 0.8 })
        } catch {}
      }
    }
    return { ok: true, id }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 列出所有笔记（跨视觉分区） */
export function listNotes(store, { limit = 200, onlyUnclustered = false } = {}) {
  if (!store) return []
  const out = []
  for (const zone of NOTE_ZONES) {
    try {
      for (const row of store.listMemories({ zone, limit })) {
        if (String(row.modality) !== 'note') continue
        const meta = noteOf(row)
        if (onlyUnclustered && meta.seriesId) continue
        out.push({ ...row, note: meta })
      }
    } catch {}
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return out.slice(-limit)
}

/** 合并更新 note 的 av_meta（setAvMeta 是整段替换，这里先读再写） */
export function updateNoteMeta(store, id, patch = {}) {
  if (!store) return { ok: false }
  try {
    const row = store.getMemory(id)
    if (!row) return { ok: false, error: 'not-found' }
    const meta = noteOf(row)
    const merged = { ...meta, ...patch }
    store.setAvMeta(id, { avMeta: merged })
    return { ok: true, meta: merged }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * 离线系列聚类：note 累积到 minNotes 条后跑
 * 签名 = 标题 + 角色集合 + 背景描述；相似度 ≥ threshold 的归为一组
 * @returns {{ok:boolean, groups:number, assigned:number, error?:string}}
 */
export async function clusterNotes(store, { embed, minNotes = 20, threshold = 0.85 } = {}) {
  if (!store) return { ok: false, error: 'no-store' }
  if (typeof embed !== 'function') return { ok: false, error: 'no-embed' }
  const notes = listNotes(store, { limit: 500, onlyUnclustered: true })
  if (notes.length < minNotes) return { ok: true, groups: 0, assigned: 0, skipped: notes.length }

  let vecs = []
  try {
    vecs = await embed(
      notes.map((n) => {
        const sig = [n.note.title || '', (n.note.characters || []).join('/'), n.note.background || '']
          .join(' | ')
          .trim()
        return String(sig || n.text || '').slice(0, 500) || String(n.text || '').slice(0, 200)
      }),
    )
  } catch (e) {
    return { ok: false, error: 'embed-failed: ' + String((e && e.message) || e) }
  }
  if (!Array.isArray(vecs) || vecs.length !== notes.length) return { ok: false, error: 'embed-shape' }

  const parent = notes.map((_, i) => i)
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      if (cosine(vecs[i], vecs[j]) >= threshold) union(i, j)
    }
  }
  const groups = new Map()
  for (let i = 0; i < notes.length; i += 1) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }

  let assigned = 0
  let seriesCount = 0
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    seriesCount += 1
    const seriesId = 'series_' + String(notes[idxs[0]].id).slice(4, 14)
    const sorted = idxs.slice().sort((a, b) => String(notes[a].created_at).localeCompare(String(notes[b].created_at)))
    for (const i of sorted) {
      updateNoteMeta(store, notes[i].id, { seriesId })
      assigned += 1
    }
    // episode-order 边：系列内按时间相邻
    for (let k = 1; k < sorted.length; k += 1) {
      try {
        store.addEdge({ fromId: notes[sorted[k - 1]].id, toId: notes[sorted[k]].id, kind: 'episode-order', conf: 0.9 })
      } catch {}
    }
  }
  return { ok: true, groups: seriesCount, assigned }
}

export { NOTE_ZONES }
