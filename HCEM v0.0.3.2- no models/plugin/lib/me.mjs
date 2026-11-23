// me：persona 的固定第一人称摘要（注入 System Prompt 最前）
// 设计：me = persona 的精简摘要（200-300 字，第一人称，身份锚点）
//      me 绑定 persona 哈希（persona 变 → me 失效/重生成 → KV 缓存重载）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import './home.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__

const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
export const ME_MAX_CHARS = 300

export function mePath(dataDir = DATA_DIR) {
  return join(dataDir, 'persona', 'me.json')
}

/** persona 内容哈希（绑定） */
export function personaHash(personaText) {
  return createHash('sha256').update(String(personaText || '')).digest('hex').slice(0, 16)
}

/** 读 me（带哈希校验） */
export function loadMe(dataDir = DATA_DIR) {
  try {
    const p = mePath(dataDir)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 保存 me */
export function saveMe(dataDir = DATA_DIR, { text, hash }) {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(mePath(dataDir), JSON.stringify({ text, hash, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 生成 me（用 OmniDimen；第一人称/身份锚点/精简）
 * @param {object} opts { personaText, timeoutMs }
 * @returns {Promise<{ok:boolean, text?:string, hash?:string, error?:string}>}
 */
export async function generateMe({ personaText, timeoutMs = 60000 } = {}) {
  const persona = String(personaText || '').trim()
  if (!persona) return { ok: false, error: 'empty persona' }
  const hash = personaHash(persona)
  const prompt = `下面是一份人设（persona）。请用第一人称（"我"）写一段"我是谁"，给未来的自己看。

要求：
- 身份锚点清晰：我是谁 / 我和用户的关系 / 我的说话方式
- 不加润色，语言精简：**严格 ${ME_MAX_CHARS} 字以内**
- 只写摘要，**不要复制人设原文**（原文太长会稀释注意力）
- 不要写成第三人称小传，不要用"她/他"指代自己
- 直接输出这段文字（不要标题、不要解释）

人设：
${persona.slice(0, 2000)}`
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json()
    let text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) return { ok: false, error: 'empty' }
    // 截断（保护）
    if (text.length > ME_MAX_CHARS * 2) text = text.slice(0, ME_MAX_CHARS * 2)
    // 软截断：超 300 字 → 取前 300（保留完整句）
    if (text.length > ME_MAX_CHARS) {
      const cut = text.slice(0, ME_MAX_CHARS)
      const last = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'))
      text = last > 100 ? cut.slice(0, last + 1) : cut
    }
    return { ok: true, text, hash }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/**
 * 确保 me 是最新的（persona 哈希匹配）
 * @returns {Promise<{ok:boolean, me?:object, regenerated?:boolean, error?:string}>}
 */
export async function ensureMe({ dataDir = DATA_DIR, personaText, logger = console } = {}) {
  const hash = personaHash(personaText)
  const cur = loadMe(dataDir)
  if (cur && cur.hash === hash) return { ok: true, me: cur, regenerated: false }
  logger.info?.('[hcem] me 与 persona 不一致，重新生成 me')
  const r = await generateMe({ personaText })
  if (!r.ok) return { ok: false, error: r.error }
  const saved = saveMe(dataDir, { text: r.text, hash })
  return saved.ok ? { ok: true, me: { text: r.text, hash }, regenerated: true } : { ok: false, error: saved.error }
}
