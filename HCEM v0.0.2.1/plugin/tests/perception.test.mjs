// 感知适配器接口测试
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/perception'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`

const {
  PERCEPTION_VERSION, validatePerceptionInput, perceptionToMemory,
  registerAdapter, getAdapter, listAdapters, perceive,
} = await import('../lib/perception.mjs')
const { openStore } = await import('../lib/store.mjs')

// 1) 输入校验
assert.strictEqual(PERCEPTION_VERSION, 1)
assert.deepStrictEqual(validatePerceptionInput({ modality: 'audio', t_start: 1000, t_end: 2000 }), [])
assert.ok(validatePerceptionInput({ modality: 'x', t_start: 1, t_end: 2 }).length > 0)
assert.ok(validatePerceptionInput({ modality: 'audio', t_start: 2, t_end: 1 }).length > 0)
assert.ok(validatePerceptionInput({ modality: 'audio', t_start: 1, t_end: 2, sensory: 2 }).length > 0)

// 2) 转换：文字+情绪
const mem = perceptionToMemory({
  transcript: '视频里在讲天气',
  emotion: { H: 60, S: 40 },
  emotionConfidence: 0.8,
  sensory: 0.9,
  t_start: 1000,
  t_end: 3000,
  modality: 'audio',
})
assert.ok(mem.text.includes('天气'))
assert.strictEqual(mem.betaH, 60)
assert.strictEqual(mem.sensory, 0.9)
assert.strictEqual(mem.timeStart, 1000)
assert.strictEqual(mem.timeEnd, 3000)
assert.strictEqual(mem.modality, 'audio')
assert.ok(mem.gammaValue > 0.6) // 0.4 + 0.4*0.8

// 3) 适配器注册与调用
const custom = async (input) => ({ transcript: input.transcript ? input.transcript + '！' : '变了', emotion: { H: 120, S: 70 }, emotionConfidence: 0.9 })
registerAdapter('custom', custom)
assert.ok(listAdapters().includes('custom'))
assert.strictEqual(getAdapter('custom'), custom)
assert.strictEqual(getAdapter('none'), null)

const out = await perceive('custom', { modality: 'audio', t_start: 10, t_end: 20, transcript: '测试' })
assert.ok(out.text.startsWith('测试！'))
assert.strictEqual(out.modality, 'audio')

// 未注册适配器 → null
assert.strictEqual(await perceive('missing', { modality: 'audio', t_start: 1, t_end: 2 }), null)

// 4) 内建 mock 适配器可用
const mock = await perceive('mock', { modality: 'audio', t_start: 5, t_end: 15, caption: '有人在笑', emotion: { H: 0, S: 60 } })
assert.ok(mock.text.includes('有人在笑'))

// 5) 落库：time_start/time_end/modality/sensory
const store = openStore({ info() {}, warn() {} }, `${TMP}/hcem.sqlite`)
const id = store.putMemory(out)
const row = store.getMemory(id)
assert.strictEqual(Number(row.time_start), 10)
assert.strictEqual(Number(row.time_end), 20)
assert.strictEqual(row.modality, 'audio')
assert.strictEqual(Number(row.sensory), 1)
store.close()

fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL PERCEPTION TESTS PASSED')