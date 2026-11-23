// OmniDimen 情绪分类（8098）：给前世记忆预打戳用
const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.HCEM_OMNI_TIMEOUT || 15000)

export const LABEL_TO_HUE = {
  快乐: 0, 惊讶: 60, 恐惧: 120, 悲伤: 180, 厌恶: 240, 愤怒: 300,
}

const PROMPT = `判断下面这段文字的主要情绪，只输出一个词：快乐、惊讶、恐惧、悲伤、厌恶、愤怒 之一。不要解释。
文字：`

/**
 * 用 OmniDimen 识别情绪
 * @param {string} text
 * @returns {Promise<{label:string, hue:number}|null>}
 */
export async function classifyWithOmni(text) {
  const t = String(text || '').slice(0, 300)
  if (!t.trim()) return null
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: '你是情绪识别助手，只输出一个情绪词。' },
          { role: 'user', content: PROMPT + t },
        ],
        max_tokens: 16,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = await res.json()
    const out = String(data?.choices?.[0]?.message?.content ?? '').trim()
    for (const [label, hue] of Object.entries(LABEL_TO_HUE)) {
      if (out.includes(label)) return { label, hue }
    }
    return null
  } catch {
    return null
  }
}
