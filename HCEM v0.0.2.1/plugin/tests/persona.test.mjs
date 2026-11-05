// 阶段 5：角色卡 + 性格滑块基线 单测
import assert from 'node:assert'
import fs from 'node:fs'
import { applyStimulus, createEmotion } from '../lib/emotion.mjs'
import { baselineFromSliders, loadSettings, saveSettings, normalizeSettings } from '../lib/settings.mjs'

const TMP = 'E:/HCEM/.test-data/persona'
process.env.HCEM_PERSONA_DIR = TMP
const persona = await import('../lib/persona.mjs')

// 1) 角色卡读写
fs.rmSync(TMP, { recursive: true, force: true })
assert.strictEqual(persona.loadPersona(), null)
assert.strictEqual(persona.loadUserCard(), null)
assert.strictEqual(persona.personaPrompt({}), '')

persona.savePersona('# 我是谁\n\n我叫鲸鲸。')
persona.saveUserCard('# 用户\n\n* 称呼：用户')
assert.strictEqual(persona.loadPersona(), '# 我是谁\n\n我叫鲸鲸。')
assert.strictEqual(persona.loadUserCard(), '# 用户\n\n* 称呼：用户')

const prompt = persona.personaPrompt({ persona: persona.loadPersona(), userCard: persona.loadUserCard() })
assert.ok(prompt.includes('[HCEM 角色卡]'), '应含角色卡标记')
assert.ok(prompt.includes('我叫鲸鲸'), '应含角色卡正文')
assert.ok(prompt.includes('[HCEM 用户卡]'), '应含用户卡标记')

// 2) 超长截断（截断发生在注入时，原文保持完整可编辑）
persona.savePersona('x'.repeat(persona.PERSONA_MAX_CHARS + 100))
assert.ok(persona.loadPersona().length > persona.PERSONA_MAX_CHARS, '原文应完整保存')
const longPrompt = persona.personaPrompt({ persona: persona.loadPersona() })
assert.ok(longPrompt.includes('…'), '注入时应截断并加省略号')
assert.ok(longPrompt.length <= persona.PERSONA_MAX_CHARS + 200, '注入文本应有上限')

// 3) 设置读写 + 越界收敛
const S = 'E:/HCEM/.test-data/settings.json'
fs.rmSync(S, { force: true })
assert.deepStrictEqual(loadSettings(S).sliders, { warmth: 0, tolerance: 0, optimism: 0 })

saveSettings(S, { sliders: { warmth: 50, tolerance: -50, optimism: 5 }, natural: { warmth: 99 } })
const loaded = loadSettings(S)
assert.strictEqual(loaded.sliders.warmth, 5, '滑块上限 5')
assert.strictEqual(loaded.sliders.tolerance, -5, '滑块下限 -5')
assert.strictEqual(loaded.natural.warmth, 15, '自然发展上限 15')
assert.deepStrictEqual(normalizeSettings(null).sliders, { warmth: 0, tolerance: 0, optimism: 0 })

// 4) 滑块 → 基线
const base = baselineFromSliders({})
assert.deepStrictEqual([base.H, base.S, base.L], [0, 15, 55], '居中为默认值')
assert.strictEqual(base.stimulusScale, 1)

const warm = baselineFromSliders({ warmth: 5 })
assert.strictEqual(warm.S, 20, '热情提高 S 基线')
assert.strictEqual(warm.H, 351, '热情向红 300° 偏 9°')

const cold = baselineFromSliders({ warmth: -5 })
assert.strictEqual(cold.S, 10, '冷漠降低 S 基线')
assert.strictEqual(cold.H, 9, '冷漠向青 120° 偏 9°')

const opt = baselineFromSliders({ optimism: 5 })
assert.strictEqual(opt.L, 60, '乐观提高 L 基线')
assert.strictEqual(opt.H, 351, '乐观向黄偏 9°')

const pes = baselineFromSliders({ optimism: -5 })
assert.strictEqual(pes.L, 50, '悲观降低 L 基线')
assert.strictEqual(pes.H, 9, '悲观向蓝 180° 偏 9°')

const tol = baselineFromSliders({ tolerance: 5 })
assert.ok(Math.abs(tol.stimulusScale - 0.95) < 1e-9, '宽容使刺激减弱 5%')
const picky = baselineFromSliders({ tolerance: -5 })
assert.ok(Math.abs(picky.stimulusScale - 1.05) < 1e-9, '挑剔使刺激增强 5%')

// 5) 刺激增益生效
const state = createEmotion({ H: 180, S: 50, L: 55 })
const stim = { targetHue: 300, intensity: 1 }
const normal = applyStimulus(state, stim)
const weak = applyStimulus(state, stim, 0.95)
const strong = applyStimulus(state, stim, 1.05)
assert.ok(Math.abs(normal.S - 70) < 1e-9, '默认 S 增量 20')
assert.ok(Math.abs(weak.S - 69) < 1e-9, '0.95 增益 → 增量 19')
assert.ok(Math.abs(strong.S - 71) < 1e-9, '1.05 增益 → 增量 21')
assert.strictEqual(strong.H, normal.H, '增益不影响色相移动')

// 6) 追加：不覆盖原文（AI 逐步补全用）
persona.savePersona('# 我是谁\n\n我叫鲸鲸。')
persona.appendPersona('## 新学会的事\n\n我最近学会发呆。')
const appended = persona.loadPersona()
assert.ok(appended.startsWith('# 我是谁'), '追加不应覆盖原文')
assert.ok(appended.includes('我最近学会发呆'), '追加内容应在末尾')

persona.appendUserCard('## 其它\n\n喜欢夜里听雨。')
assert.ok(persona.loadUserCard().includes('喜欢夜里听雨'), '用户卡也应支持追加')

// 7) 局部编辑 / 删除（防撑爆）
persona.savePersona('# 我是谁\n\n我叫鲸鲸。\n\n## 旧事\n\n这段要被删掉。\n\n## 留下\n\n这段保留。')
let e = persona.editPersona('这段要被删掉。', '')
assert.strictEqual(e.ok, true)
assert.strictEqual(e.removed, true)
const afterEdit = persona.loadPersona()
assert.ok(!afterEdit.includes('这段要被删掉'), '删除后不应再出现')
assert.ok(afterEdit.includes('这段保留'), '其它段落应保留')
assert.ok(!afterEdit.includes('\n\n\n'), '删除后不应留三连空行')

e = persona.editPersona('旧名字', '新名字')
assert.strictEqual(e.ok, false, '不存在的片段应失败')
assert.strictEqual(e.error, 'not-found')

persona.savePersona('重复内容\n\n重复内容\n\n尾巴')
e = persona.editPersona('重复内容', 'x')
assert.strictEqual(e.ok, false, '多处匹配应失败')
assert.strictEqual(e.error, 'ambiguous')

persona.savePersona('# A\n\n旧名字')
e = persona.editPersona('旧名字', '新名字')
assert.strictEqual(e.ok, true)
assert.ok(persona.loadPersona().includes('新名字'), '替换应生效')

e = persona.editPersona('', 'x')
assert.strictEqual(e.error, 'empty-find')

fs.rmSync(persona.PERSONA_PATH, { force: true })
e = persona.editPersona('x', 'y')
assert.strictEqual(e.error, 'card-empty')

// 清理
fs.rmSync(TMP, { recursive: true, force: true })
fs.rmSync(S, { force: true })
console.log('ALL PERSONA TESTS PASSED')