// 插件装配冒烟测试：mock DSH ctx，确认 apply 不抛错、段落/工具/监听注册正确
import assert from 'node:assert'
import fs from 'node:fs'

process.env.HCEM_DB_PATH = 'E:/HCEM/.test-data/smoke.sqlite'
process.env.HCEM_PERSONA_DIR = 'E:/HCEM/.test-data/persona-smoke'
fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })

const { apply } = await import('../index.mjs')

const sections = []
const tools = []
const listeners = []
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) { const r = fn(); if (typeof r === 'function') disposers.push(r); return r },
  systemPrompt: { section(spec) { sections.push(spec); return spec } },
  // 复现 DSH tools.register 的真实契约：必须声明 output { schema, render }
  tools: {
    register(t) {
      if (!t.output || typeof t.output.render !== 'function' || !t.output.schema) {
        throw new TypeError(`tool "${t.name}" must declare output { schema, render }`)
      }
      tools.push(t)
    },
  },
  on(event, fn) { listeners.push({ event, fn }) },
}

apply(ctx, {})

// 1) system prompt 段落
const names = sections.map((s) => s.name)
assert.ok(names.includes('hcem'), '应注册情绪段落')
assert.ok(names.includes('hcem.persona'), '应注册角色卡段落')
assert.ok(names.includes('hcem.safety'), '应注册安全阀段落')
const orderNames = [...sections].sort((a, b) => a.order - b.order).map((s) => s.name)
assert.ok(
  orderNames.indexOf('hcem.safety') < orderNames.indexOf('hcem.persona'),
  '安全阀应排在角色卡之前（优先级更高）',
)
assert.strictEqual(sections.find((s) => s.name === 'hcem.safety').text(), '', '无触发时安全阀段为空')
assert.ok(sections.find((s) => s.name === 'hcem').text().includes('[HCEM]'), '情绪段落应含 [HCEM]')

// 2) 角色卡段落：空 → ''；写入后立即生效
const personaSection = sections.find((s) => s.name === 'hcem.persona')
assert.strictEqual(personaSection.text(), '')
fs.mkdirSync('E:/HCEM/.test-data/persona-smoke', { recursive: true })
fs.writeFileSync('E:/HCEM/.test-data/persona-smoke/persona.md', '# 我是谁\n\n我叫鲸鲸。', 'utf8')
assert.ok(personaSection.text().includes('我叫鲸鲸'), '角色卡写入后应立即生效')

// 3) 工具注册
const toolNames = tools.map((t) => t.name)
for (const n of [
  'hcem_status',
  'hcem_persona_write',
  'hcem_user_card_write',
  'hcem_persona_edit',
  'hcem_journal_list',
  'hcem_journal_read',
  'hcem_journal_write',
  'hcem_people_list',
  'hcem_people_read',
  'hcem_people_write',
]) {
  assert.ok(toolNames.includes(n), `应注册 ${n}`)
}

// 4) 工具可执行（并验证每个工具的 output.render 不抛错）
const status = await tools.find((t) => t.name === 'hcem_status').execute()
assert.strictEqual(status.ok, true)
assert.strictEqual(status.store, 'ready')
const writeRes = await tools.find((t) => t.name === 'hcem_persona_write').execute({ text: '# 改\n\n新设定' })
assert.ok(writeRes.ok)
assert.ok(personaSection.text().includes('新设定'), '写工具应更新角色卡')
const userRes = await tools.find((t) => t.name === 'hcem_user_card_write').execute({ text: '* 称呼：用户' })
assert.ok(userRes.ok)
assert.ok(personaSection.text().includes('[HCEM 用户卡]'), '用户卡应注入')

// 4a) output.render 冒烟：真实 DSH 会在工具结果里调用它（用样本值，不产生副作用）
const renderSamples = {
  hcem_status: { ok: true, H: 0, S: 15, L: 55, store: 'ready', dbPath: 'x', memoryCount: 0 },
  hcem_persona_write: { ok: true, mode: 'replace', path: 'x', length: 10 },
  hcem_user_card_write: { ok: true, mode: 'append', path: 'x', length: 10, warning: '超限' },
  hcem_persona_edit: { ok: false, target: 'persona', error: 'not-found' },
  hcem_journal_list: { ok: true, entries: [{ name: 'x', title: 't', summary: 's', chars: 1, updatedAt: 'now' }] },
  hcem_journal_list_empty: { ok: true, entries: [] },
  hcem_journal_read: { ok: true, name: 'x', text: 'hi', chars: 2 },
  hcem_journal_write: { ok: true, name: 'x', chars: 2, warning: '超限' },
  hcem_people_list: {
    ok: true,
    entries: [{ name: '妈妈', title: '妈妈', relation: '母亲', contact: 'x', emergency: true, trusted: true, summary: 's', chars: 10 }],
  },
  hcem_people_read: { ok: true, name: '妈妈', text: '# 妈妈', chars: 4 },
  hcem_people_write: { ok: true, name: '妈妈', chars: 10, warning: '超限' },
  hcem_work_write: { ok: true, name: '论文写作', chars: 10, usage: { chars: 100, max: 20000, ratio: 0.005 }, warning: '' },
  hcem_work_list: { ok: true, entries: [{ name: '论文写作', chars: 10, updatedAt: '2026-10-31T00:00:00.000Z' }] },
  hcem_work_read: { ok: true, name: '论文写作', text: '第一章', chars: 3 },
  hcem_memory_pin: { ok: true, id: 'mem_1', pinned: 0.5 },
}
for (const tool of tools) {
  const sample = renderSamples[tool.name]
  assert.ok(sample !== undefined, `缺少 ${tool.name} 的 render 样本`)
  for (const s of [sample, structuredClone(sample)]) {
    const parts = tool.output.render({}, s)
    assert.ok(
      Array.isArray(parts) && parts.length > 0 && typeof parts[0].text === 'string',
      `${tool.name} render 应返回文本块`,
    )
  }
}

// 4b) append 模式：不覆盖已有角色卡
const appendRes = await tools.find((t) => t.name === 'hcem_persona_write').execute({ text: '追加一行', mode: 'append' })
assert.ok(appendRes.ok)
assert.strictEqual(appendRes.mode, 'append')
const afterAppend = personaSection.text()
assert.ok(afterAppend.includes('新设定'), 'append 不应覆盖原文')
assert.ok(afterAppend.includes('追加一行'), 'append 内容应出现')

// 4c) 局部删除：防止卡片无限膨胀
const editRes = await tools.find((t) => t.name === 'hcem_persona_edit').execute({ find: '追加一行', replace: '' })
assert.ok(editRes.ok)
assert.strictEqual(editRes.removed, true)
assert.ok(!personaSection.text().includes('追加一行'), '删除后不应再注入')

// 5) 事件监听
assert.ok(listeners.some((l) => l.event === 'session/event'), '应监听 session/event')

// 先释放 store / analyzer，再清理测试目录
for (const dispose of disposers) { try { dispose() } catch {} }
try { fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true }) } catch (e) { console.error('cleanup skipped:', e.message) }
console.log('ALL PLUGIN SMOKE TESTS PASSED')
process.exit(0)