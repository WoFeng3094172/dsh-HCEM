// 延寿测试：生活/知识区到期后延寿 30 天，再到期应遗忘
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/extend'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = TMP + '/hcem.sqlite'
const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const DAY = 24 * H
const now = Date.now()

function put(text, zone, deltaLong, ageDays) {
  const id = store.putMemory({ text, zone, deltaLong })
  const at = new Date(now - ageDays * DAY).toISOString()
  store.zoneDb(zone).prepare('UPDATE memories SET created_at=?, updated_at=?, last_accessed_at=?, zone_since=? WHERE id=?').run(at, at, at, at, id)
  return id
}

// 生活区：δ_orig=7，90 天未调用 → 衰减 3 次 = 7×0.343 = 2.401（落在延寿区间 2.3~2.6）
const lifeId = put('life-extend', 'life', 2.2, 90)
promoteMemories(store, now)
const lifeAfter = store.getMemory(lifeId)
assert.ok(lifeAfter, '延寿的记忆应还在')
assert.strictEqual(lifeAfter.zone, 'life', '延寿后仍在生活区')
assert.ok(lifeAfter.extended_until, '应设置延寿截止时间')
console.log('life 延寿: δ=', lifeAfter.access_count.toFixed(2), 'extended_until=', lifeAfter.extended_until)

// 30 天后再次到期：δ=2.4×0.7=1.68 <2.3 → 遗忘
const later = now + 30 * DAY
promoteMemories(store, later)
assert.strictEqual(store.getMemory(lifeId), null, '延寿后再次到期应遗忘')

// 知识区：δ_orig=10，120 天未调用 → 衰减 4 次 = 10×0.2401 = 2.401（延寿区间 1.6~2.1 之外？）
// 计算：120 天 → floor(120/30)=4 → 10×0.7^4=2.401 → ≥2.1 → 冷存（不是延寿）
// 改用 δ_orig=7 → 7×0.2401=1.681（延寿区间 1.6~2.1）
const knId = put('kn-extend', 'knowledge', 2.5, 120)
promoteMemories(store, now)
const knAfter = store.getMemory(knId)
assert.ok(knAfter, '知识区延寿记忆应还在')
assert.strictEqual(knAfter.zone, 'knowledge')
assert.ok(knAfter.extended_until, '知识区也应设置延寿')
console.log('knowledge 延寿: δ=', knAfter.access_count.toFixed(2), 'extended_until=', knAfter.extended_until)

// 30 天后：δ=1.68×0.7=1.18 <1.6 → 遗忘
promoteMemories(store, later + 30 * DAY)
assert.strictEqual(store.getMemory(knId), null, '知识区延寿后再次到期应遗忘')

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL EXTEND TESTS PASSED')
