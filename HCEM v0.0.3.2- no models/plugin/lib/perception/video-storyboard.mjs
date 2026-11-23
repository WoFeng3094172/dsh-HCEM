// 视频 storyboard（拆自 dsh-video-storyboard，MIT）：视频文件 → 镜头切分 → 代表帧网格
// 依赖 ffmpeg/ffprobe（视频文件分析需要；实时屏幕监视不需要）
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { segmentsFromCuts, fitSegments } from './storyboard/segments.js'
import { densityCurve, planCellRanges } from './storyboard/density.js'
import { buildCandidates, scoreCandidates, selectWithCoverage } from './storyboard/candidates.js'
import { DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './storyboard/probe.js'

const run = promisify(execFile)

/** 检查 ffmpeg 是否可用 */
export async function ffmpegAvailable() {
  try {
    await run(DEFAULT_FFPROBE, ['-version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * 分析视频文件（镜头切分 + 代表帧）
 * @param {string} videoPath
 * @param {object} opts { maxCells: 目标格数 }
 * @returns {Promise<{ok:boolean, duration?:number, segments?:Array, cells?:Array, error?:string}>}
 */
export async function analyzeVideoStoryboard(videoPath, opts = {}) {
  const ok = await ffmpegAvailable()
  if (!ok) {
    return { ok: false, error: 'ffmpeg/ffprobe 未安装（视频文件分析需要）' }
  }
  const maxCells = Math.max(4, Math.min(48, Number(opts.maxCells) || 16))
  try {
    // 1) 探测时长
    const { stdout: probeOut } = await run(
      DEFAULT_FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', videoPath],
      { timeout: 15000 },
    )
    const info = JSON.parse(probeOut)
    const duration = Number(info?.format?.duration ?? 0)
    if (!(duration > 0)) return { ok: false, error: '无法读取视频时长' }

    // 2) 切点（ffmpeg scene detect）
    const { stderr } = await run(
      DEFAULT_FFMPEG,
      ['-hide_banner', '-i', videoPath, '-vf', 'select=gt(scene\\,0.3),showinfo', '-f', 'null', '-'],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    ).catch((e) => ({ stderr: String(e?.stderr ?? '') }))
    const cuts = []
    for (const line of String(stderr).split('\n')) {
      const m = line.match(/pts_time:([0-9.]+)/)
      if (m) cuts.push(Number(m[1]))
    }

    // 3) 镜头切分 + 调整到目标格数
    const segs = fitSegments(segmentsFromCuts(duration, cuts, 0.4), maxCells)
    // 4) 候选帧 + 覆盖选择
    const candidates = buildCandidates({ duration, cuts })
    const scored = scoreCandidates(candidates, { duration, cuts })
    const cells = selectWithCoverage(scored, { k: maxCells, duration })
    return { ok: true, duration, segments: segs.length, cuts: cuts.length, cells }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}
