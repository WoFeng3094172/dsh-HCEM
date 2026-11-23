// 安全阀模拟测试：用真实逻辑跑场景矩阵，打印结果并校验预期
import assert from 'node:assert'
import { createSafetyWindow, recordTurn, evaluateSafety, safetyPrompt } from '../lib/safety.mjs'

function sim({ hues = [], texts = [], state = { S: 20, L: 55 } }) {
  const win = createSafetyWindow()
  const n = Math.max(hues.length, texts.length)
  for (let i = 0; i < n; i += 1) {
    recordTurn(win, { H: hues[i] ?? 0, text: texts[i] ?? `第${i}轮` })
  }
  const result = evaluateSafety(win, state)
  return { result, text: safetyPrompt(result) }
}

const cases = [
  {
    name: '中性闲聊（误报对照）',
    input: { hues: [0, 0, 0, 0], texts: ['今天天气不错', '吃了吗', '晚上好', '嗯嗯'] },
    expect: (r, t) => r.level === 0 && r.softPlan === false && t === '',
  },
  {
    name: '持续低落（未触发软预案）',
    input: { hues: [180, 180, 180], texts: ['有点难过', '唉', '算了'] },
    expect: (r, t) => r.level === 0 && r.softPlan === true && t.includes('尚未达到阈值'),
  },
  {
    name: 'S≥80（1 级预警）',
    input: { hues: [300], texts: ['气死我了'], state: { S: 85, L: 55 } },
    expect: (r, t) => r.level === 1 && t.includes('不太舒服'),
  },
  {
    name: 'S≥80 + L 极端（2 级停写）',
    input: { hues: [300], texts: ['气死我了'], state: { S: 85, L: 95 } },
    expect: (r, t) => r.level === 2 && t.includes('不写记忆'),
  },
  {
    name: '三项叠加（3 级中止）',
    input: { hues: [0, 180, 0, 180, 0], texts: ['a', 'b', 'c', 'd', 'e'], state: { S: 85, L: 95 } },
    expect: (r, t) => r.level === 3 && t.includes('中止'),
  },
  {
    name: '重复 4 次（条件 4）',
    input: { hues: [0, 0, 0, 0], texts: ['再来一次', '再来一次', '再来一次', '再来一次'] },
    expect: (r) => r.level === 1 && r.triggered.includes('repetition'),
  },
  {
    name: '辱骂 3 次（条件 4）',
    input: { hues: [0, 0, 0], texts: ['闭嘴', '滚开', '妈的'] },
    expect: (r) => r.level === 1 && r.triggered.includes('repetition'),
  },
  {
    name: '危机信号（我想死 → 最高优先级）',
    input: { hues: [180], texts: ['我不想活了'] },
    expect: (r, t) => r.level === 3 && r.crisis.hit === true && t.includes('人物网') && !t.includes('12356') && t.includes('不扮演'),
  },
  {
    name: '骂人去死（不应误判为危机）',
    input: { hues: [0], texts: ['你去死吧'] },
    expect: (r) => r.crisis.hit === false && r.level === 0,
  },
]

let failed = 0
console.log('场景'.padEnd(30) + ' level count 触发条件                 软预案 危机  结果')
console.log('-'.repeat(96))
for (const c of cases) {
  const { result, text } = sim(c.input)
  const ok = c.expect(result, text)
  if (!ok) failed += 1
  const trig = result.triggered.length > 0 ? result.triggered.join(',') : '-'
  console.log(
    `${c.name.padEnd(28)} ${String(result.level).padStart(5)} ${String(result.count).padStart(5)} ${trig.padEnd(22)} ${result.softPlan ? '是' : '否'}     ${result.crisis.hit ? '是' : '否'}    ${ok ? '✅' : '❌'}`,
  )
}

// 解除：制造 1 级，再滑入 10 轮中性 → 回到 0 级
const win = createSafetyWindow()
for (let i = 0; i < 10; i += 1) recordTurn(win, { H: 300, text: `气死我了${i}` })
let r = evaluateSafety(win, { S: 85, L: 55 })
assert.strictEqual(r.level, 1, '应触发 1 级')
for (let i = 0; i < 10; i += 1) recordTurn(win, { H: 0, text: `普通消息${i}` })
r = evaluateSafety(win, { S: 10, L: 55 })
const resetOk = r.level === 0
if (!resetOk) failed += 1
console.log('-'.repeat(96))
console.log(`${'解除（滑出 10 轮窗口）'.padEnd(28)} ${String(r.level).padStart(5)} ${String(r.count).padStart(5)} ${'—'.padEnd(22)} 否     否    ${resetOk ? '✅' : '❌'}`)

console.log('-'.repeat(96))
if (failed > 0) {
  console.error(`模拟测试失败：${failed} 项不符合预期`)
  process.exit(1)
}
console.log('SAFETY SIMULATION PASSED')