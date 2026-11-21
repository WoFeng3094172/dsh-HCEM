// 小模型视觉（P1）：SmolVLM2-500M（Q4_K_M）+ mmproj
// 通过 llama-server（8092，自定义 chat template）的 OpenAI 兼容接口
// 速度约 0.8 秒/次，常驻资源约 480MB
import { readFileSync } from 'node:fs'

export const SMALL_VLM_PORT = Number(process.env.HCEM_SMOLVLM_PORT || 8092)

/**
 * 用 SmolVLM 描述一张图
 * @param {string} imagePath 图片
 * @param {object} opts { prompt, maxTokens, port }
 * @returns {Promise<{ text: string, ms: number, error?: string }>}
 */
export async function describeSmallVlm(imagePath, opts = {}) {
  const prompt = opts.prompt || 'Describe this screen in one or two sentences.'
  const maxTokens = opts.maxTokens ?? 80
  const port = opts.port ?? SMALL_VLM_PORT
  const t0 = Date.now()
  try {
    const b64 = readFileSync(imagePath).toString('base64')
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'smolvlm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
    })
    const data = await res.json()
    if (data?.error) return { text: '', ms: Date.now() - t0, error: String(data.error.message || data.error) }
    return { text: String(data?.choices?.[0]?.message?.content ?? '').trim(), ms: Date.now() - t0 }
  } catch (error) {
    return { text: '', ms: Date.now() - t0, error: String((error && error.message) || error) }
  }
}

/**
 * 描述画面并给出「喜好分」（AI 看视频时的加分依据）
 * 让模型在描述后附一个 0~1 的分数，表示它对这个画面的喜欢程度。
 * @returns {Promise<{text:string, score:number|null, ms:number, error?:string}>}
 */
export async function describeWithScore(imagePath, opts = {}) {
  const prompt =
    opts.prompt ||
    '用一到两句中文描述这个画面。然后在最后一行单独输出一个 0 到 1 之间的数字，表示你有多喜欢这个画面（1 表示很喜欢，0 表示没感觉），只输出数字。'
  const r = await describeSmallVlm(imagePath, { ...opts, prompt, maxTokens: opts.maxTokens ?? 120 })
  if (r.error) return { text: '', score: null, ms: r.ms, error: r.error }
  const raw = String(r.text || '').trim()
  // 取最后一行里的小数
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let score = null
  let text = raw
  if (lines.length > 0) {
    const last = lines[lines.length - 1]
    const m = last.match(/([01](?:\.\d+)?)/)
    if (m && Number(m[1]) <= 1) {
      score = Number(m[1])
      text = lines.slice(0, -1).join('\n').trim() || raw
    }
  }
  return { text, score, ms: r.ms }
}