// 端到端集成测试（临时数据目录，不碰真实数据）
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/integration'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`
process.env.HCEM_PERSONA_DIR = `${TMP}/persona`
process.env.HCEM_JOURNAL_DIR = `${TMP}/journal`
process.env.HCEM_PEOPLE_DIR = `${TMP}/people`

const { openStore } = await import('../lib/store.mjs')
const { createEmotion, applyStimulus, settle } = await import('../lib/emotion.mjs')
const { recall, computeGamma, decayMemories } = await import('../lib/memory.mjs')
const { createSafetyWindow, recordTurn, evaluateSafety } = await import('../lib/safety.mjs')
const { buildRecall } = await import('../lib/hibernation.mjs')
const persona = await import('../lib/persona.mjs')
const journal = await import('../lib/journal.mjs')
const people = await import('../lib/people.mjs')
const { appendSample, computeBaseline, aggregateStamps } = await import('../lib/emotion-samples.mjs')

const store = openStore(console)
assert.ok(store, 'store 应能打开')

// 1) 情绪：刺激 → 按时钟结算
let state = createEmotion({ H: 0, S: 20, L: 55 })
state = applyStimulus(state, { targetHue: 300, intensity: 1 })
assert.ok(state.S >= 40, `S 应上升，实际 ${state.S}`)
const before = state.S
state = settle(state, { elapsedMin: 60, baselineH: 0 })
assert.ok(state.S < before, 'S 应随时间下降')
assert.ok(state.H > 330 && state.H < 360, `H 应沿最短弧从 0 走到 342、再回归到 351，实际 ${state.H}`)

// 2) γ 戳 + 记忆写入/检索/调用刷新
const gamma = computeGamma({ H: 300, S: 80 }, { H: 300, S: 75 })
assert.ok(gamma > 0.9, `γ 应接近 1，实际 ${gamma}`)
store.putMemory({
  text: '我叫小明，养了一只猫叫花花',
  embedding: [0.1, 0.2, 0.3],
  alphaH: 300,
  alphaS: 80,
  betaH: 300,
  gammaValue: gamma,
  zone: 'context',
})
const hits = recall(store, [0.1, 0.2, 0.3], 3, 0.3)
assert.strictEqual(hits.length, 1, '应检索到 1 条')
const touched = store.listMemories({ limit: 10 }).find((m) => m.id === hits[0].id)
assert.ok(Number(touched.access_count) >= 1, '检索应刷新调用次数')

// 3) 衰减：γ 高的记忆降得慢
const age = new Date(Date.now() - 120 * 3600 * 1000).toISOString()
// 模拟长期未调用：created_at 与 last_accessed_at 都退到 120 小时前
store.zoneDb('context').prepare('UPDATE memories SET created_at = ?, last_accessed_at = ?, updated_at = ? WHERE id = ?').run(age, age, age, hits[0].id)
const dec = decayMemories(store, Date.now())
assert.ok(dec > 0)
const decayed = store.getMemory(hits[0].id)
const plainL = Math.max(0, 1 - (120 / 240) * (1 - 0.5 * gamma))
assert.ok(Math.abs(Number(decayed.L) - plainL) < 0.06, `L=${decayed.L} 期望≈${plainL}`)

// 4) 冷存储回忆
const recallText = buildRecall('2026-10-28T15:00:00Z', { H: 300, S: 80, L: 55 }, [{ text: '我叫小明' }])
assert.ok(recallText.includes('冷存储'))
assert.ok(recallText.includes('H=300'))

// 5) 安全阀：危机信号直接 3 级
const win = createSafetyWindow()
recordTurn(win, { H: 180, text: '我不想活了' })
const safety = evaluateSafety(win, { S: 20, L: 55 })
assert.strictEqual(safety.level, 3)
assert.strictEqual(safety.crisis.hit, true)

// 6) 角色卡：写入 / 追加 / 局部删除
persona.savePersona('# 我是谁\n\n我叫鲸鲸。')
persona.appendPersona('## 新事\n\n学会了发呆。')
assert.ok(persona.loadPersona().includes('学会了发呆'))
const edit = persona.editPersona('学会了发呆。', '')
assert.strictEqual(edit.ok, true)
assert.ok(!persona.loadPersona().includes('学会了发呆'))

// 7) 日志 + 人物网
journal.writeJournal('2026-10-29', '# 今天\n\n和用户聊天。')
assert.strictEqual(journal.listJournal().length, 1)
people.writePerson('妈妈', '# 妈妈\n\n- 关系：母亲\n- 紧急联系人：是')
assert.strictEqual(people.listPeople()[0].emergency, true)

// 8) 情绪样本 → 基线；多戳聚合
let samples = []
for (let i = 0; i < 30; i += 1) samples = appendSample(samples, { H: 300, S: 70, L: 55 }, 1000 + i)
const b = computeBaseline(samples)
assert.ok(b.H >= 240 && b.H <= 360, `基线应在红色附近，实际 ${b.H}`)
const agg = aggregateStamps([
  { H: 0, S: 80, gamma: 0.9 },
  { H: 60, S: 40, gamma: 0.5 },
])
assert.ok(agg.gamma > 0.9 && agg.gamma <= 1)

store.close()
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL INTEGRATION TESTS PASSED')