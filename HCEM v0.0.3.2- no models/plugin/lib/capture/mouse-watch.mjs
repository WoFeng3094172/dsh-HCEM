// 鼠标巡逻：桌面监视开启时，用户在某个区域快速划鼠标超过 3 秒 → 看一眼那块区域
//
// 设计（用户定）：
//   · 只在「桌面监视」开着时启用
//   · 鼠标在一块区域内快速移动持续 3 秒 → 触发一次截图
//   · 截那块区域及周围（有窗口就截窗口）
//   · 不是一直看：触发后进入冷却 3~5 分钟
//   · 冷却时长由「截图内容」和「L 值」决定：
//       - 和上次内容重复（重复工作）→ 冷却更长
//       - L 值低（消沉/不自信）→ 冷却更长
//
// 实现：PowerShell 常驻输出坐标（每 100ms 一行），这里流式读取并做判定。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PS_SCRIPT = join(__dirname, 'mouse-pos.ps1')

/** 默认参数 */
export const DEFAULTS = Object.freeze({
  sampleMs: 100, // 采样间隔
  triggerMs: 3000, // 快速移动持续多久触发
  speedThreshold: 260, // 像素/秒（低于这个算"慢慢挪"）
  areaSlackPx: 60, // 区域向外扩多少（"及周围"）
  regionMinPx: 220, // 区域最小边长
  cooldownBaseMs: 180000, // 基础冷却 3 分钟
  cooldownMaxMs: 300000, // 冷却上限 5 分钟
  cooldownRepeatMs: 120000, // 内容重复额外加 2 分钟
  cooldownLowLMs: 60000, // L 低额外加 1 分钟
  lowL: 40, // L 低于这个算"低"
})

/**
 * 创建鼠标巡逻器
 * @param {object} opts {
 *   getL?: () => number,                    当前 L 值
 *   onChange?: (region) => void,            触发时回调（region = {left,top,width,height}）
 *   logger?: object,
 *   以及 DEFAULTS 里的任意覆盖项
 * }
 */
export function createMousePatrol(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const getL = typeof opts.getL === 'function' ? opts.getL : () => 55
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {}
  const logger = opts.logger || console

  let child = null
  let buf = ''
  let running = false

  /** 最近采样点 */
  let samples = []
  /** 当前这轮"快速移动"的累计时长 */
  let fastMs = 0
  /** 冷却截止时间 */
  let cooldownUntil = 0
  /** 上次触发的描述（用于判断内容是否重复） */
  let lastDescription = ''
  /** 统计 */
  const stats = { triggered: 0, skippedCooldown: 0, samples: 0 }

  function resetSamples() {
    samples = []
    fastMs = 0
  }

  /** 处理一个坐标点 */
  function onPoint(x, y) {
    stats.samples += 1
    const now = Date.now()

    // 冷却中：只记录位置，不判定
    if (now < cooldownUntil) {
      stats.skippedCooldown += 1
      resetSamples()
      return
    }

    samples.push({ x, y, t: now })
    // 只保留最近 4 秒的样本
    const keepFrom = now - cfg.triggerMs - 1000
    while (samples.length > 0 && samples[0].t < keepFrom) samples.shift()
    if (samples.length < 2) return

    // 算最近一段的移动速度
    const prev = samples[samples.length - 2]
    const dt = Math.max(1, now - prev.t)
    const dist = Math.hypot(x - prev.x, y - prev.y)
    const speed = (dist / dt) * 1000 // 像素/秒

    // 算这 4 秒内轨迹的包围盒
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const s of samples) {
      if (s.x < minX) minX = s.x
      if (s.x > maxX) maxX = s.x
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
    const boxW = maxX - minX
    const boxH = maxY - minY
    // 「在一块区域」= 包围盒不能太大（不是全屏乱飞）
    const inArea = boxW <= 900 && boxH <= 700

    if (speed >= cfg.speedThreshold && inArea) {
      fastMs += dt
    } else {
      // 慢下来或跑出区域 → 重新计时
      fastMs = Math.max(0, fastMs - dt * 2)
    }

    if (fastMs >= cfg.triggerMs) {
      // 触发一次
      fastMs = 0
      const region = expandRegion(minX, minY, boxW, boxH, cfg)
      const cooldown = computeCooldown({ description: '', L: Number(getL()) || 55, cfg, lastDescription })
      cooldownUntil = now + cooldown
      stats.triggered += 1
      logger.info?.(`[鼠标巡逻] 触发第 ${stats.triggered} 次，区域 ${region.width}×${region.height}，冷却 ${Math.round(cooldown / 1000)}s`)
      samples = []
      try {
        onChange({ region, cooldownMs: cooldown, at: now })
      } catch (e) {
        logger.warn?.(`[鼠标巡逻] 回调失败: ${(e && e.message) || e}`)
      }
    }
  }

  function start() {
    if (running) return { ok: true, already: true }
    if (!existsSync(PS_SCRIPT)) return { ok: false, error: 'mouse-pos.ps1 不存在' }
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      running = true
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buf += chunk
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() || ''
        for (const line of lines) {
          const m = line.trim().match(/^(-?\d+),(-?\d+)$/)
          if (m) onPoint(Number(m[1]), Number(m[2]))
        }
      })
      child.on('exit', () => {
        running = false
        child = null
        resetSamples()
      })
      logger.info?.('[鼠标巡逻] 已启动')
      return { ok: true }
    } catch (e) {
      running = false
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  function stop() {
    running = false
    resetSamples()
    if (child) {
      try {
        child.kill()
      } catch {}
      child = null
      logger.info?.('[鼠标巡逻] 已停止')
    }
    return { ok: true }
  }

  /** 把区域向外扩，并保证最小尺寸，同时夹在屏幕内 */
  function expandRegion(x, y, w, h, c) {
    const slack = c.areaSlackPx
    let left = Math.round(x - slack)
    let top = Math.round(y - slack)
    let width = Math.round(w + slack * 2)
    let height = Math.round(h + slack * 2)
    if (width < c.regionMinPx) {
      left -= Math.round((c.regionMinPx - width) / 2)
      width = c.regionMinPx
    }
    if (height < c.regionMinPx) {
      top -= Math.round((c.regionMinPx - height) / 2)
      height = c.regionMinPx
    }
    if (left < 0) {
      width += left
      left = 0
    }
    if (top < 0) {
      height += top
      top = 0
    }
    return { left, top, width: Math.max(1, width), height: Math.max(1, height) }
  }

  return {
    start,
    stop,
    status: () => ({
      running,
      triggered: stats.triggered,
      cooldownLeftMs: Math.max(0, cooldownUntil - Date.now()),
      fastMs,
      samples: stats.samples,
    }),
    /** 供外部：拿到本次触发的描述后回填，用于下次判断"重复工作" */
    noteDescription: (desc) => {
      lastDescription = String(desc || '').slice(0, 200)
    },
  }
}

/**
 * 算冷却时长
 *   基础 3 分钟
 *   + 内容重复（和上次相似度高）→ +2 分钟
 *   + L 低 → +1 分钟
 *   上限 5 分钟
 */
export function computeCooldown({ description = '', L = 55, cfg = DEFAULTS, lastDescription = '' } = {}) {
  let ms = cfg.cooldownBaseMs || 180000
  const d = String(description || '')
  const last = String(lastDescription || '')

  // 内容重复：简单的相似度（共同字符占比）
  if (d && last) {
    const sim = jaccard(d, last)
    if (sim >= 0.6) ms += cfg.cooldownRepeatMs || 120000
  }
  // L 低 → 冷却更长
  if (Number(L) < (cfg.lowL || 40)) ms += cfg.cooldownLowLMs || 60000

  const max = cfg.cooldownMaxMs || 300000
  return Math.min(max, Math.max(cfg.cooldownBaseMs || 180000, ms))
}

/** 字符集合的 Jaccard 相似度（够用即可） */
function jaccard(a, b) {
  const setA = new Set(String(a).replace(/\s+/g, ''))
  const setB = new Set(String(b).replace(/\s+/g, ''))
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const ch of setA) if (setB.has(ch)) inter += 1
  return inter / (setA.size + setB.size - inter)
}
