// 感知窗口：保留最近一段时间的「看到了什么 / 听到了什么」，供摘要管线取用。
//
// 之前只有 lastScreenDesc / lastAudioKind 两个「最近一次」的变量：
//   · 没有时间，没法配对
//   · 没有历史，收不出「最近 60 秒发生了什么」
//   · 画面换了之后，上一条描述直接被覆盖
//
// 这个模块就是那个缺失的环形缓冲。

/**
 * @param {object} opts
 * @param {number} [opts.maxAgeMs] 超过这个时间的条目会被丢弃（默认 2 分钟）
 * @param {number} [opts.maxItems] 容量上限（默认 80）
 */
export function createPerceptionWindow({ maxAgeMs = 120000, maxItems = 80 } = {}) {
  /** @type {Array<{ts:number, kind:'screen'|'audio'|'emotion', text:string, meta?:object}>} */
  let items = []

  function trim(now = Date.now()) {
    const cutoff = now - maxAgeMs
    if (items.length && items[0].ts < cutoff) {
      items = items.filter((e) => e.ts >= cutoff)
    }
    if (items.length > maxItems) items = items.slice(-maxItems)
  }

  return {
    /** 压一条。kind: screen / audio / emotion */
    push(entry) {
      if (!entry || !String(entry.text || '').trim()) return
      const ts = Number(entry.ts) || Date.now()
      items.push({
        ts,
        kind: entry.kind || 'screen',
        text: String(entry.text).trim().slice(0, 400),
        meta: entry.meta || null,
      })
      trim(ts)
    },

    /** 取最近 ms 毫秒内的条目（按时间升序） */
    recent(ms = 60000) {
      const now = Date.now()
      trim(now)
      const cutoff = now - ms
      return items.filter((e) => e.ts >= cutoff)
    },

    /** 清空 */
    clear() {
      items = []
    },

    /** 当前条数 */
    size() {
      return items.length
    },
  }
}
