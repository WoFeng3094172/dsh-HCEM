/**
 * 从一场视频的描述里抽「标题 / 角色 / 背景」
 *
 * 走 Qwen3-1.7B（8093，CPU）：便宜、不需要显存，失败就返回空（note 照样写）。
 * 输出严格 JSON，解析失败不抛错。
 */

const QWEN3_URL = process.env.HCEM_QWEN3_LLM || 'http://127.0.0.1:8093/v1/chat/completions'

export const NOTE_META_PROMPT = `你在整理一段视频的笔记。根据下面的画面描述，只输出一个 JSON：
{"title":"视频标题（没有依据就留空）","characters":["登场角色/人物，最多 8 个"],"background":"故事或时代背景，一句话，没有就留空"}

要求：
- 只输出 JSON，不要解释，不要 markdown 代码块
- 没有依据的字段留空字符串或空数组
- 角色名只写描述里明确出现的，不要编

画面描述：
`

/** 从模型输出里抠出第一个 JSON 对象 */
export function parseNoteMeta(raw) {
  const s = String(raw || '')
  const cleaned = s.replace(/```json/gi, '```').replace(/```/g, '')
  const i = cleaned.indexOf('{')
  if (i < 0) return { title: '', characters: [], background: '' }
  let depth = 0
  let end = -1
  for (let k = i; k < cleaned.length; k += 1) {
    if (cleaned[k] === '{') depth += 1
    else if (cleaned[k] === '}') {
      depth -= 1
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  if (end < 0) return { title: '', characters: [], background: '' }
  try {
    const j = JSON.parse(cleaned.slice(i, end))
    const bad = /(没有依据|留空|视频标题|标题[:：]?$|^无$|^未知$)/i
    const clean = (x) => {
      const t = String(x || '').trim()
      return bad.test(t) ? '' : t
    }
    const characters = Array.isArray(j.characters)
      ? j.characters.map((x) => clean(x)).filter(Boolean).slice(0, 8)
      : []
    return {
      title: clean(j.title).slice(0, 80),
      characters,
      background: clean(j.background).slice(0, 300),
    }
  } catch {
    return { title: '', characters: [], background: '' }
  }
}

/**
 * @param {{descs?:Array<{ts:number,text:string}>, timeoutMs?:number, url?:string}} opts
 * @returns {Promise<{title:string, characters:string[], background:string, ok:boolean, error?:string}>}
 */
export async function extractNoteMeta({ descs = [], timeoutMs = 20000, url = QWEN3_URL } = {}) {
  const empty = { title: '', characters: [], background: '', ok: false }
  const text = (Array.isArray(descs) ? descs : [])
    .map((d) => String(d?.text || '').trim())
    .filter(Boolean)
    .slice(-20)
    .join('\n')
    .slice(0, 3000)
  if (!text) return { ...empty, error: 'no-desc' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: NOTE_META_PROMPT + text }],
        max_tokens: 220,
        temperature: 0.2,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ...empty, error: 'http-' + res.status }
    const j = await res.json()
    const raw = j?.choices?.[0]?.message?.content || ''
    const meta = parseNoteMeta(raw)
    return { ...meta, ok: true }
  } catch (e) {
    return { ...empty, error: String((e && e.message) || e) }
  }
}
