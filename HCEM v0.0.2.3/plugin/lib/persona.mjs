// HCEM 角色卡（阶段 5）
// 存储：data/persona/persona.md（AI 自述）、data/persona/用户.md（用户卡）
// 两次会话之间以文件形式独立保存，不写进 SQLite，方便用户直接审阅/编辑。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
export const PERSONA_DIR = process.env.HCEM_PERSONA_DIR || join(DATA_DIR, 'persona')
export const PERSONA_PATH = join(PERSONA_DIR, 'persona.md')
export const USER_CARD_PATH = join(PERSONA_DIR, '用户.md')

// 注入 system prompt 的上限，避免角色卡太长挤占上下文
// 用户卡留给 AI 写，上限更宽（结构可扩展、内容可丰富）
export const PERSONA_MAX_CHARS = 4000
export const USER_CARD_MAX_CHARS = 6000

function readText(path) {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

function writeText(path, text) {
  mkdirSync(PERSONA_DIR, { recursive: true })
  writeFileSync(path, String(text ?? ''), 'utf8')
  return path
}

function truncate(text, max = PERSONA_MAX_CHARS) {
  if (!text) return ''
  const t = String(text).trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

export function loadPersona() {
  return readText(PERSONA_PATH)
}

export function loadUserCard() {
  return readText(USER_CARD_PATH)
}

export function savePersona(text) {
  return writeText(PERSONA_PATH, text)
}

export function saveUserCard(text) {
  return writeText(USER_CARD_PATH, text)
}

// 追加：AI 逐步补全自己/用户，不必每次整段重写（降低覆盖丢失风险）
export function appendPersona(text) {
  const current = loadPersona()
  const add = String(text ?? '').trim()
  return writeText(PERSONA_PATH, current ? `${current}\n\n${add}` : add)
}

export function appendUserCard(text) {
  const current = loadUserCard()
  const add = String(text ?? '').trim()
  return writeText(USER_CARD_PATH, current ? `${current}\n\n${add}` : add)
}

// 局部编辑：find 必须唯一匹配；replace 留空 = 删除该片段（防止整卡被撑爆）
function tidy(text) {
  return String(text).replace(/\n{3,}/g, '\n\n').trimEnd()
}

function editCard(path, find, replace) {
  const current = readText(path)
  if (!current) return { ok: false, error: 'card-empty' }
  const f = String(find ?? '')
  if (!f.trim()) return { ok: false, error: 'empty-find' }
  const count = current.split(f).length - 1
  if (count === 0) return { ok: false, error: 'not-found' }
  if (count > 1) return { ok: false, error: 'ambiguous', count }
  const replacement = String(replace ?? '')
  const next = tidy(current.replace(f, replacement))
  writeText(path, next)
  return { ok: true, removed: replacement.trim().length === 0, length: next.length }
}

export function editPersona(find, replace) {
  return editCard(PERSONA_PATH, find, replace)
}

export function editUserCard(find, replace) {
  return editCard(USER_CARD_PATH, find, replace)
}

// 拼装注入文本：角色卡在前，用户卡在后；都没有时返回空串（不注入）
export function personaPrompt({ persona, userCard } = {}) {
  const p = truncate(persona, PERSONA_MAX_CHARS)
  const u = truncate(userCard, USER_CARD_MAX_CHARS)
  if (!p && !u) return ''
  const parts = [
    '[HCEM 角色卡] 以下内容是你自己的设定，按它说话与行事；它优先于一般助手默认风格，但不优先于安全阀。这份卡你可以自己改（工具 hcem_persona_write，mode=replace 整段替换 / mode=append 追加），改完立即生效。',
  ]
  if (p) parts.push(p)
  if (u) parts.push(`[HCEM 用户卡] 以下是你记得的用户信息（可能不全，可随对话补充）：\n${u}`)
  return parts.join('\n\n')
}