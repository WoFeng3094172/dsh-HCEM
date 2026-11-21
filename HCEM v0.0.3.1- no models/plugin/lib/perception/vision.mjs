// 视觉感知（P1）：Qwen2.5-VL-3B 画面描述 + 局部二次截图
// 依赖：llama-server（Qwen2.5-VL-3B + mmproj）运行在 http://127.0.0.1:8091
// 流程：
//   1. 截图（缩放，默认 1280 宽）→ 描述
//   2. 若描述不清（isUnclear）→ 局部二次截图放大 → 再描述
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreen } from '../capture/screen.mjs'

export const VL_PORT = Number(process.env.HCEM_VL_PORT || 8091)
export const VL4B_PORT = Number(process.env.HCEM_VL4B_PORT || 8091) // 深析也走同一模型

export function isUnclear(text) {
  const t = String(text ?? '').trim()
  if (t.length < 8) return true
  return /看不清|模糊|无法识别|不清楚|抱歉/.test(t)
}

async function imageToBase64(imagePath) {
  return readFileSync(imagePath).toString('base64')
}

/**
 * 描述一张图片（Qwen2.5-VL-3B）
 * @param {string} imagePath
 * @param {object} opts { prompt, maxTokens, port }
 * @returns {Promise<{ text: string, ms: number, error?: string }>}
 */
export async function describeImage(imagePath, opts = {}) {
  const prompt = opts.prompt || '用一两句话描述这张图片的内容（这是什么场景、在做什么）。'
  const maxTokens = opts.maxTokens ?? 120
  const port = opts.port ?? VL_PORT
  const t0 = Date.now()
  try {
    const b64 = await imageToBase64(imagePath)
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen25vl',
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
      }),
    })
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content ?? ''
    if (data?.error) return { text: '', ms: Date.now() - t0, error: String(data.error.message || data.error) }
    return { text: String(text).trim(), ms: Date.now() - t0 }
  } catch (error) {
    return { text: '', ms: Date.now() - t0, error: String((error && error.message) || error) }
  }
}

/**
 * 截图并描述（全屏，缩放）
 */
export async function describeScreen(opts = {}) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data')
  const dir = join(dataDir, 'captures')
  mkdirSync(dir, { recursive: true })
  const shot = join(dir, `shot-${Date.now()}.png`)
  await captureScreen(shot, { maxWidth: opts.maxWidth ?? 1280 })
  const r = await describeImage(shot, opts)
  return { ...r, image: shot }
}

/**
 * 局部二次截图并描述（看不清时放大局部）
 */
export async function zoomDescribe(region, opts = {}) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data')
  const dir = join(dataDir, 'captures')
  mkdirSync(dir, { recursive: true })
  const shot = join(dir, `zoom-${Date.now()}.png`)
  await captureScreen(shot, { maxWidth: opts.maxWidth ?? 1280, region })
  const r = await describeImage(shot, opts)
  return { ...r, image: shot }
}

/**
 * 带二次截图的描述：先全屏，若不清再局部
 * @param {object} opts { maxWidth, region, dataDir }
 */
export async function describeWithFallback(opts = {}) {
  const first = await describeScreen(opts)
  if (!isUnclear(first.text)) return { ...first, zoomed: false }
  if (!opts.region) return { ...first, zoomed: false }
  const second = await zoomDescribe(opts.region, opts)
  return { ...(isUnclear(second.text) ? first : second), zoomed: true, first }
}

/**
 * 用 Qwen2.5-VL-3B（8091）做深度描述（原 Qwen3.5-4B 模型缺失，已合并）
 * @param {string} imagePath
 * @param {object} opts { prompt, maxTokens, port }
 */
export async function describeWith4B(imagePath, opts = {}) {
  const prompt = opts.prompt || '详细描述这张画面：人物、动作、场景、文字。'
  const maxTokens = opts.maxTokens ?? 256
  const port = opts.port ?? VL4B_PORT
  const t0 = Date.now()
  try {
    const b64 = readFileSync(imagePath).toString('base64')
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen25vl',
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
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    const data = await res.json()
    if (data?.error) return { text: '', ms: Date.now() - t0, error: String(data.error.message || data.error) }
    return { text: String(data?.choices?.[0]?.message?.content ?? '').trim(), ms: Date.now() - t0 }
  } catch (error) {
    return { text: '', ms: Date.now() - t0, error: String((error && error.message) || error) }
  }
}
