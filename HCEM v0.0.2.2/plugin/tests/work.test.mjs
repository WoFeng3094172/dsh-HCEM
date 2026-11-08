// 工作记忆测试（文件组 + 75% 提醒）
import assert from 'node:assert'
import fs from 'node:fs'

const DIR = 'E:/HCEM/.test-data/work'
fs.rmSync(DIR, { recursive: true, force: true })
process.env.HCEM_WORK_DIR = DIR
const w = await import('../lib/work.mjs')

// 1) 空
assert.deepStrictEqual(w.listWork(), [])
assert.strictEqual(w.workTotalChars(), 0)

// 2) 写入 + 追加
let r = w.writeWork('论文写作', '第一章：绪论。')
assert.strictEqual(r.ok, true)
assert.ok(r.chars > 0)
r = w.writeWork('论文写作', '第二章：方法。', 'append')
const read = w.readWork('论文写作')
assert.ok(read.ok)
assert.ok(read.text.includes('第一章'))
assert.ok(read.text.includes('第二章'), 'append 不应覆盖')

// 3) 列表
const list = w.listWork()
assert.strictEqual(list.length, 1)
assert.strictEqual(list[0].name, '论文写作')

// 4) 非法名
assert.strictEqual(w.writeWork('../evil', 'x').error, 'invalid-name')
assert.strictEqual(fs.existsSync(`${DIR}/evil.md`), false)

// 5) 75% 提醒：写入大量内容
const big = '工作内容'.repeat(1500) // 6000 字
let warned = false
for (let i = 0; i < 4; i += 1) {
  const res = w.writeWork(`大文件${i}`, big)
  if (res.warning) warned = true
}
assert.ok(warned, '超过 75% 应触发提醒')
const usage = w.workUsage()
assert.ok(usage.ratio >= 0.75, `usage.ratio 应 >= 0.75，实际 ${usage.ratio}`)

fs.rmSync(DIR, { recursive: true, force: true })
console.log('ALL WORK TESTS PASSED')