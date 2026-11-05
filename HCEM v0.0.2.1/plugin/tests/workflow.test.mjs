// 记忆完整工作流：正常时间回归 + 压缩显示 + 跨区检索
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/workflow'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`

const { openStore } = await import('../lib/store.mjs')
const { recall, decayMemories, summarize, displayText, computeGamma } = await import('../lib/memory.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

const store = openStore({ info() {}, warn() {} })

// 1) 正常时间写入 3 条
const ids = []
for (const text of ['我叫小明，养了一只猫叫花花', '我最喜欢蓝色，讨厌下雨天', '我最近在忙着写论文']) {
  const id = store.putMemory({
    text,
    summary: summarize(text),
    embedding: [0.1, 0.2, 0.3],
    alphaH: 300,
    alphaS: 60,
    betaH: 300,
    gammaValue: computeGamma({ H: 300, S: 60 }, { H: 300, S: 55 }),
    zone: 'context',
    L: 1.0,
    level: 'full',
  })
  ids.push(id)
}

// 2) 连续 50 轮（真实时间，间隔 5ms）：不应发生误迁移/误衰减
for (let i = 0; i < 50; i += 1) {
  promoteMemories(store)
  decayMemories(store)
  await new Promise((r) => setTimeout(r, 5))
}
for (const id of ids) {
  const m = store.getMemory(id)
  assert.strictEqual(m.zone, 'context', '正常时间下新记忆不应被迁移')
  assert.ok(Number(m.L) > 0.999, `正常时间下 L 不应下降，实际 ${m.L}`)
}

// 3) 检索命中并刷新调用
const hits = recall(store, [0.1, 0.2, 0.3], 3, 0.5)
assert.strictEqual(hits.length, 3, '三条都应命中')
const touched = store.getMemory(ids[0])
assert.ok(Number(touched.access_count) >= 1, '检索应刷新调用次数')
assert.ok(Number(touched.L) >= 1, 'L 不应超过 1')

// 4) 压缩显示：full → summary → short → keyword
const full = store.getMemory(ids[0])
assert.ok(displayText(full).includes('花花'), 'full 应含全文')
store.zoneDb('context').prepare("UPDATE memories SET level='summary' WHERE id=?").run(ids[0])
assert.ok(displayText(store.getMemory(ids[0])).endsWith('…'), 'summary 应带省略号')
store.zoneDb('context').prepare("UPDATE memories SET level='short' WHERE id=?").run(ids[0])
assert.ok(displayText(store.getMemory(ids[0])).length <= 41, 'short 应截断到 40 字')
store.zoneDb('context').prepare("UPDATE memories SET level='keyword' WHERE id=?").run(ids[0])
assert.ok(displayText(store.getMemory(ids[0])).length <= 20, 'keyword 应截断到 20 字')

// 5) 跨区检索：手动把一条移到 knowledge，recall 仍应命中
store.updateZone(ids[1], 'knowledge')
const hits2 = recall(store, [0.1, 0.2, 0.3], 3, 0.5)
assert.ok(hits2.some((h) => h.id === ids[1]), '知识区记忆也应能检索到')

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL WORKFLOW TESTS PASSED')