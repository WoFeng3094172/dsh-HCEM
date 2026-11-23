/**
 * 视频摘要：把一段视频的「分镜 → 代表帧 → 拼图 → 精看模型描述」串起来
 *
 * 之前的问题：分镜（镜头切分 + 代表帧时间点）算完了，但**没有真的抽帧**，
 * 也没送视觉模型 → 等于分完就丢。
 *
 * 现在补上后半段：
 *   1. 镜头切分（复用 storyboard 的切点 + 覆盖选帧）
 *   2. ffmpeg 按时间点抽帧
 *   3. 拼成一张九宫格（省 token，一眼看全片）
 *   4. 交给精看模型（Qwen2.5-VL-3B）描述
 *
 * 只处理**视频文件**；实时看屏幕走采集层的「视频窗口 ROI」路径，不经过这里。
 */

import { execFile } from 'node:child_process'
import '../home.mjs'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeVideoStoryboard } from './video-storyboard.mjs'
import { buildSheet } from './sheet.mjs'
import { DEFAULT_FFMPEG } from './storyboard/probe.js'
import { describeImage } from './vision.mjs'

const run = promisify(execFile)

/**
 * 抽帧
 * @param {string} videoPath
 * @param {number[]} cells 时间点（秒）
 * @param {string} outDir
 * @returns {Promise<string[]>} 抽出来的图片路径
 */
async function extractFrames(videoPath, cells, outDir) {
  mkdirSync(outDir, { recursive: true })
  const out = []
  for (let i = 0; i < cells.length; i += 1) {
    const t = Number(cells[i]) || 0
    const p = join(outDir, `c${String(i).padStart(3, '0')}.png`)
    try {
      // -ss 放在 -i 前面是快速定位；短视频精度足够
      await run(
        DEFAULT_FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-1', p],
        { timeout: 20000 },
      )
      if (existsSync(p)) out.push(p)
    } catch {
      // 单帧失败不影响整体
    }
  }
  return out
}

/**
 * 视频转摘要
 * @param {string} videoPath
 * @param {object} opts {
 *   maxCells?: 分镜格数（默认 9，九宫格）
 *   outDir?: 中间产物目录
 *   describe?: 自定义描述函数（默认走精看模型）
 * }
 * @returns {Promise<{ok:boolean, summary?:string, boardPath?:string, duration?:number, frames?:number, error?:string}>}
 */
export async function digestVideo(videoPath, opts = {}) {
  if (!videoPath || !existsSync(videoPath)) return { ok: false, error: '视频文件不存在' }
  const maxCells = Math.max(4, Math.min(16, Number(opts.maxCells) || 9))
  const workDir = opts.outDir || join(process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__, 'video-digest', String(Date.now()))

  try {
    // ① 分镜
    const sb = await analyzeVideoStoryboard(videoPath, { maxCells })
    if (!sb.ok) return { ok: false, error: '分镜失败：' + (sb.error || '未知') }
    const cells = Array.isArray(sb.cells) ? sb.cells : []
    if (cells.length === 0) return { ok: false, error: '没有得到代表帧时间点' }

    // ② 抽帧
    const frames = await extractFrames(videoPath, cells, workDir)
    if (frames.length === 0) return { ok: false, error: '抽帧失败' }

    // ③ 拼图
    const board = await buildSheet(frames, {
      outPath: join(workDir, 'board.png'),
      cellWidth: 320,
      cellHeight: 180,
    })
    const boardPath = board?.path || board?.outPath || ''
    if (!boardPath || !existsSync(boardPath)) return { ok: false, error: '拼图失败' }

    // ④ 精看模型描述
    const describe = typeof opts.describe === 'function' ? opts.describe : (p) => describeImage(p, {
      prompt: '这是视频的分镜拼图，按左到右、上到下。用三到五句概括：主体、发生了什么、氛围。不要重复同一句话。',
      maxTokens: 220,
    })
    // 模型刚拉起时会返回 "Loading model"，这里重试几次（最多 3 次 × 4 秒）
    let d = null
    let summary = ''
    for (let attempt = 0; attempt < 4; attempt += 1) {
      d = await describe(boardPath)
      summary = String(d?.text || '').trim()
      if (summary) break
      const err = String(d?.error || '')
      if (/loading model|loading|not ready|busy/i.test(err)) {
        await new Promise((r) => setTimeout(r, 4000))
        continue
      }
      break
    }
    if (!summary) return { ok: false, error: '描述为空：' + String(d?.error || '未知'), boardPath }

    return {
      ok: true,
      summary,
      boardPath,
      duration: sb.duration,
      frames: frames.length,
      cuts: sb.cuts,
      segments: sb.segments,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    // 中间帧保留（拼图还要看），只清理没有引用的临时目录由上层决定
  }
}

/**
 * 清理旧的视频摘要产物（默认 3 天）
 */
export function cleanupVideoDigest(dataDir, keepDays = 3) {
  try {
    const root = join(dataDir, 'video-digest')
    if (!existsSync(root)) return 0
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000
    let n = 0
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      try {
        const st = statSync(p)
        if (st.mtimeMs < cutoff) {
          rmSync(p, { recursive: true, force: true })
          n += 1
        }
      } catch {}
    }
    return n
  } catch {
    return 0
  }
}
