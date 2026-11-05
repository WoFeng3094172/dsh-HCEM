// 日志本单测（阶段 4 遗留）
import assert from 'node:assert'
import fs from 'node:fs'

const DIR = 'E:/HCEM/.test-data/journal'
fs.rmSync(DIR, { recursive: true, force: true })
process.env.HCEM_JOURNAL_DIR = DIR
const j = await import('../lib/journal.mjs')

// 1) 空目录
assert.deepStrictEqual(j.listJournal(), [])

// 2) 写入（replace）
let r = j.writeJournal('2026-10-28', '# 今天\n\n和用户聊了开发。')
assert.strictEqual(r.ok, true)
assert.ok(r.chars > 0)
assert.strictEqual(fs.existsSync(`${DIR}/2026-10-28.md`), true)

// 3) 读取
let read = j.readJournal('2026-10-28')
assert.strictEqual(read.ok, true)
assert.ok(read.text.includes('和用户聊了开发'))

// 4) 追加
r = j.writeJournal('2026-10-28', '后来又改了测试。', 'append')
assert.strictEqual(r.ok, true)
read = j.readJournal('2026-10-28')
assert.ok(read.text.includes('和用户聊了开发'), '追加不应覆盖')
assert.ok(read.text.includes('后来又改了测试'), '追加内容应出现')

// 5) 列表 + 索引
const list = j.listJournal()
assert.strictEqual(list.length, 1)
assert.strictEqual(list[0].name, '2026-10-28')
assert.strictEqual(list[0].title, '今天')
assert.ok(list[0].summary.length > 0)
assert.strictEqual(fs.existsSync(`${DIR}/index.json`), true)
const index = JSON.parse(fs.readFileSync(`${DIR}/index.json`, 'utf8'))
assert.strictEqual(index.entries.length, 1)

// 6) 非法文件名
for (const bad of ['../evil', 'a/b', '.hidden', 'x'.repeat(80), '']) {
  assert.strictEqual(j.writeJournal(bad, 'x').error, 'invalid-name', `应拒绝 ${bad}`)
  assert.strictEqual(j.readJournal(bad).error, 'invalid-name', `读取应拒绝 ${bad}`)
}
assert.strictEqual(fs.existsSync(`${DIR}/evil.md`), false)

// 7) 超软上限提示
r = j.writeJournal('长文', 'x'.repeat(j.JOURNAL_SOFT_MAX + 1))
assert.strictEqual(r.ok, true)
assert.ok(r.warning && r.warning.includes('软上限'))

// 8) 读取不存在
assert.strictEqual(j.readJournal('没有这篇').error, 'not-found')

// 9) 中文名可用
r = j.writeJournal('关于用户', '# 用户\n\n喜欢睡觉。')
assert.strictEqual(r.ok, true)
assert.strictEqual(j.listJournal().length, 3)

// 清理
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL JOURNAL TESTS PASSED')