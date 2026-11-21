// HCEM 休眠/冷存储（阶段 8）：关闭时挂起，再次启用时「回忆」
// 冷存储标记存在 meta 表（cold_since），记忆与情绪本身一直在 SQLite 里，不丢。

export function buildRecall(coldSince, saved, memories = []) {
  if (!coldSince) return ''
  const when = formatWhen(coldSince)
  const hsl = saved
    ? `H=${Math.round(Number(saved.H))}° S=${Math.round(Number(saved.S))}% L=${Math.round(Number(saved.L))}%`
    : '未知'
  const lines = memories
    .map((m) => String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 50))
    .filter(Boolean)
    .map((t) => `- ${t}`)
  return [
    '[HCEM 回忆] 你刚从冷存储中醒来（上次活跃：' + when + '）。',
    '你记得上次的情绪（' + hsl + '）' + (lines.length > 0 ? '，还有这些事：' : '。'),
    ...(lines.length > 0 ? [lines.join('\n')] : []),
    '自然地接住这段记忆：不要假装失忆，也不必逐条复述，像刚睡醒一样带出来就好。',
  ].join('\n')
}

function formatWhen(iso) {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return String(iso)
  }
}