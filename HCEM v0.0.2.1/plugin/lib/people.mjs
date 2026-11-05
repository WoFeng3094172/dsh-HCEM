// HCEM 人物关系网（冷存子分区）：一个文件装所有人
// data/zones/cold/people.md —— 每个「## 人名」为一个分节
// 卡片字段：性别 / 身份 / 与用户的关系 / 与AI的关系 / AI印象 / 联系方式 / 紧急联系人 / 信任联系人
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
export const PEOPLE_FILE = process.env.HCEM_PEOPLE_FILE || join(DATA_DIR, 'zones', 'cold', 'people.md')
export const PEOPLE_SOFT_MAX = 4000
export const PEOPLE_MAX = 100
export const PEOPLE_NAME_MAX = 40
const NAME_PATTERN = /^[\w\u4e00-\u9fa5·\-（）() ]+$/
const HEADER = '# 人物关系网\n\n> 一人一节，字段：性别 / 身份 / 与用户的关系 / 与AI的关系 / AI印象 / 联系方式 / 紧急联系人 / 信任联系人\n'

export function safePersonName(name) {
  const raw = String(name ?? '').trim().replace(/\.md$/i, '').replace(/^#+\s*/, '')
  if (!raw || raw.length > PEOPLE_NAME_MAX) return null
  if (raw.startsWith('.') || !NAME_PATTERN.test(raw)) return null
  return raw
}

function flag(value) {
  return /^(是|true|yes|y|1)$/i.test(String(value ?? '').trim())
}

function field(body, label) {
  const re = new RegExp(`^-\\s*${label}\\s*[：:]\\s*(.*)$`, 'm')
  return (body.match(re)?.[1] ?? '').trim()
}

export function parsePersonCard(body, name, index = 0) {
  const card = {
    name,
    index,
    gender: field(body, '性别'),
    identity: field(body, '身份'),
    userRelation: field(body, '与用户的关系') || field(body, '关系'),
    aiRelation: field(body, '与AI的关系'),
    impression: field(body, 'AI印象'),
    contact: field(body, '联系方式'),
    emergency: flag(field(body, '紧急联系人')),
    trusted: flag(field(body, '信任联系人')),
    summary: body
      .replace(/^-\s*.+$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
    body,
    chars: body.length,
  }
  card.weight = computeWeight(card)
  return card
}

// 亲密度权重：紧急联系人 > 信任联系人 > 最近更新
export function computeWeight(card) {
  let w = 0
  if (card.emergency) w += 100
  if (card.trusted) w += 50
  const ageDays = card.updatedAt ? (Date.now() - Date.parse(card.updatedAt)) / 86400000 : 999
  w += Math.max(0, 30 - Math.min(30, ageDays))
  return Math.round(w * 10) / 10
}

function readAll() {
  try {
    return readFileSync(PEOPLE_FILE, 'utf8')
  } catch {
    return HEADER
  }
}

// 解析：按「## 人名」分节
export function parsePeople(text) {
  const out = []
  const heads = []
  const re = /^##\s+(.+)$/gm
  let m
  while ((m = re.exec(text))) heads.push({ name: m[1].trim(), index: m.index })
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index + heads[i].name.length + 3 // '## ' + name
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length
    out.push({ name: heads[i].name, body: text.slice(start, end).trim() })
  }
  return out
}

export function listPeople() {
  const text = readAll()
  return parsePeople(text).map((s, i) => {
    const card = parsePersonCard(s.body, s.name, i)
    if (s.body) {
      card.updatedAt = new Date().toISOString()
      card.weight = computeWeight(card)
    }
    return card
  })
}

export function readPerson(name) {
  const n = safePersonName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  const found = parsePeople(readAll()).find((s) => s.name === n)
  if (!found) return { ok: false, name: n, error: 'not-found' }
  const text = `## ${n}\n\n${found.body}`
  return { ok: true, name: n, text, chars: text.length, card: parsePersonCard(found.body, n) }
}

// 写/追加某人：replace 覆盖该节，append 追加到该节末尾
export function writePerson(name, text, mode = 'replace') {
  const n = safePersonName(name)
  if (!n) return { ok: false, name: String(name ?? ''), error: 'invalid-name' }
  mkdirSync(dirname(PEOPLE_FILE), { recursive: true })
  const current = readAll()
  const sections = parsePeople(current)
  const add = String(text ?? '').trim()
  let next
  const existing = sections.find((s) => s.name === n)

  if (existing) {
    const body = mode === 'append' ? (existing.body ? `${existing.body}\n\n${add}` : add) : add
    next = current.replace(
      new RegExp(`^##\\s+${escapeRegExp(n)}\\s*$[\\s\\S]*?(?=^##\\s|\\s*$)`, 'm'),
      `## ${n}\n\n${body}\n\n`,
    )
  } else {
    next = current.trimEnd() + `\n\n## ${n}\n\n${add}\n`
  }

  // 超上限时按权重淘汰
  const after = parsePeople(next)
  if (after.length > PEOPLE_MAX) {
    const ranked = after.map((s, i) => parsePersonCard(s.body, s.name, i)).sort((a, b) => b.weight - a.weight)
    const keep = new Set(ranked.slice(0, PEOPLE_MAX).map((c) => c.name))
    next = HEADER + after.filter((s) => keep.has(s.name)).map((s) => `## ${s.name}\n\n${s.body}\n`).join('\n')
  }

  writeFileSync(PEOPLE_FILE, next, 'utf8')
  return {
    ok: true,
    name: n,
    chars: add.length,
    ...(next.length > PEOPLE_SOFT_MAX
      ? { warning: `人物关系网 ${next.length} 字，超过软上限 ${PEOPLE_SOFT_MAX}；建议精简` }
      : {}),
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 兼容旧版：旧版是 people/ 目录下的一人一文件
export function migrateLegacyPeople(legacyDir) {
  try {
    if (!legacyDir || !statSync(legacyDir).isDirectory()) return 0
    const files = readdirSync(legacyDir).filter((f) => f.toLowerCase().endsWith('.md'))
    if (files.length === 0) return 0
    let text = readAll()
    for (const file of files) {
      const name = file.slice(0, -3)
      const body = readFileSync(join(legacyDir, file), 'utf8').trim()
      if (!text.includes(`## ${name}`)) text += `\n## ${name}\n\n${body}\n`
    }
    writeFileSync(PEOPLE_FILE, text, 'utf8')
    return files.length
  } catch {
    return 0
  }
}
