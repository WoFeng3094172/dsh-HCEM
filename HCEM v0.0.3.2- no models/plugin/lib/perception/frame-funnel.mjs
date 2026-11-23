// 帧级漏斗（视觉优化 S1 + storyboard 融入）：镜头切分 + 密度分配 + 段内 top-K
// 输入：每帧变化分数（0-1，来自 frame-diff / HSV 打分）
// 输出：ready 帧（时间序），由 manager 取对应图片送 VLM
//
// 融入 storyboard 的做法：
//   · 镜头切分：自动阈值（均值 + 2σ）+ 邻近抑制（<minGap 只留最高分）
//   · 密度分配：快切段多给帧（密度 1.0~2.5），长镜头少给
//   · 段内 top-K：按分数排序取前 K（默认 1/3，下限 3）
//   · 不跨段全局排序（每镜头独立）

export const DEFAULT_WINDOW_MS = 10000 // 兜底段窗口（无切点时按时间切）
export const MIN_CUT_GAP_MS = 2000 // 邻近抑制
export const AUTO_SIGMA = 2 // 自动阈值 = 均值 + 2σ
export const DENSITY_BASE = 1.0
export const DENSITY_MAX = 2.5
export const TOPK_RATIO = 1 / 3
export const TOPK_MIN = 3

export class FrameFunnel {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.minGapMs = opts.minGapMs ?? MIN_CUT_GAP_MS
    this.sigma = opts.sigma ?? AUTO_SIGMA
    this.baseFps = typeof opts.baseFps === 'function' ? opts.baseFps : () => (opts.baseFps ?? 1)
    this.frames = []
    this.segmentStart = null
    this.lastCut = 0
    this.pendingCut = null
    this.lastReady = []
    this.counts = { segments: 0, cuts: 0, selected: 0 }
  }

  push(ts, score) {
    const t = Number(ts)
    const s = Math.max(0, Math.min(1, Number(score) || 0))
    if (!Number.isFinite(t)) return
    if (this.segmentStart === null) this.segmentStart = t
    this.frames.push({ ts: t, score: s })
    // 切点检测：分数超过自动阈值，且距上个切点足够远
    const th = this.threshold()
    if (Number.isFinite(th) && s > th && t - this.lastCut > this.minGapMs) {
      this.pendingCut = t
    }
  }

  /** 自动阈值（均值 + sigma × 标准差，上限 0.5 防止快切场景阈值过高） */
  threshold() {
    const n = this.frames.length
    if (n < 3) return Infinity
    const mean = this.frames.reduce((sum, f) => sum + f.score, 0) / n
    const variance = this.frames.reduce((sum, f) => sum + (f.score - mean) ** 2, 0) / n
    return Math.min(0.5, mean + this.sigma * Math.sqrt(variance))
  }

  /** 是否需要 flush：有切点 or 时间窗口到 */
  shouldFlush(now) {
    if (this.frames.length === 0) return false
    if (this.pendingCut !== null) return true
    return this.segmentStart !== null && now - this.segmentStart >= this.windowMs
  }

  /** 段内选帧（格数 = 时长 ÷ 每格秒数，每格秒数由 motion 密度决定） */
  selectFromSegment(segment) {
    if (segment.length === 0) return []
    const durSec = Math.max(0.2, (segment[segment.length - 1].ts - segment[0].ts) / 1000)
    // motion p90（借鉴 storyboard：按画面变化密度定「每格秒数」）
    const sorted = segment.map((f) => f.score).sort((a, b) => a - b)
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0
    // 段内粒度（storyboard 整片粒度 12/20/30s 缩放到 10s 段：2.5/4/6s）
    const secPerCell = p90 >= 0.15 ? 2.5 : p90 >= 0.05 ? 4 : 6
    // 格数 = 时长 / 每格秒数（上限：段内帧数；下限 1）
    const cellsByDensity = Math.max(1, Math.min(segment.length, Math.round(durSec / secPerCell)))
    // 情绪 fps 作为「额外权重」（专注时允许更多格）
    const fps = typeof this.baseFps === 'function' ? this.baseFps() : this.baseFps
    const emotionBonus = Math.round(cellsByDensity * (fps - 0.6) * 0.5)
    const budget = Math.max(1, cellsByDensity + Math.max(0, emotionBonus))
    const topK = Math.max(TOPK_MIN, Math.ceil(segment.length * TOPK_RATIO))
    const limit = Math.min(budget, topK, segment.length)
    return segment
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .sort((a, b) => a.ts - b.ts)
  }

  /** flush 当前段 → 返回 ready 帧（时间序） */
  flush() {
    if (this.frames.length === 0) return []
    const cutTs = this.pendingCut
    let segment
    if (cutTs !== null) {
      const idx = this.frames.findIndex((f) => f.ts >= cutTs)
      segment = idx < 0 ? this.frames : this.frames.slice(0, idx)
      this.frames = idx < 0 ? [] : this.frames.slice(idx)
      this.lastCut = cutTs
      this.counts.cuts += 1
    } else {
      segment = this.frames
      this.frames = []
    }
    this.pendingCut = null
    if (this.frames.length === 0) this.segmentStart = null
    const ready = this.selectFromSegment(segment)
    if (segment.length > 0) this.counts.segments += 1
    this.counts.selected += ready.length
    if (ready.length > 0) this.lastReady = this.lastReady.concat(ready)
    return ready
  }

  /** 取出累积的 ready 帧 */
  drainReady() {
    const out = this.lastReady
    this.lastReady = []
    return out
  }

  /** 是否还有未 flush 的帧 */
  hasPending() {
    return this.frames.length > 0
  }

  stats() {
    const n = this.frames.length
    const avg = n ? this.frames.reduce((s, f) => s + f.score, 0) / n : 0
    return { pending: n, avgScore: avg, ...this.counts }
  }
}
