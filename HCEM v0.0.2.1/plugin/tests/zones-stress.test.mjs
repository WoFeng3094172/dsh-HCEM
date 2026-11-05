// 记忆转区加速压力测试：用假时间戳模拟 120 小时，观察迁移与遗忘
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/zones-stress'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`

const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')
const { decayMemories } = await import('../lib/memory.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const base = Date.now()
const ZONES = ['context', 'pool_fast', 'pool_observe', 'pool_keep']
const N = 800

// 1) 插入 800 条随机年龄/分区的记忆
for (let i = 0; i < N; i += 1) {
  const zone = ZONES[i % ZONES.length]
  const age = Math.random() * 10
  const id = store.putMemory({ text: `压力记忆 ${i}`, zone })
  const created = new Date(base - age * H).toISOString()
  store.zoneDb(zone).prepare('UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?').run(created, created, id)
}

function snapshot() {
  const rows = store.listMemories({ limit: 5000 })
  const counts = Object.fromEntries(ZONES.map((z) => [z, 0]))
  for (const m of rows) counts[m.zone] = (counts[m.zone] ?? 0) + 1
  return { total: rows.length, ...counts }
}

const start = process.hrtime.bigint()
let now = base
const rowsOut = []
let prevTotal = snapshot().total

// 2) 模拟 120 小时，每小时推进一次转区 + 衰减
for (let h = 1; h <= 120; h += 1) {
  now += H
  promoteMemories(store, now)
  decayMemories(store, now)
  if (h % 10 === 0 || h === 120) {
    const s = snapshot()
    assert.ok(s.total <= prevTotal, `第 ${h} 小时总数不应增加（${prevTotal} -> ${s.total}）`)
    prevTotal = s.total
    rowsOut.push({ h, ...s })
  }
}
const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

console.log('小时  context  快速池  观察池  保留池  总数')
console.log('-'.repeat(50))
for (const r of rowsOut) {
  console.log(
    `${String(r.h).padStart(4)} ${String(r.context).padStart(8)} ${String(r.pool_fast).padStart(6)} ${String(r.pool_observe).padStart(6)} ${String(r.pool_keep).padStart(6)} ${String(r.total).padStart(6)}`,
  )
}
console.log('-'.repeat(50))
console.log(`120 轮转区+衰减耗时 ${elapsedMs.toFixed(0)} ms（${N} 条记忆）`)

// 3) 断言：最终不该有超出规则年龄的滞留
const final = store.listMemories({ limit: 5000 })
const nowTs = now
for (const m of final) {
  const ageH = (nowTs - Date.parse(m.last_accessed_at || m.created_at)) / H
  if (m.zone === 'pool_keep') assert.ok(ageH < 73, `pool_keep 超龄未清理：${ageH.toFixed(1)}h`)
  if (m.zone === 'pool_observe') assert.ok(ageH < 25, `pool_observe 超龄未迁移：${ageH.toFixed(1)}h`)
  if (m.zone === 'pool_fast') assert.ok(ageH < 3, `pool_fast 超龄未迁移：${ageH.toFixed(1)}h`)
  if (m.zone === 'context') assert.ok(ageH < 3, `context 超龄未迁移：${ageH.toFixed(1)}h`)
}

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ZONES STRESS TEST PASSED')