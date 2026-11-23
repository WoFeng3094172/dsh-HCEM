// 视听时间窗融合：同一段时间里的画面和声音合并成一条记忆，不缺失
//
// 为什么需要：
//   视觉和听觉是两条独立的循环，各自出结果。
//   如果各写各的记忆，"看视频"这件事会被拆成两条互不相关的记录；
//   合并之后才是「同一时刻发生的同一件事」。
//
// 设计：
//   · 视觉/听觉结果先各自进缓冲（带时间戳）
//   · 每过一个窗口（默认 8 秒）就把窗口内的配对取出
//   · 有画面有声音 → 合成一条「联合记忆」
//   · 只有一边 → 单独成条（不丢）
//   · 窗口内的多条同类结果 → 取最新的一条 + 合并描述（不丢）

const DEFAULT_WINDOW_MS = 8000

/**
 * 创建融合器
 * @param {object} opts {
 *   windowMs?: 窗口长度（毫秒）
 *   maxPerSide?: 每侧最多保留几条
 *   onMerged?: 合并结果回调
 *   logger?: 日志
 * }
 */
export function createFusion(opts = {}) {
  const windowMs = Math.max(2000, Number(opts.windowMs) || DEFAULT_WINDOW_MS)
  const maxPerSide = Math.max(1, Number(opts.maxPerSide) || 6)
  const onMerged = typeof opts.onMerged === 'function' ? opts.onMerged : () => {}
  const logger = opts.logger || console

  /** @type {Array<{ts:number, text:string, meta:object}>} */
  let visionBuf = []
  /** @type {Array<{ts:number, text:string, meta:object}>} */
  let audioBuf = []
  let timer = null
  let lastFlush = Date.now()
  const stats = { merged: 0, visionOnly: 0, audioOnly: 0, dropped: 0 }

  function pushVision(item) {
    if (!item) return
    visionBuf.push({ ts: Number(item.ts) || Date.now(), text: String(item.text || ''), meta: item.meta || {} })
    if (visionBuf.length > maxPerSide) {
      stats.dropped += 1
      visionBuf.shift()
    }
  }

  function pushAudio(item) {
    if (!item) return
    audioBuf.push({ ts: Number(item.ts) || Date.now(), text: String(item.text || ''), meta: item.meta || {} })
    if (audioBuf.length > maxPerSide) {
      stats.dropped += 1
      audioBuf.shift()
    }
  }

  /** 把一组同类结果合并成一句（去重、保留最新） */
  function joinTexts(list) {
    const seen = new Set()
    const parts = []
    for (const x of list) {
      const t = String(x.text || '').trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      parts.push(t)
    }
    return parts.join('；')
  }

  /** 结算当前窗口 */
  function flush() {
    const now = Date.now()
    const cutoff = now - windowMs
    // 只处理「已经完整过去」的窗口，避免把还在进行的事件切碎
    const vReady = visionBuf.filter((x) => x.ts <= cutoff)
    const aReady = audioBuf.filter((x) => x.ts <= cutoff)
    visionBuf = visionBuf.filter((x) => x.ts > cutoff)
    audioBuf = audioBuf.filter((x) => x.ts > cutoff)
    if (vReady.length === 0 && aReady.length === 0) return

    const ts = now
    // 统一时间窗：声音和画面用同一个 start/end，方便回查
    const times = [...vReady.map((x) => x.ts), ...aReady.map((x) => x.ts)].filter((x) => Number.isFinite(x))
    const timeStart = times.length ? Math.min(...times) : now - windowMs
    const timeEnd = times.length ? Math.max(...times) : now
    const vTs = vReady.length > 0 ? vReady[vReady.length - 1].ts : null
    const aTs = aReady.length > 0 ? aReady[aReady.length - 1].ts : null
    const vText = joinTexts(vReady)
    const aText = joinTexts(aReady)
    const vMeta = vReady.length > 0 ? vReady[vReady.length - 1].meta : {}
    const aMeta = aReady.length > 0 ? aReady[aReady.length - 1].meta : {}

    try {
      if (vText && aText) {
        stats.merged += 1
        onMerged({
          kind: 'both',
          ts,
          timeStart,
          timeEnd,
          visionTs: vTs,
          audioTs: aTs,
          text: vText + '｜' + aText,
          visionText: vText,
          audioText: aText,
          visionCount: vReady.length,
          audioCount: aReady.length,
          meta: { ...vMeta, ...aMeta },
        })
      } else if (vText) {
        stats.visionOnly += 1
        onMerged({ kind: 'vision', ts, timeStart, timeEnd, visionTs: vTs, visionCount: vReady.length, audioCount: 0, text: vText, visionText: vText, audioText: '', meta: vMeta })
      } else if (aText) {
        stats.audioOnly += 1
        onMerged({ kind: 'audio', ts, timeStart, timeEnd, audioTs: aTs, visionCount: 0, audioCount: aReady.length, text: aText, visionText: '', audioText: aText, meta: aMeta })
      }
    } catch (e) {
      logger.warn?.(`[融合] 回调失败: ${(e && e.message) || e}`)
    }
    lastFlush = now
  }

  function start() {
    if (timer) return
    timer = setInterval(() => {
      try {
        flush()
      } catch (e) {
        logger.warn?.(`[融合] flush 失败: ${(e && e.message) || e}`)
      }
    }, Math.max(1000, Math.floor(windowMs / 2)))
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    flush()
  }

  return {
    pushVision,
    pushAudio,
    flush,
    start,
    stop,
    status: () => ({ ...stats, visionBuf: visionBuf.length, audioBuf: audioBuf.length, windowMs, lastFlush }),
  }
}
