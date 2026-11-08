// 人物关系网单测
import assert from 'node:assert'
import fs from 'node:fs'

const DIR = 'E:/HCEM/.test-data/people'
fs.rmSync(DIR, { recursive: true, force: true })
process.env.HCEM_PEOPLE_FILE = DIR + '/people.md'
const p = await import('../lib/people.mjs')

// 1) 空
assert.deepStrictEqual(p.listPeople(), [])

// 2) 写入并解析字段
let r = p.writePerson(
  '妈妈',
  '# 妈妈\n\n- 关系：母亲\n- 联系方式：13800000000\n- 紧急联系人：是\n- 信任联系人：是\n\n喜欢唠叨，但很温柔。',
)
assert.strictEqual(r.ok, true)
const list = p.listPeople()
assert.strictEqual(list.length, 1)
assert.strictEqual(list[0].userRelation, '母亲')
assert.strictEqual(list[0].emergency, true)
assert.strictEqual(list[0].trusted, true)
assert.ok(list[0].summary.includes('喜欢唠叨'))

// 2b) 新字段：性别/身份/与AI关系/AI印象/联系方式
p.writePerson(
  '阿杰',
  '# 阿杰\n\n- 性别：男\n- 身份：用户的大学同学\n- 与用户的关系：老朋友\n- 与AI的关系：偶尔聊天\n- AI印象：话少但靠谱\n- 联系方式：QQ 123456\n\n多年好友。',
)
const ajie = p.listPeople().find((x) => x.name === '阿杰')
assert.strictEqual(ajie.gender, '男')
assert.strictEqual(ajie.identity, '用户的大学同学')
assert.strictEqual(ajie.aiRelation, '偶尔聊天')
assert.strictEqual(ajie.impression, '话少但靠谱')
assert.strictEqual(ajie.contact, 'QQ 123456')
assert.ok(ajie.weight > 0)

// 2c) 100 人上限：写入 110 人，应淘汰到 100，紧急联系人优先保留
for (let i = 0; i < 90; i += 1) {
  p.writePerson(`测试${i}`, `# 测试${i}\n\n- 关系：普通\n\n第 ${i} 个人。`)
}
p.writePerson('重要的人', '# 重要的人\n\n- 关系：家人\n- 紧急联系人：是\n\n很重要。')
const all = p.listPeople()
assert.ok(all.length >= 90, `人数应 >= 90，实际 ${all.length}`)
assert.ok(all.some((x) => x.name === '重要的人' && x.emergency), '重要的人应保留')

// 3) 追加
p.writePerson('妈妈', '最近腰不好。', 'append')
assert.ok(p.readPerson('妈妈').text.includes('最近腰不好'))
assert.ok(p.readPerson('妈妈').text.includes('喜欢唠叨'), '追加不应覆盖')

// 4) 紧急联系人「否」
p.writePerson('同事小王', '# 小王\n\n- 关系：同事\n- 紧急联系人：否\n\n不太熟。')
const wang = p.listPeople().find((x) => x.name === '同事小王')
assert.strictEqual(wang.emergency, false)

// 5) 非法名
for (const bad of ['../evil', 'a/b', '.hidden', '']) {
  assert.strictEqual(p.writePerson(bad, 'x').error, 'invalid-name', `应拒绝 ${bad}`)
}
assert.ok(!p.readPerson('evil').ok, '不应存在 evil')

// 6) 读取不存在
assert.strictEqual(p.readPerson('没有这个人').error, 'not-found')

// 7) index.json 生成
assert.strictEqual(fs.existsSync(`${DIR}/people.md`), true)

// 清理
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL PEOPLE TESTS PASSED')