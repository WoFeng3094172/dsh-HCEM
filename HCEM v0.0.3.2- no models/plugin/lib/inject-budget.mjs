/**
 * 注入预算：把「记忆/笔记」这类列表压进固定字符预算
 *
 * 参考 dsh-mind 的 budget.js：段有上限、总上限超了要削，但**削的时候不能把一句话拦腰切断**。
 * 这里的策略更简单，因为记忆是列表：
 *   1) 每条先按 perItem 截（优先行边界）
 *   2) 从头（分数最高）开始加，直到超出 total
 *   3) 剩余条数用一句说明代替，说明本身也算在 total 内
 *
 * ⚠️ 只影响「这一轮往 prompt 里塞多少」，不改记忆本身，也不碰分区迁移/遗忘。
 */

/** 按字符数裁剪，优先在最后一个换行/句末切，截断说明算在 max 内 */
export function cutText(text, max) {
  const t = String(text ?? '')
  if (t.length <= max) return t
  const note = '…'
  if (note.length >= max) return t.slice(0, max)
  const room = max - note.length
  const head = t.slice(0, room)
  const lastBreak = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'), head.lastIndexOf('，'))
  const body = lastBreak > room * 0.6 ? head.slice(0, lastBreak + 1) : head
  return body + note
}

/**
 * @param {Array<{text:string, md?:number}>} items 已按分数排序（越靠前越重要）
 * @param {{total?:number, perItem?:number, header?:string, format?:Function}} opts
 * @returns {{text:string, chars:number, kept:number, dropped:number, trimmed:string[]}}
 */
export function budgetList(items = [], opts = {}) {
  const total = Math.max(0, Number(opts.total) || 900)
  const perItem = Math.max(20, Number(opts.perItem) || 260)
  const header = String(opts.header ?? '')
  const format = typeof opts.format === 'function' ? opts.format : (m) => String(m.text || '')
  const trimmed = []

  const lines = []
  let used = header ? header.length + 1 : 0
  let dropped = 0
  for (let i = 0; i < items.length; i += 1) {
    const raw = format(items[i])
    if (!raw) continue
    let line = '- ' + raw
    if (line.length > perItem) {
      line = '- ' + cutText(raw, perItem - 2)
      trimmed.push('perItem')
    }
    // 预估「还有 N 条」说明的长度（保证说明也进预算）
    const restNote = `（还有 ${items.length - i} 条记忆因预算未列出）`
    const cost = line.length + 1
    if (used + cost + restNote.length > total) {
      dropped = items.length - i
      break
    }
    lines.push(line)
    used += cost
  }

  let text = lines.length === 0 ? header : header ? header + '\n' + lines.join('\n') : lines.join('\n')
  if (dropped > 0) {
    const note = `（还有 ${dropped} 条记忆因预算未列出）`
    // 说明必须真的放得下：放不下就再丢最后一行
    while (text.length + 1 + note.length > total + (header ? header.length + 1 : 0) && lines.length > 0) {
      lines.pop()
      trimmed.push('total')
      text = header ? header + '\n' + lines.join('\n') : lines.join('\n')
    }
    text = (text ? text + '\n' : '') + note
  }
  const chars = text.length
  return { text, chars, kept: lines.length, dropped, trimmed: [...new Set(trimmed)] }
}
