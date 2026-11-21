// 拼图（自适应布局，借鉴 dsh-video-storyboard 的 bestLayout + sheet）
// 把多张帧拼成 cols×rows 的网格图（多余位置补灰），供「低变化段粗判」或「可寻址网格」用。
// 依赖 ffmpeg（tools 目录已内置）。
import { execFile } from 'node:child_process'
import '../home.mjs'
import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const FFMPEG_CANDIDATES = [
  process.env.HCEM_FFMPEG,
  join(`${globalThis.__HCEM_HOME__}`, 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe'),
  'ffmpeg',
]

function ffmpegPath() {
  for (const p of FFMPEG_CANDIDATES) {
    if (p && (p === 'ffmpeg' || existsSync(p))) return p
  }
  return 'ffmpeg'
}

/**
 * 自适应布局：枚举 cols×rows（容量 ≥ n），选画布比例最接近源比例的行列
 * @param {number} n 格数
 * @param {number} [aspect=16/9] 源宽高比
 */
export function bestLayout(n, aspect = 16 / 9) {
  const count = Math.max(1, Number(n) || 1)
  let best = { cols: 1, rows: count, score: Infinity }
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols)
    const canvasAspect = (cols / rows) * aspect // 单元格 16:9 时画布比例
    const score = Math.abs(canvasAspect - aspect)
    if (score < best.score) best = { cols, rows, score }
  }
  return { cols: best.cols, rows: best.rows, capacity: best.cols * best.rows }
}

/**
 * 拼图：frames（图片路径数组，按时间序）→ 输出拼图文件
 * @param {string[]} frames
 * @param {object} opts { outPath, cols, rows, cellWidth, cellHeight }
 * @returns {Promise<{ok:boolean, path?:string, layout?:object, error?:string}>}
 */
export async function buildSheet(frames, opts = {}) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => typeof f === 'string' && existsSync(f))
  if (list.length === 0) return { ok: false, error: 'no frames' }
  const layout = opts.cols && opts.rows ? { cols: opts.cols, rows: opts.rows, capacity: opts.cols * opts.rows } : bestLayout(list.length)
  const outPath = opts.outPath || join(dirname(list[0]), `sheet-${Date.now()}.png`)
  const cellW = Number(opts.cellWidth) || 320
  const cellH = Number(opts.cellHeight) || 180
  const tmpDir = join(dirname(outPath), `.sheet-tmp-${Date.now()}`)
  try {
    mkdirSync(tmpDir, { recursive: true })
    for (let i = 0; i < list.length; i += 1) {
      copyFileSync(list[i], join(tmpDir, `f${String(i).padStart(4, '0')}.png`))
    }
    const ff = ffmpegPath()
    const args = [
      '-y',
      '-framerate', '1',
      '-i', join(tmpDir, 'f%04d.png'),
      '-vf', `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x2a2a2e,tile=${layout.cols}x${layout.rows}:padding=4:color=0x121214`,
      '-frames:v', '1',
      outPath,
    ]
    await run(ff, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, path: outPath, layout }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    try {
      for (const f of readdirSync(tmpDir)) {
        try { unlinkSync(join(tmpDir, f)) } catch {}
      }
      rmdirSync(tmpDir)
    } catch {}
  }
}
