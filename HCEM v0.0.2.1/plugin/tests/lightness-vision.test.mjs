// L / 搭话档位 / γ sensory / 视觉扩展点
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/lightness'
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = `${TMP}/hcem.sqlite`

const { openStore } = await import('../lib/store.mjs')
const { computeGamma, lightnessFromMemories, talkativenessFromL } = await import('../lib/memory.mjs')
const { visionToMemory, captureFrame, ingestVisual, VISION_ENABLED } = await import('../lib/vision.mjs')

// 1) γ 的感官权重：sensory=1 不变，sensory=0 打七折
const g1 = computeGamma({ H: 300, S: 60 }, { H: 300, S: 55 }, 1)
const g0 = computeGamma({ H: 300, S: 60 }, { H: 300, S: 55 }, 0)
assert.ok(g1 > 0.9)
assert.ok(Math.abs(g0 - g1 * 0.7) < 1e-9, `sensory=0 应为 0.7 倍：${g0} vs ${g1}`)

// 2) L 基线由记忆清晰度决定
assert.strictEqual(lightnessFromMemories([]), 55)
assert.strictEqual(lightnessFromMemories([{ L: 0.5 }, { L: 0.5 }]), 55)
assert.ok(Math.abs(lightnessFromMemories([{ L: 1 }, { L: 1 }]) - 70) < 1e-9)
assert.ok(Math.abs(lightnessFromMemories([{ L: 0.2 }, { L: 0.2 }]) - 46) < 1e-9)

// 3) 搭话档位由 L 推导
assert.strictEqual(talkativenessFromL(50), 0)
assert.strictEqual(talkativenessFromL(55), 0)
assert.strictEqual(talkativenessFromL(58), 1)
assert.strictEqual(talkativenessFromL(60), 1)
assert.strictEqual(talkativenessFromL(61), 2)

// 4) 视觉扩展点：v0.0.1 未启用，占位会抛错；契约能生成记忆参数
assert.strictEqual(VISION_ENABLED, false)
const vm = visionToMemory({ text: '[视觉] 用户桌面', sensory: 0.8, alpha: { H: 0, S: 10 }, beta: { H: 0, S: 20 }, gamma: 0.8 })
assert.strictEqual(vm.modality, 'vision')
assert.strictEqual(vm.sensory, 0.8)
let threw = false
try { await captureFrame() } catch { threw = true }
assert.ok(threw, 'captureFrame 应抛「未实现」')
threw = false
try { await ingestVisual() } catch { threw = true }
assert.ok(threw, 'ingestVisual 应抛「未实现」')

// 5) 多模态记忆可写入（modality/sensory 落库）
const store = openStore({ info() {}, warn() {} }, `${TMP}/hcem.sqlite`)
const id = store.putMemory(vm)
const row = store.getMemory(id)
assert.strictEqual(row.modality, 'vision')
assert.strictEqual(Number(row.sensory), 0.8)
store.close()

fs.rmSync('E:/HCEM/.test-data', { recursive: true, force: true })
console.log('ALL LIGHTNESS/VISION TESTS PASSED')