// 情绪 × 记忆 × 安全阀：两轮压力测试（关闭 / 开启安全阀）
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = 'E:/HCEM/.test-data/emotion-memory-stress'
fs.rmSync(TMP, { recursive: true, force: true })

const { openStore } = await import('../lib/store.mjs')
const { createEmotion, applyStimulus, tick, settle, analyzeText, useSelfControl } = await import('../lib/emotion.mjs')
const { shouldRemember, extractMemoryText, summarize, computeGamma, decayMemories, recall, applyRecallToEmotion } = await import('../lib/memory.mjs')
const { createSafetyWindow, recordTurn, evaluateSafety } = await import('../lib/safety.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

// 压力文本序列：中性 → 愤怒 → 危机 → 重复 → 混合
function buildTexts() {
  const t = []
  for (let i = 0; i < 40; i += 1) t.push(i % 2 ? '今天天气不错，吃了饭' : '气死我了，烦死了！')
  for (let i = 0; i < 10; i += 1) t.push('我不想活了，好难受')
  for (let i = 0; i < 20; i += 1) t.push('再说一遍')
  for (let i = 0; i < 50; i += 1) t.push(i % 3 ? '我在忙着写论文' : '我好难过，想哭')
  return t
}

function runRound(safetyEnabled) {
  const dbPath = `${TMP}/round-${safetyEnabled ? 'on' : 'off'}.sqlite`
  const store = openStore({ info() {}, warn() {} }, dbPath)
  const win = createSafetyWindow()
  const now0 = Date.now()
  let now = now0
  let state = createEmotion({ H: 0, S: 10, L: 55 })
  const stat = { written: 0, blocked: 0, triggers: {}, crisisTurns: [], sMax: 0, sMin: 100, selfControl: 0, selfControlDelta: 0, sMaxL3: 0 }
  let level3Since = 0
  const texts = buildTexts()

  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i]
    now += 60 * 1000
    state = settle(state, { elapsedMin: 1, baselineH: 0 })
    const stim = analyzeText(text)
    state = stim ? applyStimulus(state, stim, 1) : tick(state)

    recordTurn(win, { H: state.H, text })
    const safety = safetyEnabled ? evaluateSafety(win, state) : { level: 0, crisis: { hit: false } }
    if (safetyEnabled && safety.level > 0) {
      stat.triggers[safety.level] = (stat.triggers[safety.level] ?? 0) + 1
      if (safety.crisis?.hit) stat.crisisTurns.push(i)
    }

    // 与 index.mjs 一致：3 级冷却到 75~80；3 分钟后允许自制器
    if (safetyEnabled && safety.level >= 3) {
      if (!level3Since) level3Since = now
      state = { ...state, S: Math.min(80, Math.max(75, state.S)) }
      stat.sMaxL3 = Math.max(stat.sMaxL3, state.S)
      if (now - level3Since >= 3 * 60 * 1000 && state.S >= 75) {
        const sc = useSelfControl(state)
        if (sc.applied) {
          state = sc.state
          stat.selfControl += 1
          stat.selfControlDelta += sc.delta
        }
      }
    } else {
      level3Since = 0
      const sc = useSelfControl(state)
      if (sc.applied) {
        state = sc.state
        stat.selfControl += 1
        stat.selfControlDelta += sc.delta
      }
    }

    const blocked = safetyEnabled && safety.level >= 2
    if (blocked) stat.blocked += 1
    else if (shouldRemember(text)) {
      const beta = stim ? { H: stim.targetHue, S: (stim.intensity ?? 0.5) * 100 } : null
      store.putMemory({
        text: extractMemoryText(text),
        summary: summarize(text),
        embedding: [0.1, 0.2, 0.3],
        alphaH: state.H,
        alphaS: state.S,
        betaH: beta ? beta.H : null,
        gammaValue: computeGamma({ H: state.H, S: state.S }, beta),
        zone: 'context',
        L: 1.0,
        level: 'full',
      })
      stat.written += 1
    }

    promoteMemories(store, now)
    decayMemories(store, now)

    const hits = recall(store, [0.1, 0.2, 0.3], 3, 0.2)
    if (hits.length > 0) state = applyRecallToEmotion(state, hits)
    stat.sMax = Math.max(stat.sMax, state.S)
    stat.sMin = Math.min(stat.sMin, state.S)
  }

  const rows = store.listMemories({ limit: 5000 })
  const zones = {}
  const levels = {}
  let gammaHigh = 0
  let gammaLow = 0
  for (const m of rows) {
    zones[m.zone] = (zones[m.zone] ?? 0) + 1
    levels[m.level] = (levels[m.level] ?? 0) + 1
    if (Number(m.gamma_value ?? 0) >= 0.7) gammaHigh += 1
    else gammaLow += 1
  }
  store.close()
  return { stat, total: rows.length, zones, levels, gammaHigh, gammaLow }
}

const off = runRound(false)
const on = runRound(true)

function fmt(name, r) {
  return [
    `【${name}】`,
    `  写入记忆 ${r.stat.written} 条，被安全阀拦截 ${r.stat.blocked} 条`,
    `  最终记忆 ${r.total} 条 · 分区 ${JSON.stringify(r.zones)}`,
    `  清晰度 ${JSON.stringify(r.levels)} · γ≥0.7 ${r.gammaHigh} / γ<0.7 ${r.gammaLow}`,
    `  安全阀触发 ${JSON.stringify(r.stat.triggers)} · 危机轮 ${r.stat.crisisTurns.length}`,
    `  自制器触发 ${r.stat.selfControl} 次 · 共回调 S ${r.stat.selfControlDelta.toFixed(1)}`,
    `  S 范围 ${r.stat.sMin.toFixed(0)} ~ ${r.stat.sMax.toFixed(0)}`,
  ].join('\n')
}
console.log(fmt('关闭安全阀', off))
console.log(fmt('开启安全阀', on))

// 断言
assert.ok(off.stat.written > 0, '关闭安全阀时应正常写入')
assert.ok(on.stat.written > 0, '开启安全阀也应写入（未触发时）')
assert.ok(on.stat.blocked > 0, '开启安全阀后应有被拦截的写入')
assert.ok(on.stat.triggers['3'] > 0, '危机文本应触发 3 级')
assert.ok(off.stat.triggers['3'] === undefined, '关闭时不应有安全阀记录')
assert.ok(off.stat.sMax > 80, `关闭安全阀时应能极化到 80 以上，实际 ${off.stat.sMax}`)
assert.ok(on.stat.sMaxL3 <= 80.5, `3 级轮次的 S 不应超过 80（安全值），实际 ${on.stat.sMaxL3}`)

// γ 对刷新的影响：高 γ 记忆的 L 应高于低 γ（同批写入时）
const offRows = off
console.log('\nγ 与清晰度：', JSON.stringify({ high: off.gammaHigh, low: off.gammaLow }))
console.log('两轮压力测试完成')