// 阶段 8：冷存储回忆 单测
import assert from 'node:assert'
import { buildRecall } from '../lib/hibernation.mjs'

// 1) 没有冷存储标记 → 空串
assert.strictEqual(buildRecall('', null, []), '')
assert.strictEqual(buildRecall(null, null, []), '')

// 2) 有标记、无情绪 → 仍生成回忆，情绪标未知
const r1 = buildRecall('2026-10-28T15:00:00.000Z', null, [])
assert.ok(r1.includes('冷存储'))
assert.ok(r1.includes('未知'))

// 3) 有情绪 + 记忆摘要
const r2 = buildRecall('2026-10-28T15:00:00.000Z', { H: 52, S: 10, L: 55 }, [
  { text: '我叫小明，养了一只猫叫花花' },
  { text: '最近在忙着写论文' },
])
assert.ok(r2.includes('H=52°'))
assert.ok(r2.includes('S=10%'))
assert.ok(r2.includes('我叫小明'))
assert.ok(r2.includes('写论文'))
assert.ok(r2.includes('不要假装失忆'))

// 4) 长文本截断 + 换行拍平
const long = 'x'.repeat(120) + '\n第二行'
const r3 = buildRecall('2026-10-28T15:00:00.000Z', { H: 0, S: 0, L: 50 }, [{ text: long }])
const line = r3.split('\n').find((l) => l.startsWith('- '))
assert.ok(line.length <= 52, '摘要行应截断')
assert.ok(!line.includes('\n'))

// 5) 无效日期不崩
const r4 = buildRecall('not-a-date', { H: 1, S: 2, L: 3 }, [])
assert.ok(r4.includes('not-a-date'))

console.log('ALL HIBERNATION TESTS PASSED')