// 视频笔记（Video Notes）：结构化累积，供 Qwen2.5-VL 整合/长片理解
// 结构见 docs/视频笔记设计.md
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const EMPTY_NOTES = Object.freeze({
  version: 1,
  characters: [], // [{ name, arc: [{ time, personality, goal, change }] }]
  scenes: [], // [{ time, location, characters, description }]
  shots: [], // [{ time, type, movement, angle }]
  audio: [], // [{ time, type, mood, lyrics, note }]
  plot: [], // [{ time, event, cause, effect }]
  background: { era: '', setting: '', theme: '' },
  foreshadowing: [],
})

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

/** 笔记文件路径 */
export function notesPath(dataDir, videoId = 'default') {
  return join(dataDir, 'video-notes', `${videoId}.json`)
}

/** 载入笔记（不存在 → 空） */
export function loadNotes(dataDir, videoId = 'default') {
  const p = notesPath(dataDir, videoId)
  if (!existsSync(p)) return clone(EMPTY_NOTES)
  try {
    return { ...clone(EMPTY_NOTES), ...JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    return clone(EMPTY_NOTES)
  }
}

/** 保存笔记 */
export function saveNotes(dataDir, notes, videoId = 'default') {
  const p = notesPath(dataDir, videoId)
  try {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(notes, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 合并「更新补丁」到笔记（Qwen3-0.6B 输出的 diff） */
export function mergeNotes(notes, patch = {}) {
  const out = clone(notes)
  // 角色：按 name 合并（弧光按 time 追加）
  for (const c of patch.characters ?? []) {
    if (!c?.name) continue
    const existing = out.characters.find((x) => x.name === c.name)
    if (!existing) {
      out.characters.push({ name: c.name, arc: c.arc ?? [] })
      continue
    }
    for (const a of c.arc ?? []) {
      if (a?.time && !existing.arc.some((x) => x.time === a.time)) existing.arc.push(a)
    }
  }
  // 场景：按 time 去重
  for (const s of patch.scenes ?? []) {
    if (s?.time && !out.scenes.some((x) => x.time === s.time)) out.scenes.push(s)
  }
  // 镜头
  for (const s of patch.shots ?? []) {
    if (s?.time && !out.shots.some((x) => x.time === s.time)) out.shots.push(s)
  }
  // 音频（含歌词/语气）
  for (const a of patch.audio ?? []) {
    if (a?.time && !out.audio.some((x) => x.time === a.time)) out.audio.push(a)
  }
  // 剧情
  for (const p of patch.plot ?? []) {
    if (p?.time && !out.plot.some((x) => x.time === p.time)) out.plot.push(p)
  }
  // 背景
  if (patch.background) out.background = { ...out.background, ...patch.background }
  // 伏笔
  for (const f of patch.foreshadowing ?? []) {
    if (typeof f === 'string' && !out.foreshadowing.includes(f)) out.foreshadowing.push(f)
  }
  return out
}

/** 笔记摘要（给 VL 整合时读） */
export function notesSummary(notes, maxChars = 2000) {
  const lines = []
  if (notes.characters?.length) {
    for (const c of notes.characters) {
      const arc = (c.arc ?? []).map((a) => `${a.time}:${a.change ?? a.personality ?? ''}`).join(' → ')
      lines.push(`角色 ${c.name} ${arc ? '弧光: ' + arc : ''}`)
    }
  }
  for (const s of notes.scenes ?? []) lines.push(`场景 ${s.time} ${s.location ?? ''} ${s.description ?? ''}`)
  for (const s of notes.shots ?? []) lines.push(`镜头 ${s.time} ${s.type ?? ''} ${s.movement ?? ''} ${s.angle ?? ''}`)
  for (const a of notes.audio ?? []) lines.push(`音频 ${a.time} ${a.type} ${a.mood ?? ''} ${a.lyrics ? '歌词:' + a.lyrics : ''}`)
  for (const p of notes.plot ?? []) lines.push(`剧情 ${p.time} ${p.event ?? ''}`)
  if (notes.background?.era || notes.background?.setting) {
    lines.push(`背景 ${notes.background.era ?? ''} ${notes.background.setting ?? ''} ${notes.background.theme ?? ''}`)
  }
  if (notes.foreshadowing?.length) lines.push(`伏笔 ${notes.foreshadowing.join('、')}`)
  return lines.join('\n').slice(0, maxChars)
}
