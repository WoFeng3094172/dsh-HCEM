// HCEM 日记本（阶段 4 遗留）：文件夹形态，长期储存，不注入 system prompt
// data/journal/<name>.md + index.json（可读快照；权威是目录扫描）
//
// 隐私约定（2026-10-30）：日记本属于鲸鲸自己，是私人的东西，不是作品集、不是工作记录。
// - 想写才写，不为演示或应付写；内容以生活、心情为主，技术内容也要写成「过日子」的口气。
// - 用户可能会偷看，但偷看是不对的；工具描述（hcem_journal_list/read/write）里已提示
//   AI 可以请用户不要看。
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
export const JOURNAL_DIR = process.env.HCEM_JOURNAL_DIR || join(DATA_DIR, 'journal')
export const JOURNAL_SOFT_MAX = 8000
export const JOURNAL_NAME_MAX = 60
const NAME_PATTERN = /^[\w\u4e00-\u9fa5·\-（）() ]+$/

export function safeJournalName(name) {
  const raw = String(name ?? '').trim().replace(/\.md$/i, '')
  if (!raw || raw.length > JOURNAL_NAME_MAX) return null
  if (raw.startsWith('.') || !NAME_PATTERN.test(raw)) return null
  return raw
}

function pathOf(name) {
  return join(JOURNAL_DIR, `${name}.md`)
}

export function readJournal(name) {
  const n = safeJournalName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  try {
    const text = readFileSync(pathOf(n), 'utf8')
    return { ok: true, name: n, text, chars: text.length }
  } catch {
    return { ok: false, name: n, error: 'not-found' }
  }
}

export function writeJournal(name, text, mode = 'replace') {
  const n = safeJournalName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  mkdirSync(JOURNAL_DIR, { recursive: true })
  const p = pathOf(n)
  const add = String(text ?? '')
  let next = add
  if (mode === 'append') {
    let prev = ''
    try {
      prev = readFileSync(p, 'utf8')
    } catch {
      // 新文件
    }
    next = prev.trim() ? `${prev.trimEnd()}\n\n${add.trim()}` : add
  }
  writeFileSync(p, next, 'utf8')
  refreshIndex()
  return {
    ok: true,
    name: n,
    chars: next.length,
    ...(next.length > JOURNAL_SOFT_MAX
      ? { warning: `单篇 ${next.length} 字，超过软上限 ${JOURNAL_SOFT_MAX}；建议另起一篇（如换个日期名）` }
      : {}),
  }
}

export function listJournal() {
  mkdirSync(JOURNAL_DIR, { recursive: true })
  const out = []
  for (const file of readdirSync(JOURNAL_DIR)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const name = file.slice(0, -3)
    const p = join(JOURNAL_DIR, file)
    try {
      const text = readFileSync(p, 'utf8')
      const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? name).trim()
      const body = text.replace(/^#\s+.+$/m, '').replace(/\s+/g, ' ').trim()
      out.push({
        name,
        title,
        summary: body.slice(0, 120),
        chars: text.length,
        updatedAt: statSync(p).mtime.toISOString(),
      })
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return out
}

export function refreshIndex() {
  try {
    mkdirSync(JOURNAL_DIR, { recursive: true })
    writeFileSync(
      join(JOURNAL_DIR, 'index.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: listJournal() }, null, 2),
      'utf8',
    )
  } catch {
    // ignore
  }
}