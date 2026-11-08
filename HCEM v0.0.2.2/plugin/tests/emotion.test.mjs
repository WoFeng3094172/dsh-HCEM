import assert from 'node:assert'
import {
  createEmotion,
  normalizeHue,
  circularDistance,
  moveHue,
  analyzeText,
  applyStimulus,
  tick,
  useSelfControl,
  toPromptText,
  nearestEmotion,
  DEFAULT_STATE,
} from '../lib/emotion.mjs'

// 1) 初始状态
const s0 = createEmotion()
assert.strictEqual(s0.H, 0, 'H=360 应归一化为 0')
assert.strictEqual(s0.S, DEFAULT_STATE.S)
assert.strictEqual(s0.L, DEFAULT_STATE.L)
assert.strictEqual(s0.cooldown, 0)

// 2) 环形
assert.strictEqual(normalizeHue(360), 0)
assert.strictEqual(normalizeHue(-60), 300)
assert.strictEqual(normalizeHue(420), 60)

// 3) 环形距离
assert.strictEqual(circularDistance(0, 180), 180)
assert.strictEqual(circularDistance(300, 60), 120)
assert.strictEqual(circularDistance(0, 300), 60)

// 4) 最短弧移动
assert.strictEqual(moveHue(300, 60, 0.5), 0, '300→60 走最短弧一半应到 0')
assert.strictEqual(moveHue(0, 60, 1), 60)

// 5) 词表
const happy = analyzeText('今天好开心，好耶')
assert.ok(happy, '应识别快乐')
assert.strictEqual(happy.targetHue, 0)
assert.ok(happy.intensity > 0)

const none = analyzeText('今天天气不错')
assert.strictEqual(none, null, '无情绪词应返回 null')

// 6) 刺激：S 上升，H 靠近目标色相
const s1 = applyStimulus(s0, { targetHue: 300, intensity: 1 })
assert.ok(s1.S > s0.S, '刺激应提升 S')
assert.ok(
  circularDistance(s1.H, 300) < circularDistance(s0.H, 300),
  'H 应更接近目标色相',
)

// 7) 自然衰减
const s2 = tick({ ...s0, S: 30 })
assert.strictEqual(s2.S, 27)

// 8) 自制器
const sc = useSelfControl({ ...s0, S: 80 })
assert.strictEqual(sc.applied, true)
assert.ok(sc.state.S < 80)
assert.strictEqual(sc.cooldownTurns, 3)
assert.ok(sc.state.cooldown === 3)

const sc2 = useSelfControl({ ...s0, S: 95 })
assert.strictEqual(sc2.applied, true)
assert.ok(sc2.delta <= 10, '单次上限 10 点')
assert.strictEqual(sc2.cooldownTurns, 5)

const sc3 = useSelfControl({ ...s0, S: 70 })
assert.strictEqual(sc3.applied, false)
assert.strictEqual(sc3.reason, 'below-threshold')

const sc4 = useSelfControl({ ...s0, S: 80, cooldown: 2 })
assert.strictEqual(sc4.applied, false)
assert.strictEqual(sc4.reason, 'cooldown')

// 9) 提示词
const text = toPromptText(s0)
assert.ok(text.includes('HCEM'))
assert.ok(text.includes('快乐'), 'H=0 应接近快乐')

// 10) 最近情绪
assert.strictEqual(nearestEmotion(0).name, '快乐')
assert.strictEqual(nearestEmotion(55).name, '惊讶')
assert.strictEqual(nearestEmotion(310).name, '愤怒')

console.log('ALL EMOTION TESTS PASSED')
