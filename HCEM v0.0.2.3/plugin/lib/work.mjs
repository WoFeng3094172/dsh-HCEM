// HCEM 工作记忆（冷存子分区）：文件组，记录用户交代的工作
// data/zones/cold/work/<标题>.md；不压缩，软上限触发「快满了」提醒
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
export const WORK_DIR = process.env.HCEM_WORK_DIR || join(DATA_DIR, 'zones', 'cold', 'work')
export const WORK_SOFT_MAX = 20000 // 工作笔记总量（字符）软上限
const NAME_MAX = 40
const NAME_PATTERN = /^[\w\u4e00-\u9fa5·\-（）() ]+$/

export function safeWorkName(name) {
  const raw = String(name ?? '').trim().replace(/\.md$/i, '')
  if (!raw || raw.length > NAME_MAX) return null
  if (raw.startsWith('.') || !NAME_PATTERN.test(raw)) return null
  return raw
}

export function listWork() {
  mkdirSync(WORK_DIR, { recursive: true })
  const out = []
  for (const file of readdirSync(WORK_DIR)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const p = join(WORK_DIR, file)
    try {
      const text = readFileSync(p, 'utf8')
      out.push({ name: file.slice(0, -3), chars: text.length, updatedAt: statSync(p).mtime.toISOString() })
    } catch {}
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return out
}

export function readWork(name) {
  const n = safeWorkName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  try {
    const text = readFileSync(join(WORK_DIR, `${n}.md`), 'utf8')
    return { ok: true, name: n, text, chars: text.length }
  } catch {
    return { ok: false, name: n, error: 'not-found' }
  }
}

export function writeWork(name, text, mode = 'append') {
  const n = safeWorkName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  mkdirSync(WORK_DIR, { recursive: true })
  const p = join(WORK_DIR, `${n}.md`)
  const add = String(text ?? '')
  let next = add
  if (mode === 'append') {
    let prev = ''
    try { prev = readFileSync(p, 'utf8') } catch {}
    next = prev.trim() ? `${prev.trimEnd()}\n\n${add.trim()}` : add
  }
  writeFileSync(p, next, 'utf8')
  const usage = workUsage()
  return {
    ok: true,
    name: n,
    chars: next.length,
    usage,
    ...(usage.ratio >= 0.75 ? { warning: '我的工作笔记快满了，需要删掉不重要工作内容了。' } : {}),
  }
}

export function workTotalChars() {
  return listWork().reduce((sum, w) => sum + w.chars, 0)
}

export function workUsage() {
  const chars = workTotalChars()
  return { chars, max: WORK_SOFT_MAX, ratio: Math.min(1, chars / WORK_SOFT_MAX) }
}