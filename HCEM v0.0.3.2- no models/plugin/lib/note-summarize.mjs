/**
 * 笔记材料摘要（Qwen3-1.7B，8093，CPU）
 *
 * 视频笔记收尾时，材料可能有几十条画面描述 + 声音条；直接拼给模型很难一口气读。
 * 这里做 map-reduce：
 *   1) 每 10 条材料压成一段客观要点
 *   2) 再把要点合并成一段 <= 400 字的笔记
 * 失败返回 ok:false，调用方回退到原始摘要。
 */

const QWEN3_URL = process.env.HCEM_QWEN3_LLM || 'http://127.0.0.1:8093/v1/chat/completions'

async function chat(messages, maxTokens = 400, timeoutMs = 30000) {
  const res = await fetch(QWEN3_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('http-' + res.status)
  const j = await res.json()
  return String(j?.choices?.[0]?.message?.content || '').trim()
}

export async function summarizeNoteMaterials({ descs = [], audios = [], maxChars = 500 } = {}) {
  // 台词/歌词不进摘要模型：模型会改写、删句。原样附在最后。
  // 声音里的“声源/音乐情感/环境”则正常参与摘要，只把引号里的台词剥出来。
  const audioLines = []
  const audioContext = []
  const quoteRe = /[「“"]([^」”"]+)[」”"]/g
  for (const a of audios) {
    const text = String(a.text || '').trim()
    if (!text) continue
    const quotes = [...text.matchAll(quoteRe)].map((m) => m[1].trim()).filter(Boolean)
    audioLines.push(...quotes)
    const rest = text.replace(quoteRe, '').replace(/有人说话[:：]?/g, '').replace(/^[，,。；;\s]+/, '').trim()
    if (rest) audioContext.push('【声音】' + rest.slice(0, 200))
  }
  const uniqLines = [...new Set(audioLines)].slice(0, 12)
  const materials = [
    ...descs.map((d) => '【画面】' + String(d.text || '').slice(0, 240)),
    ...audioContext,
  ].filter(Boolean)
  if (materials.length === 0) {
    if (uniqLines.length > 0) return { ok: true, text: uniqLines.map((x) => '【台词/歌词】' + x).join('\n') }
    return { ok: false, error: 'no-materials' }
  }
  try {
    const chunks = []
    for (let i = 0; i < materials.length; i += 10) chunks.push(materials.slice(i, i + 10))
    const points = []
    for (const chunk of chunks) {
      const text = await chat(
        [
          {
            role: 'system',
            content:
              '你是一个安静的记录者。把给你的画面/声音材料压缩成客观要点，只保留发生了什么；' +
              '不要编造、不要评价、不要用第二人称。每段不超过 200 字。',
          },
          { role: 'user', content: chunk.join('\n') },
        ],
        260,
      )
      if (text) points.push(text)
    }
    if (points.length === 0) return { ok: false, error: 'empty-points' }
    const merged = await chat(
      [
        {
          role: 'system',
          content:
            '把下面的分段要点合并成一段连贯的中文笔记，保留时间顺序和画面/声音的对应关系；' +
            `不超过 ${maxChars} 字，不要编造。`,
        },
        { role: 'user', content: points.join('\n\n') },
      ],
      Math.min(900, Math.max(260, maxChars + 120)),
    )
    if (!merged) return { ok: false, error: 'empty-merged' }
    const head = merged.slice(0, maxChars)
    const tail = uniqLines.length ? '\n【台词/歌词】\n' + uniqLines.join('\n') : ''
    return { ok: true, text: (head + tail).slice(0, 2000) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
