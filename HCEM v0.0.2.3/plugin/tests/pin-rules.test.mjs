// pin / δ 分流规则测试（单次 promote）
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/pin-rules'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = TMP + '/hcem.sqlite'
const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const now = Date.now()

function put(text, zone, delta, pinned, ageHours) {
  const isPool = ['context', 'pool_fast', 'pool_observe', 'pool_keep'].includes(zone)
  const id = store.putMemory({ text, zone, deltaPool: isPool ? delta : 0, deltaLong: isPool ? 0 : delta, pinned })
  const at = new Date(now - ageHours * H).toISOString()
  store.zoneDb(zone).prepare('UPDATE memories SET created_at=?, updated_at=?, last_accessed_at=? WHERE id=?').run(at, at, at, id)
  return id
}

// 保留池 80h（>72h）：δ=4→life；δ=3→knowledge；δ=0 且 pinned=0→遗忘；pinned>0→life
const id4 = put('delta4', 'pool_keep', 6, 0, 80)
const id3 = put('delta3', 'pool_keep', 4, 0, 80)
const id0 = put('delta0', 'pool_keep', 0, 0, 80)
const idP = put('pinned05', 'pool_keep', 0, 0.5, 80)

promoteMemories(store, now)
assert.strictEqual(store.getMemory(id4)?.zone, 'life', 'δ=4 → 生活区')
assert.strictEqual(store.getMemory(id3)?.zone, 'knowledge', 'δ₁=4（衰减后≈1.05）→ 知识区')
assert.strictEqual(store.getMemory(id0), null, 'δ=0 且 pinned=0 → 遗忘')
assert.strictEqual(store.getMemory(idP)?.zone, 'life', 'pinned>0 → 生活区')

// pin 上限：缓冲池 1
const capId = put('cap', 'pool_keep', 0, 0, 80)
assert.strictEqual(store.addPin(capId, 0.5), 0.5, '缓冲池 pin 第一次 0.5')
assert.strictEqual(store.addPin(capId, 0.5), 1, '缓冲池 pin 第二次到 1')

// pin 上限：生活区 2
const lifeId = put('life-pin', 'life', 0, 0, 10)
assert.strictEqual(store.addPin(lifeId, 0.5), 0.5)
assert.strictEqual(store.addPin(lifeId, 0.5), 1)
assert.strictEqual(store.addPin(lifeId, 0.5), 1.5)
assert.strictEqual(store.addPin(lifeId, 0.5), 2, '生活区 pin 封顶 2')

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL PIN RULES TESTS PASSED')
