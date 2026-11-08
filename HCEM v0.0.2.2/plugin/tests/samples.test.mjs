// 情绪样本 / 基线 / 多戳聚合 单测
import assert from 'node:assert'
import { appendSample, computeBaseline, aggregateStamps } from '../lib/emotion-samples.mjs'
import { createEmotion, settle } from '../lib/emotion.mjs'

// 1) 追加样本
let list = []
list = appendSample(list, { H: 0, S: 10, L: 55 }, 1000)
assert.strictEqual(list.length, 1)
assert.ok(list[0].strengths.happy > 0.9)

// 2) 长期快乐样本 → 基线接近 0°
list = []
for (let i = 0; i < 100; i += 1) list = appendSample(list, { H: 0, S: 10, L: 55 }, 1000 + i)
const b1 = computeBaseline(list)
assert.ok(Math.min(b1.H, 360 - b1.H) < 5, `H=${b1.H}`)

// 3) 悲伤略多 → 基线偏向 180°
list = []
for (let i = 0; i < 60; i += 1) list = appendSample(list, { H: 180, S: 10, L: 55 }, 1000 + i)
for (let i = 0; i < 40; i += 1) list = appendSample(list, { H: 0, S: 10, L: 55 }, 2000 + i)
const b2 = computeBaseline(list)
assert.ok(b2.H >= 135 && b2.H <= 225, `H=${b2.H}`)

// 4) natural 限制在 ±15
assert.ok(b1.natural >= -15 && b1.natural <= 15)
assert.ok(b2.natural >= -15 && b2.natural <= 15)

// 5) 空样本回退
const b3 = computeBaseline([], { H: 0, S: 15, L: 55 })
assert.strictEqual(b3.count, 0)
assert.strictEqual(b3.S, 15)

// 6) 多戳聚合：γ 概率或，S 加权
const agg = aggregateStamps([
  { H: 0, S: 80, gamma: 0.9 },
  { H: 0, S: 40, gamma: 0.5 },
])
assert.ok(agg.gamma > 0.9 && agg.gamma < 1, `gamma=${agg.gamma}`)
assert.ok(agg.S > 40 && agg.S < 80, `S=${agg.S}`)
assert.strictEqual(agg.count, 2)

// 7) 对立色相聚合不爆、不 NaN
const agg2 = aggregateStamps([
  { H: 300, S: 70, gamma: 0.8 },
  { H: 180, S: 30, gamma: 0.2 },
])
assert.ok(Number.isFinite(agg2.H))
assert.ok(agg2.S >= 30 && agg2.S <= 70)

// 8) 空输入
assert.strictEqual(aggregateStamps([]), null)

// 9) 按时钟结算：60 分钟 → S 减 30、H 走一半
const st = createEmotion({ H: 300, S: 90, L: 55 })
const after = settle(st, { elapsedMin: 60, baselineH: 0 })
assert.ok(Math.abs(after.S - 60) < 0.001, `S=${after.S}`)
assert.ok(Math.abs(after.H - 330) < 0.001, `H=${after.H}`)

// 10) 0 分钟不变
const same = settle(st, { elapsedMin: 0, baselineH: 0 })
assert.strictEqual(same.S, 90)
assert.strictEqual(same.H, 300)

// 11) 10 分钟：S -5，H 走 10%
const small = settle(st, { elapsedMin: 10, baselineH: 0 })
assert.ok(Math.abs(small.S - 85) < 0.001, `S=${small.S}`)
assert.ok(Math.abs(small.H - 306) < 0.001, `H=${small.H}`)

console.log('ALL SAMPLES TESTS PASSED')