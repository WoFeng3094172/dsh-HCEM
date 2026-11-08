// 记忆转区测试（临时库）
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/zones'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`
const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

const store = openStore(console)
const H = 3600 * 1000
const now = Date.now()

function put(text, zone, ageHours, ageAccess = ageHours) {
  const id = store.putMemory({ text, zone })
  const created = new Date(now - ageHours * H).toISOString()
  const accessed = new Date(now - ageAccess * H).toISOString()
  // updated_at 也要回退（转区基准取三者最大）
  store.zoneDb(zone).prepare('UPDATE memories SET created_at = ?, last_accessed_at = ?, updated_at = ? WHERE id = ?').run(created, accessed, created, id)
  return id
}

// 1) context 1h：不动
const a = put('一小时的记忆', 'context', 1)
// 2) context 3h：→ pool_fast
const b = put('三小时的记忆', 'context', 3)
// 3) pool_fast 3h：→ pool_observe
const c = put('快速池三小时', 'pool_fast', 3)
// 4) pool_observe 30h：→ pool_keep
const d = put('观察池三十小时', 'pool_observe', 30)
// 5) pool_keep 80h：遗忘
const e = put('保留池八十小时', 'pool_keep', 80)

const r = promoteMemories(store, now)
const byId = (id) => store.getMemory(id)
assert.strictEqual(byId(a).zone, 'context', '1h 不动')
assert.strictEqual(byId(b).zone, 'pool_observe', '3h 的老记忆一轮内沉降两级（context→fast→observe）')
assert.strictEqual(byId(c).zone, 'pool_observe', '快速池 3h 进观察池')
assert.strictEqual(byId(d).zone, 'pool_keep', '观察池 30h 进保留池')
assert.strictEqual(byId(e), null, '保留池 80h 低频（δ=0 且 pinned=0）→ 遗忘')
assert.strictEqual(r.moved, 4)
assert.strictEqual(r.forgotten, 1)

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL ZONES TESTS PASSED')