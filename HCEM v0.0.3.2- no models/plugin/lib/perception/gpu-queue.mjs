// 显存错峰队列：把「占显存的模型调用」串行化，避免视觉和听觉同时抢显存
//
// 为什么需要：
//   看视频时视觉（Qwen2.5-VL 3.2G）和听觉（emotion2vec / Qwen3-ASR）会同时想跑，
//   8 GB 卡装不下两个大模型并发 → 必须排队。
//
// 设计：
//   · 按优先级排队（视觉精看 > 转写 > 情绪 > 其它）
//   · 同一时刻只允许 N 个任务（默认 1）
//   · 任务失败不影响队列
//   · 有超时保护，避免一个卡死拖垮全局

/** 任务优先级（数字越小越先跑） */
export const PRIORITY = Object.freeze({
  visionFine: 10, // 精看（Qwen2.5-VL）
  visionFast: 20, // 预留：轻量视觉（当前视觉只有 Qwen2.5-VL）
  asr: 30, // 转写
  emotion: 40, // 情绪
  music: 50, // 音乐情感/指纹
  scene: 60, // 环境声分类
})

/**
 * 创建一个串行执行队列
 * @param {object} opts { maxConcurrent?: 并发数, logger? }
 */
export function createGpuQueue(opts = {}) {
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || 1)
  const logger = opts.logger || console
  /** @type {Array<{prio:number, seq:number, fn:Function, resolve:Function, reject:Function, label:string}>} */
  let queue = []
  let running = 0
  let seq = 0
  const stats = { total: 0, done: 0, failed: 0, peakQueue: 0 }

  function pump() {
    while (running < maxConcurrent && queue.length > 0) {
      // 按优先级取（同优先级按入队顺序）
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq)
      const job = queue.shift()
      running += 1
      Promise.resolve()
        .then(() => job.fn())
        .then(
          (r) => {
            stats.done += 1
            job.resolve(r)
          },
          (e) => {
            stats.failed += 1
            job.reject(e)
          },
        )
        .finally(() => {
          running -= 1
          pump()
        })
    }
  }

  /**
   * 提交一个任务
   * @param {Function} fn 要执行的任务（返回 Promise）
   * @param {object} o { priority?:number, label?:string, timeoutMs?:number }
   */
  function run(fn, o = {}) {
    const prio = Number(o.priority) || PRIORITY.scene
    const label = String(o.label || 'task')
    const timeoutMs = Number(o.timeoutMs) || 120000
    stats.total += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stats.failed += 1
        reject(new Error(`队列任务超时: ${label} (${timeoutMs}ms)`))
      }, timeoutMs)
      const wrap = (r) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const wrapErr = (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      }
      queue.push({ prio, seq: seq++, fn, resolve: wrap, reject: wrapErr, label })
      stats.peakQueue = Math.max(stats.peakQueue, queue.length)
      // 延迟到下一个宏任务再取，让同一轮提交的任务能按优先级排序
      setImmediate(pump)
    })
  }

  /** 只提交不等待（丢进队列就跑，失败只记日志） */
  function fire(fn, o = {}) {
    run(fn, o).catch((e) => logger.warn?.(`[错峰队列] ${o.label || 'task'} 失败: ${e && e.message}`))
  }

  return {
    run,
    fire,
    status: () => ({ running, queued: queue.length, ...stats }),
    get busy() {
      return running > 0
    },
  }
}

/** 全局单例（整个插件共用一条队列） */
let _global = null
export function getGpuQueue(opts = {}) {
  if (!_global) _global = createGpuQueue({ maxConcurrent: 1, ...opts })
  return _global
}
