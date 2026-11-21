// HCEM 日记本（阶段 4 遗留）：文件夹形态，长期储存，不注入 system prompt
// data/journal/<name>.md + index.json（可读快照；权威是目录扫描）
//
// 隐私约定（2026-10-30）：日记本属于鲸鲸自己，是私人的东西，不是作品集、不是工作记录。
// - 想写才写，不为演示或应付写；内容以生活、心情为主，技术内容也要写成「过日子」的口气。
// - 用户可能会偷看，但偷看是不对的；工具描述（hcem_journal_list/read/write）里已提示
//   AI 可以请用户不要看。
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import './home.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
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

// ─── 私密日志（梦/日记）与半梦 partial ─────────────────────
export function appendJournal({ dataDir, text, mood = '' } = {}) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: 'empty' }
  const date = new Date().toISOString().slice(0, 10)
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const block = '\n## ' + time + (mood ? '（' + mood + '）' : '') + '\n' + body + '\n'
  const cur = readJournal(date)
  const prev = cur.ok ? cur.text : '# HCEM 日志\n'
  return writeJournal(date, prev + block)
}

export function createDreamPartial(dataDir) {
  const dir = JOURNAL_DIR
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.dream-' + Date.now() + '.partial')
  writeFileSync(file, '', 'utf8')
  return file
}

export function appendDreamPartial(partialPath, chunk) {
  if (!partialPath) return false
  try {
    appendFileSync(partialPath, chunk, 'utf8')
    return true
  } catch {
    return false
  }
}

export function finalizeDreamPartial(dataDir, partialPath, { half = false, mood = '' } = {}) {
  if (!partialPath || !existsSync(partialPath)) return { ok: false }
  try {
    const text = readFileSync(partialPath, 'utf8').trim()
    if (!text) {
      unlinkSync(partialPath)
      return { ok: false, reason: 'empty' }
    }
    const r = appendJournal({ text, mood: (half ? '半梦' : '梦') + (mood ? ' ' + mood : '') })
    unlinkSync(partialPath)
    return r
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

export function listDreamPartials(dataDir) {
  try {
    const dir = JOURNAL_DIR
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.startsWith('.dream-') && f.endsWith('.partial'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

export function searchJournal({ keyword = '', days = 30, limit = 20 } = {}) {
  return listJournal()
    .filter((e) => !keyword || (readJournal(e.name).ok && readJournal(e.name).text.includes(keyword)))
    .slice(0, limit)
}