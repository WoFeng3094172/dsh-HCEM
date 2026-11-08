import assert from 'node:assert'
import fs from 'node:fs'
import { openStore } from '../lib/store.mjs'
import { shouldRemember, extractMemoryText, decayMemories, recall } from '../lib/memory.mjs'

// 用临时数据库，不污染真实数据
const tmpDir = 'E:/HCEM/.test-data/memory'
fs.mkdirSync(tmpDir, { recursive: true })
const dbPath = `${tmpDir}/memory.test.sqlite`
try {
  fs.unlinkSync(dbPath)
} catch {}

const store = openStore(console, dbPath)

// 1) 是否值得记忆
assert.strictEqual(shouldRemember('你好'), false)
assert.strictEqual(shouldRemember('嗯'), false)
assert.strictEqual(shouldRemember('今天天气很好，我们去公园散步了'), true)

// 2) 截断
assert.ok(extractMemoryText('x'.repeat(600)).length <= 501)

// 3) 写入
store.putMemory({ text: '鲸鲸喜欢睡觉', zone: 'context' })
store.putMemory({ text: '用户住在安静的地方', zone: 'context' })
assert.strictEqual(store.listMemories().length, 2)

// 4) 衰减：把 created_at 改到 120 小时前 → L 应降
for (const r of store.listMemories()) {
  store.zoneDb(r.zone || 'context')
    .prepare('UPDATE memories SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 120 * 3600 * 1000).toISOString(), r.id)
}
const decayed = decayMemories(store, Date.now())
assert.ok(decayed > 0, '应发生衰减')
const after = store.listMemories()
assert.ok(after.length > 0, '记忆不应被删除')
assert.ok(after[0].L < 1, 'L 应下降')

// 5) 无向量时检索为空
assert.strictEqual(recall(store, [], 3, 0.45).length, 0)

store.close()
// 只清理本次测试的文件，不删整个测试目录（避免误删其它测试的产物）
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
  try { fs.unlinkSync(f) } catch {}
}
try { fs.rmdirSync(tmpDir) } catch {}
console.log('ALL MEMORY TESTS PASSED')
