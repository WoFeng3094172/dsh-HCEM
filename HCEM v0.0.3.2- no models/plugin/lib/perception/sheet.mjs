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
/**
 * 在拼好的图上给每格左上角烧时间戳（0.0s / 1.2s ...）
 * 用 System.Drawing，不依赖 ffmpeg 的 drawtext/fontconfig。
 */
function burnOneLabel(imagePath, label) {
  const safe = String(imagePath).replace(/'/g, "''")
  const text = String(label || '').replace(/'/g, "''")
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${safe}')
$bmp = New-Object System.Drawing.Bitmap $img
$img.Dispose()
$g = [System.Drawing.Graphics]::FromImage($bmp)
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
$fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 220, 0))
$font = New-Object System.Drawing.Font('Arial', 18, [System.Drawing.FontStyle]::Bold)
$g.FillRectangle($bg, 4, 4, 78, 28)
$g.DrawString('${text}', $font, $fg, 8, 8)
$bmp.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000 }, () => resolve(true))
  })
}

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
    const ff = ffmpegPath()
    for (let i = 0; i < list.length; i += 1) {
      const dest = join(tmpDir, `f${String(i).padStart(4, '0')}.png`)
      // 先统一尺寸：不同分辨率的输入会让 ffmpeg 重置 tile，只拼出几格
      const normalize = [
        '-y', '-i', list[i],
        // cover：放大到铺满再居中裁，宁可裁边也不留灰条
        '-vf', `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH}`,
        '-frames:v', '1', dest,
      ]
      try {
        await run(ff, normalize, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
      } catch {
        // 归一化失败就退回直接复制（至少不丢帧）
        try { copyFileSync(list[i], dest) } catch {}
      }
      if (Array.isArray(opts.labels) && opts.labels[i]) {
        try {
          await burnOneLabel(dest, opts.labels[i])
        } catch {}
      }
    }
    const args = [
      '-y',
      '-framerate', '1',
      '-i', join(tmpDir, 'f%04d.png'),
      '-vf', `tile=${layout.cols}x${layout.rows}:padding=4:color=0x121214`,
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


/**
 * 在故事板底部加一条「声音时间轴」，和宫格共用同一段起止时间。
 * 用 ffmpeg 的 drawbox 画分类色块：voice 青、music 紫、scene 灰。
 * 不是波形，但能把「第几格 / 什么时候有声音」直接对上。
 */
export async function addAudioStrip(sheetPath, { outPath, width, height, timeStart, timeEnd, audios = [], cells = [] } = {}) {
  if (!sheetPath || !(timeEnd > timeStart)) return ''
  const list = (Array.isArray(audios) ? audios : []).filter((a) => Number(a.end) > timeStart && Number(a.ts) < timeEnd)
  if (list.length === 0) return ''
  const stripH = Math.max(26, Math.round(width * 0.045))
  const span = timeEnd - timeStart
  const colorOf = (kind) => (kind === 'voice' ? '0x3fb8af' : kind === 'music' ? '0x9b7bd6' : '0x4a4a52')
  const boxes = []
  for (const a of list) {
    const x = Math.max(0, Math.round(((Number(a.ts) - timeStart) / span) * width))
    const w = Math.max(2, Math.round(((Number(a.end) - Number(a.ts)) / span) * width))
    boxes.push(`drawbox=x=${x}:y=0:w=${Math.min(w, width - x)}:h=${stripH}:color=${colorOf(a.kind)}@0.9:t=fill`)
  }
  // 每格边界：细暗线，方便数格子
  for (const c of cells || []) {
    const x = Math.max(0, Math.min(width - 1, Math.round(((Number(c.t_start) - timeStart) / span) * width)))
    boxes.push(`drawbox=x=${x}:y=0:w=1:h=${stripH}:color=0x2a2a2e@0.9:t=fill`)
  }
  const strip = outPath + '.strip.png'
  const ff = ffmpegPath()
  try {
    await run(ff, [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x0b0b0d:s=${width}x${stripH}:d=1`,
      '-vf', boxes.join(','),
      '-frames:v', '1',
      strip,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    await run(ff, [
      '-y',
      '-i', sheetPath,
      '-i', strip,
      '-filter_complex', 'vstack=inputs=2',
      outPath,
    ], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    try { unlinkSync(strip) } catch {}
    return outPath
  } catch {
    return ''
  }
}
