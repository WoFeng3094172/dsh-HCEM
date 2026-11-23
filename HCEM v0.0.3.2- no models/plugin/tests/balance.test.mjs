import assert from 'node:assert'
import { emotionStrengths } from '../lib/emotion.mjs'

// 1) 在快乐极点（H=0）：黄最强、蓝最弱
const at0 = emotionStrengths(0)
assert.ok(Math.abs(at0.happy - 1) < 0.001, 'H=0 时快乐应最强')
assert.ok(Math.abs(at0.sadness - 0) < 0.001, 'H=0 时悲伤应为 0')

// 2) 在悲伤极点（H=180）：蓝最强、黄最弱
const at180 = emotionStrengths(180)
assert.ok(Math.abs(at180.sadness - 1) < 0.001, 'H=180 时悲伤应最强')
assert.ok(Math.abs(at180.happy - 0) < 0.001, 'H=180 时快乐应为 0')

// 3) 中点（H=90）：黄蓝各一半
const at90 = emotionStrengths(90)
assert.ok(Math.abs(at90.happy - 0.5) < 0.001)
assert.ok(Math.abs(at90.sadness - 0.5) < 0.001)

// 4) 对任意角度，三组对立色强度之和恒为 1（情绪平衡的核心）
const pairs = [
  ['happy', 'sadness'],
  ['surprise', 'disgust'],
  ['anger', 'fear'],
]
for (let h = 0; h < 360; h += 10) {
  const s = emotionStrengths(h)
  for (const [a, b] of pairs) {
    assert.ok(
      Math.abs(s[a] + s[b] - 1) < 0.001,
      `H=${h} 时 ${a}+${b} 应恒等于 1（实际 ${(s[a] + s[b]).toFixed(3)}）`,
    )
  }
}

// 5) 此消彼长：从黄(0°)走向蓝(180°)，快乐递减、悲伤递增
let prevHappy = emotionStrengths(0).happy
let prevSad = emotionStrengths(0).sadness
for (let h = 30; h <= 180; h += 30) {
  const s = emotionStrengths(h)
  assert.ok(s.happy < prevHappy, `H=${h} 快乐应比上一档更低`)
  assert.ok(s.sadness > prevSad, `H=${h} 悲伤应比上一档更高`)
  prevHappy = s.happy
  prevSad = s.sadness
}

// 6) 其它两对同样成立：红(300)↔青(120)
const at300 = emotionStrengths(300)
assert.ok(Math.abs(at300.anger - 1) < 0.001)
assert.ok(Math.abs(at300.fear - 0) < 0.001)

console.log('ALL BALANCE TESTS PASSED')
