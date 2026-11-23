// 视觉感知（P1）：Qwen2.5-VL-3B 画面描述 + 局部二次截图
// 依赖：llama-server（Qwen2.5-VL-3B + mmproj）运行在 http://127.0.0.1:8091
// 流程：
//   1. 截图（缩放，默认 1280 宽）→ 描述
//   2. 若描述不清（isUnclear）→ 局部二次截图放大 → 再描述
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreen, listScreens } from '../capture/screen.mjs'
import { listVideoWindows, windowsOnScreen } from '../capture/window.mjs'
import { buildSheet } from './sheet.mjs'
import { FrameFunnel } from './frame-funnel.mjs'
import { frameDiff } from './frame-diff.mjs'

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
  const prompt =
    opts.prompt ||
    '用一两句话描述这张图片的内容（这是什么场景、在做什么）。如果画面里有文字、字幕、歌词、聊天、代码或界面文字，逐字抄录最关键的 1-4 行，不要总结，不要反问用户。'
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

  // 多屏：默认看所有屏幕（用户说“看看我的屏幕”时不该只给主屏）
  let screens = []
  try {
    screens = await listScreens()
  } catch {}
  const wantIndex = Number.isInteger(opts.screenIndex) ? opts.screenIndex : null
  const primary = screens.find((x) => x.primary)?.index ?? 0
  let targets
  if (wantIndex !== null) targets = [wantIndex]
  else if (screens.length > 1) targets = screens.map((x) => x.index)
  else targets = [primary]

  const results = []
  for (const idx of targets) {
    const shot = join(dir, `shot-s${idx}-${Date.now()}.png`)
    const sc = screens.find((x) => x.index === idx)
    if (sc && windowsOnScreen(sc).length === 0) {
      results.push({ screen: idx, text: '（空桌面，已跳过）', image: '', skipped: true })
      continue
    }
    try {
      await captureScreen(shot, { maxWidth: opts.maxWidth ?? 1920, screenIndex: idx })
      const r = await describeImage(shot, opts)
      results.push({ screen: idx, ...r, image: shot })
    } catch (error) {
      results.push({ screen: idx, text: '', error: String((error && error.message) || error), image: shot })
    }
  }
  if (results.length === 1) return results[0]
  const labels = results.map((r, i) => {
    const sc = screens.find((x) => x.index === r.screen)
    const size = sc ? ` ${sc.width}×${sc.height}` : ''
    return `【屏幕${i + 1}（#${r.screen}${size}）】${r.text || '（无描述）'}`
  })
  return {
    ok: results.some((r) => r.text),
    text: labels.join('\n\n'),
    image: results.find((r) => r.text)?.image || results[0]?.image || '',
    images: results.map((r) => r.image),
    screens: results.map((r) => ({ screen: r.screen, ok: !!r.text, error: r.error || '' })),
  }
}

/**
 * 局部二次截图并描述（看不清时放大局部）
 */
/**
 * 看「正在播放的视频」：按窗口枚举找到视频窗口，只截视频区域（带黑边裁剪）
 * 不要求视频窗口在前台——这是“看视频”模式，和桌面监视分开。
 */
export async function describeVideoLive(opts = {}) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data')
  const dir = join(dataDir, 'captures')
  mkdirSync(dir, { recursive: true })
  let wins = []
  try {
    wins = listVideoWindows().slice(0, 2)
  } catch {}
  if (wins.length === 0) return { ok: false, text: '', error: 'no-video-window', screens: [] }
  const results = []
  for (const w of wins) {
    const shot = join(dir, `video-${w.handle}-${Date.now()}.png`)
    try {
      await captureScreen(shot, {
        maxWidth: opts.maxWidth ?? 720,
        region: { left: w.left, top: w.top, width: w.width, height: w.height },
        trimBlack: true,
      })
      const r = await describeImage(shot, opts)
      results.push({ ...r, image: shot, title: w.title, process: w.process, width: w.width, height: w.height })
    } catch (error) {
      results.push({ text: '', error: String((error && error.message) || error), image: shot, title: w.title })
    }
  }
  const okResults = results.filter((r) => r.text)
  if (okResults.length === 0) return { ...results[0], ok: false, screens: results }
  const text = results
    .map((r, i) => `【视频${i + 1}（${r.process || ''}）】${r.text || '（无描述）'}`)
    .join('\n\n')
  return { ok: true, text, image: okResults[0].image, images: results.map((r) => r.image), screens: results }
}

/**
 * 描述画面并给出「喜好分」（AI 看视频时的加分依据）
 * 唯一视觉模型：Qwen2.5-VL-3B（8091）。
 */
export async function describeWithScore(imagePath, opts = {}) {
  const prompt =
    opts.prompt ||
    '用一到两句中文描述这个画面。如果画面里有文字、字幕、歌词、聊天或界面文字，逐字抄录最关键的 1-4 行，不要总结，不要反问用户。然后在最后一行单独输出一个 0 到 1 之间的数字，表示你有多喜欢这个画面（1 表示很喜欢，0 表示没感觉），只输出数字。'
  const r = await describeImage(imagePath, { ...opts, prompt, maxTokens: opts.maxTokens ?? 120 })
  const raw = String(r.text || '').trim()
  if (r.error || !raw) return { text: '', score: null, ms: r.ms || 0, error: r.error || 'empty-description' }
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
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
  return { text, score, ms: r.ms || 0 }
}

/**
 * 看「正在播放的视频」的**多帧分镜**：抓 N 帧 → 拼成一张 storyboard → 一次描述
 * 这是“看视频”与“看屏幕单帧”的区别：hcem_vision(kind=video) 默认走这里。
 */
export async function describeVideoStoryboardLive(opts = {}) {
  const dataDir = opts.dataDir || join(process.cwd(), 'data')
  const dir = join(dataDir, 'captures')
  mkdirSync(dir, { recursive: true })
  const want = Math.max(2, Math.min(16, Number(opts.frames) || 16))
  const gapMs = Math.max(100, Math.min(3000, Number(opts.gapMs) || 500))
  let wins = []
  try {
    wins = listVideoWindows().slice(0, 1)
  } catch {}
  if (wins.length === 0) return { ok: false, text: '', error: 'no-video-window' }
  const w = wins[0]
  const t0 = Date.now()
  // 候选比目标多抓一点，交给 FrameFunnel 按变化选；16 帧时约覆盖 12~16 秒
  const candidates = Math.min(24, Math.max(want + 4, Math.round(want * 1.5)))
  const frames = []
  for (let i = 0; i < candidates; i += 1) {
    const p = join(dir, `sb-${w.handle}-${t0}-${i}.png`)
    try {
      await captureScreen(p, {
        maxWidth: opts.maxWidth ?? 640,
        region: { left: w.left, top: w.top, width: w.width, height: w.height },
        trimBlack: true,
      })
      frames.push({ p, ts: Date.now() })
    } catch {}
    if (i < candidates - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  if (frames.length === 0) return { ok: false, text: '', error: 'capture-failed' }

  // 复用 FrameFunnel 的「变化分 + 段内 top-K」选帧，不再自己写固定间隔抽帧
  const funnel = new FrameFunnel({ windowMs: 600000, baseFps: () => 1 })
  let prev = null
  for (const f of frames) {
    let score = 0
    if (prev) {
      try {
        score = await frameDiff(prev, f.p)
      } catch {}
    }
    funnel.push(f.ts, score)
    prev = f.p
  }
  let picked = funnel.selectFromSegment(funnel.frames)
  if (!picked || picked.length === 0) picked = frames.map((f) => ({ ts: f.ts, score: 0 }))
  if (picked.length > want) {
    const step = (picked.length - 1) / (want - 1)
    picked = Array.from({ length: want }, (_, i) => picked[Math.round(i * step)])
  }
  const byTs = new Map(frames.map((f) => [f.ts, f.p]))
  const selected = picked.map((x) => byTs.get(x.ts)).filter(Boolean)
  if (selected.length < want) {
    for (const f of frames) {
      if (selected.length >= want) break
      if (!selected.includes(f.p)) selected.push(f.p)
    }
  }
  const labels = selected.map((p) => {
    const f = frames.find((x) => x.p === p)
    return ((f ? f.ts - t0 : 0) / 1000).toFixed(1) + 's'
  })
  const sheetPath = join(dir, `sheet-${w.handle}-${t0}.png`)
  // 16 帧默认 4×4；格子缩小到 320×180，整张 1280×720，避免 token 爆掉
  const cols = Number(opts.cols) || (want <= 4 ? 2 : want <= 9 ? 3 : 4)
  const rows = Number(opts.rows) || Math.ceil(want / cols)
  const cellWidth = Number(opts.cellWidth) || (want > 9 ? 320 : 480)
  const cellHeight = Number(opts.cellHeight) || (want > 9 ? 180 : 270)
  const timeStart = t0
  const timeEnd = Date.now()
  const sheet = await buildSheet(selected, {
    outPath: sheetPath,
    cols,
    rows,
    cellWidth,
    cellHeight,
    labels,
  })
  const prompt =
    opts.prompt ||
    `这是一段正在播放的视频按时间顺序抓的 ${selected.length} 帧分镜（左上角是相对时间，从左到右、从上到下）。请用两三句中文说明：几帧之间发生了什么变化。`
  let r
  if (sheet.ok) {
    r = await describeImage(sheet.path, { ...opts, prompt, maxTokens: opts.maxTokens ?? 180 })
  } else {
    const parts = []
    for (const p of selected) {
      const one = await describeImage(p, { ...opts, prompt: '用一句话描述这一帧。', maxTokens: 60 })
      if (one.text) parts.push(one.text)
    }
    r = { text: parts.join('；'), error: parts.length ? '' : 'describe-failed' }
  }
  return {
    ok: Boolean(r.text),
    text: r.text || '',
    image: sheet.ok ? sheet.path : selected[selected.length - 1],
    frames: selected,
    labels,
    timeStart,
    timeEnd,
    cols,
    rows,
    title: w.title,
    process: w.process,
    error: r.error,
  }
}

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
