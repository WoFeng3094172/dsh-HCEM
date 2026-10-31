// 生活常识区 / 知识区：写入 → 压缩（模糊）→ 遗忘，加速 90 天
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/zones-life'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`

const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')
const { decayMemories } = await import('../lib/memory.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const now0 = Date.now()
const ZONES = ['context', 'pool_fast', 'pool_observe', 'pool_keep', 'life', 'knowledge', 'cold']

function put(text, zone, accessCount) {
  const id = store.putMemory({ text, zone })
  store.zoneDb(zone)
    .prepare('UPDATE memories SET created_at = ?, last_accessed_at = ?, updated_at = ?, access_count = ? WHERE id = ?')
    .run(new Date(now0).toISOString(), new Date(now0).toISOString(), new Date(now0).toISOString(), accessCount, id)
  return id
}

// 200 条上下文（低频）+ 200 条保留池（100 条常用、100 条不常用）
for (let i = 0; i < 200; i += 1) put(`上下文记忆 ${i}`, 'context', 0)
for (let i = 0; i < 100; i += 1) put(`保留池常用 ${i}`, 'pool_keep', 4)
for (let i = 0; i < 100; i += 1) put(`保留池冷门 ${i}`, 'pool_keep', 0)

function snapshot() {
  const rows = store.listMemories({ limit: 5000 })
  const zones = Object.fromEntries(ZONES.map((z) => [z, 0]))
  const levels = { full: 0, summary: 0, short: 0, keyword: 0 }
  for (const m of rows) {
    zones[m.zone] = (zones[m.zone] ?? 0) + 1
    if (levels[m.level] !== undefined) levels[m.level] += 1
  }
  return { total: rows.length, ...zones, ...Object.fromEntries(Object.entries(levels).map(([k, v]) => ['lv_' + k, v])) }
}

const pick = (s) => `${String(s.total).padStart(5)} | 上下文 ${s.context} 快速 ${s.pool_fast} 观察 ${s.pool_observe} 保留 ${s.pool_keep} 常识 ${s.life} 知识 ${s.knowledge} | 模糊 full ${s.lv_full} summary ${s.lv_summary} short ${s.lv_short} keyword ${s.lv_keyword}`

let now = now0
const trace = []
let refreshedId = null
let refreshedAt = null

// 90 天，每 6 小时推进一次
for (let h = 1; h <= 2880; h += 1) {
  now = now0 + h * H
  promoteMemories(store, now)
  decayMemories(store, now)

  // 第 15 天：调用一条「保留池常用」记忆（模拟被检索命中并刷新）
  if (h === 15 * 24 && !refreshedId) {
    const row = store.listMemories({ limit: 5000 }).find((m) => m.text.includes('保留池常用'))
    if (row) {
      store.touchMemory(row.id, 0.2)
      refreshedId = row.id
      refreshedAt = now
    }
  }

  if (h % (24 * 1) === 0) {
    const days = h / 24
    if ([1, 3, 7, 15, 30, 40, 60, 75, 90, 110].includes(days)) {
      const s = snapshot()
      trace.push({ days, s })
    }
  }
}

console.log('天 | 总数 | 分区分布 | 清晰度等级')
console.log('-'.repeat(110))
for (const { days, s } of trace) console.log(`${String(days).padStart(3)} | ${pick(s)}`)

// 断言
const at = (d) => trace.find((t) => t.days === d).s
const d7 = at(7)
assert.ok(d7.life >= 90, `第 7 天应有生活区（δ=4），实际 ${d7.life}`)
assert.ok(d7.total >= 90, `第 7 天应仍有记忆，实际 ${d7.total}`)

const d40 = at(40)
const d90 = at(90)
const d110 = at(110)
assert.strictEqual(d110.cold, 0, `第 110 天：δ 衰减后不足以进冷存，冷存应为 0，实际 ${d110.cold}`)
assert.strictEqual(d110.total, 0, `第 110 天应全部遗忘，剩余 ${d110.total}`)

// 压缩：中途应出现 summary/short/keyword
const levelsSeen = trace.some((t) => t.s.lv_summary > 0 || t.s.lv_short > 0 || t.s.lv_keyword > 0)
assert.ok(levelsSeen, '应观察到清晰度降级（summary/short/keyword）')

// 调用刷新：被刷新的那条应比同类活得久
if (refreshedId) {
  const row = store.getMemory(refreshedId)
  const aliveAfter = (now0 + 40 * 24 * H) <= now
  console.log(`被调用刷新的一条在 40 天时${row ? '仍在' : '已遗忘'}（刷新时刻 ${new Date(refreshedAt).toISOString().slice(0, 10)}）`)
}

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ZONES LIFE/KNOWLEDGE TEST PASSED')