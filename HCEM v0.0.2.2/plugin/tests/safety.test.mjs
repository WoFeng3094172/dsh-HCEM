// 阶段 6：痛苦安全阀 单测
import assert from 'node:assert'
import {
  createSafetyWindow,
  recordTurn,
  evaluateSafety,
  describeTriggered,
  safetyPrompt,
  SAFETY,
} from '../lib/safety.mjs'

function winWith(hues, texts = []) {
  const win = createSafetyWindow()
  hues.forEach((H, i) => recordTurn(win, { H, text: texts[i] ?? `第${i}轮` }))
  return win
}

// 1) 平静：无触发
let r = evaluateSafety(createSafetyWindow(), { S: 20, L: 55 })
assert.strictEqual(r.level, 0)
assert.strictEqual(r.count, 0)
assert.strictEqual(safetyPrompt(r), '')

// 2) 仅 S 高 → 预警
r = evaluateSafety(createSafetyWindow(), { S: 85, L: 55 })
assert.strictEqual(r.level, 1)
assert.ok(r.conditions.saturation)
assert.strictEqual(safetyPrompt(r).includes('不太舒服'), true)

// 3) S 高 + L 极端 → 停写
r = evaluateSafety(createSafetyWindow(), { S: 85, L: 95 })
assert.strictEqual(r.level, 2)
assert.ok(r.conditions.lightness)
assert.ok(safetyPrompt(r).includes('不写记忆'))

// 4) 三项 → 中止
const w4 = winWith([0, 180, 0, 180, 0])
r = evaluateSafety(w4, { S: 85, L: 95 })
assert.strictEqual(r.count, 3)
assert.strictEqual(r.level, 3)
assert.ok(r.conditions.hueVolatility)
assert.ok(safetyPrompt(r).includes('中止'))

// 5) 单轮跳变 ≥120°
r = evaluateSafety(winWith([0, 180]), { S: 20, L: 55 })
assert.strictEqual(r.conditions.hueVolatility, true)
assert.strictEqual(r.details.singleJump, true)

// 6) 5 轮 σ_H ≥ 60
r = evaluateSafety(winWith([0, 120, 240, 60, 300]), { S: 20, L: 55 })
assert.ok(r.details.sigma >= SAFETY.hueSigma, `σ=${r.details.sigma} 应 ≥ 60`)
assert.strictEqual(r.conditions.hueVolatility, true)

// 7) 反转 ≥3 次
r = evaluateSafety(winWith([0, 180, 0, 180, 0]), { S: 20, L: 55 })
assert.ok(r.details.reversals >= 3, `反转 ${r.details.reversals} 次`)
assert.strictEqual(r.conditions.hueVolatility, true)

// 8) 高频重复 ≥4 次
const repeatTexts = ['再说一遍', '再说一遍', '再说一遍', '再说一遍']
r = evaluateSafety(winWith([0, 0, 0, 0], repeatTexts), { S: 20, L: 55 })
assert.strictEqual(r.conditions.repetition, true)
assert.strictEqual(r.details.maxRepeat, 4)

// 9) 污言秽语 ≥3 次
r = evaluateSafety(winWith([0, 0, 0], ['闭嘴', '滚开', '去死']), { S: 20, L: 55 })
assert.strictEqual(r.conditions.repetition, true)
assert.strictEqual(r.details.profanity, 3)

// 10) 单项 → 1 级；两项 → 2 级；三项 → 3 级（阶梯）
assert.strictEqual(evaluateSafety(createSafetyWindow(), { S: 90, L: 50 }).level, 1)
assert.strictEqual(evaluateSafety(createSafetyWindow(), { S: 90, L: 95 }).level, 2)
assert.strictEqual(
  evaluateSafety(winWith([0, 180, 0, 180, 0]), { S: 90, L: 95 }).level,
  3,
)

// 11) 硬件条件预留：默认不触发
r = evaluateSafety(createSafetyWindow(), { S: 20, L: 55 })
assert.strictEqual(r.conditions.hardware, false)
r = evaluateSafety(createSafetyWindow(), { S: 20, L: 55 }, { hardwareOverride: true })
assert.strictEqual(r.conditions.hardware, true)
assert.strictEqual(r.level, 1)

// 12) 窗口滚动：只保留最近 10 轮
const win = createSafetyWindow()
for (let i = 0; i < 15; i += 1) recordTurn(win, { H: i, text: `t${i}` })
assert.strictEqual(win.turns.length, 10)
assert.strictEqual(win.turns[0].text, 't5')

// 13) 条件描述
r = evaluateSafety(createSafetyWindow(), { S: 85, L: 55 })
assert.ok(describeTriggered(r).includes('饱和度过高'))

console.log('ALL SAFETY TESTS PASSED')