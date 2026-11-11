import assert from 'node:assert'
import { analyzeText, applyStimulus, tick, createEmotion } from '../lib/emotion.mjs'

// 模拟插件里 session/event 的处理逻辑（不依赖 DSH）
let state = createEmotion({ H: 360, S: 15, L: 55 })

function feed(text) {
  const stimulus = analyzeText(text)
  state = stimulus ? applyStimulus(state, stimulus) : tick(state)
  return { stimulus, state }
}

// 1) 开心消息 → 快乐，S 上升
const a = feed('今天好开心，哈哈哈哈')
assert.ok(a.stimulus, '应识别快乐')
assert.strictEqual(a.stimulus.emotion, '快乐')
assert.ok(a.state.S > 15, 'S 应上升')

// 2) 生气消息 → 愤怒，S 继续上升
const b = feed('气死我了，混蛋！')
assert.strictEqual(b.stimulus.emotion, '愤怒')
assert.ok(b.state.S > a.state.S, 'S 应继续上升')

// 3) 中性消息 → 无刺激，S 衰减 3
const c = feed('今天天气不错')
assert.strictEqual(c.stimulus, null)
assert.strictEqual(c.state.S, b.state.S - 3)

// 4) 连续中性消息 → S 逐步衰减到 0
let s = { H: 0, S: 10, L: 55, cooldown: 0 }
for (let i = 0; i < 5; i++) s = tick(s)
assert.strictEqual(s.S, 0, 'S 应衰减到 0')

// 5) H 在消息间应沿最短弧变化
const before = state.H
feed('我好难过，想哭')
assert.ok(
  Math.abs(((state.H - before + 540) % 360) - 180) < 180,
  'H 应在环形上移动',
)

console.log('ALL CONVERSATION SIM TESTS PASSED')
