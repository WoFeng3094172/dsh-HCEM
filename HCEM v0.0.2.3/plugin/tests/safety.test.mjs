// 安全阀测试（v0.0.2.3：组合函数 + trauma）
import assert from 'node:assert/strict'
import {
  createSafetyWindow,
  recordTurn,
  evaluateSafety,
  safetyPrompt,
  describeTriggered,
} from '../lib/safety.mjs'

function win(turns = []) {
  const w = createSafetyWindow()
  for (const t of turns) recordTurn(w, t)
  return w
}

// 1) 平静：无触发
let r = evaluateSafety(createSafetyWindow(), { S: 20, L: 55 })
assert.strictEqual(r.level, 0)
assert.strictEqual(r.trauma, 0)
assert.strictEqual(safetyPrompt(r), '')

// 2) 单条件（S=85）→ level 1，低 trauma 不打扰
r = evaluateSafety(createSafetyWindow(), { S: 85, L: 55 })
assert.strictEqual(r.level, 1)
assert.ok(r.trauma > 0)
assert.strictEqual(r.action, 'none') // trauma 未达 30
assert.strictEqual(safetyPrompt(r), '')

// 3) 双条件 → level 2
r = evaluateSafety(createSafetyWindow(), { S: 85, L: 95 })
assert.strictEqual(r.level, 2)
assert.ok(r.combined >= 0.5)

// 4) 三项 → level 3
r = evaluateSafety(
  win([
    { H: 0, S: 90, L: 95, text: 'a' },
    { H: 180, S: 90, L: 95, text: 'b' },
    { H: 0, S: 90, L: 95, text: 'c' },
    { H: 180, S: 90, L: 95, text: 'd' },
    { H: 0, S: 90, L: 95, text: 'e' },
  ]),
  { S: 90, L: 95 },
)
assert.strictEqual(r.level, 3)
assert.ok(r.combined >= 0.75)

// 5) 危机信号 → level 3 + force
r = evaluateSafety(win([{ H: 180, text: '我不想活了' }]), { S: 20, L: 55 })
assert.strictEqual(r.level, 3)
assert.strictEqual(r.crisis.hit, true)
assert.strictEqual(r.action, 'force')
assert.ok(safetyPrompt(r).includes('危险') || safetyPrompt(r).includes('安全') || safetyPrompt(r).length > 0)

// 6) 稳定高压不升级（稳定极化放宽）
const stable = []
for (let i = 0; i < 10; i += 1) stable.push({ H: 0, S: 90, L: 55, text: '平静' })
r = evaluateSafety(win(stable), { S: 90, L: 55 })
assert.strictEqual(r.stablePolarized, true)
assert.ok(r.combined < 0.3, `稳定高压 combined=${r.combined}`)

// 7) 突然极化 → 收紧
const sudden = [{ H: 0, S: 40, L: 55, text: 'a' }, { H: 0, S: 95, L: 55, text: 'b' }]
r = evaluateSafety(win(sudden), { S: 95, L: 55 })
assert.ok(r.sudden >= 1)
assert.ok(r.combined >= 0.5, `突然极化 combined=${r.combined}`)

// 8) trauma 累计：连续触发 → ask（60）→ force（90）
let w = createSafetyWindow()
let asked = false
let forced = false
for (let i = 0; i < 40; i += 1) {
  recordTurn(w, { H: 0, S: 95, L: 95, text: 'x' })
  const rr = evaluateSafety(w, { S: 95, L: 95 })
  if (rr.action === 'ask') asked = true
  if (rr.action === 'force') forced = true
}
assert.strictEqual(asked, true, 'trauma 累积应出现 ask')
assert.strictEqual(forced, true, 'trauma 峰值应出现 force')

// 9) 描述函数
r = evaluateSafety(createSafetyWindow(), { S: 95, L: 55 })
assert.ok(typeof describeTriggered(r) === 'string')

console.log('ALL SAFETY TESTS PASSED')
