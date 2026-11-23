/**
 * 工具分类头（默认关闭）
 *
 * 目标：在「向量检索」之外，学一个「在当前情绪/资源状态下，我该选哪个工具」的线性打分头。
 * 注意：它**不改检索基线**，只在最终排序上做一个可解释的混合：
 *
 *     final = (1 - α) · cos + α · headProb
 *
 * 训练数据必须来自真实选择日志（data/classifier/labels.jsonl），
 * 绝不允许用模型自己的输出来当标签（会自我强化）。
 *
 * 模型：每个工具一组权重 W[tool][feat]，特征 = 查询向量(1024) + 状态(4: H,S,L,aqua)。
 * 训练：one-vs-rest 逻辑回归，SGD + L2，5 epoch 足够（样本少时更快）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import '../home.mjs'
import { join, dirname } from 'node:path'

export const CLASSIFIER_DIR = `${globalThis.__HCEM_HOME__}/data/classifier`
export const MODEL_PATH = join(CLASSIFIER_DIR, 'head.json')
export const LABELS_PATH = join(CLASSIFIER_DIR, 'labels.jsonl')
export const STATE_PATH = `${globalThis.__HCEM_HOME__}/data/ui-state/classifier.json`

const STATE_DIM = 4 // H/360, S/100, L/100, aqua/100
const ALPHA_DEFAULT = 0.3

export function loadConfig() {
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return {
      enabled: j?.enabled === true,
      alpha: Number.isFinite(Number(j?.alpha)) ? Math.max(0, Math.min(0.6, Number(j.alpha))) : ALPHA_DEFAULT,
    }
  } catch {
    return { enabled: false, alpha: ALPHA_DEFAULT }
  }
}

export function saveConfig(cfg) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

export function loadModel() {
  try {
    if (!existsSync(MODEL_PATH)) return null
    const m = JSON.parse(readFileSync(MODEL_PATH, 'utf8'))
    if (!m?.tools?.length || !m?.dim) return null
    return m
  } catch {
    return null
  }
}

export function saveModel(model) {
  try {
    mkdirSync(CLASSIFIER_DIR, { recursive: true })
    writeFileSync(MODEL_PATH, JSON.stringify(model), 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 把一条样本变成特征向量（稀疏存储为普通数组） */
export function featurize({ vec, state = {}, aqua = 0 }) {
  const s = [
    (Number(state.H) || 0) / 360,
    (Number(state.S) || 0) / 100,
    (Number(state.L) || 0) / 100,
    (Number(aqua) || 0) / 100,
  ]
  const f = new Float64Array(vec.length + STATE_DIM)
  f.set(vec, 0)
  f.set(s, vec.length)
  return f
}

/**
 * 训练（one-vs-rest logistic，SGD）
 * @param {{samples:Array<{vec:number[], tool:string, state?:object, aqua?:number}>, epochs?:number, lr?:number, l2?:number, seed?:number, holdout?:number}} o
 */
export function trainHead({ samples = [], epochs = 8, lr = 0.15, l2 = 1e-4, seed = 42, holdout = 0.2 } = {}) {
  if (samples.length < 40) return { ok: false, error: '样本不足（至少 40 条，建议 2000+）' }
  const tools = [...new Set(samples.map((s) => s.tool))].sort()
  if (tools.length < 2) return { ok: false, error: '至少需要 2 个工具类别' }
  const dim = samples[0].vec.length + STATE_DIM

  // 可复现的打乱（LCG）
  let r = seed >>> 0
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296)
  const idx = samples.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const cut = Math.floor(samples.length * (1 - holdout))
  const trainIdx = idx.slice(0, cut)
  const testIdx = idx.slice(cut)

  const W = tools.map(() => new Float64Array(dim))
  const b = tools.map(() => 0)
  const feats = samples.map((s) => featurize(s))

  for (let ep = 0; ep < epochs; ep += 1) {
    for (const i of trainIdx) {
      const x = feats[i]
      const want = tools.indexOf(samples[i].tool)
      for (let t = 0; t < tools.length; t += 1) {
        const y = t === want ? 1 : 0
        let z = b[t]
        const w = W[t]
        for (let d = 0; d < dim; d += 1) z += w[d] * x[d]
        const p = sigmoid(z)
        const g = p - y
        for (let d = 0; d < dim; d += 1) w[d] -= lr * (g * x[d] + l2 * w[d])
        b[t] -= lr * g
      }
    }
  }

  const predict = (i) => {
    const x = feats[i]
    let best = 0
    let bestScore = -Infinity
    for (let t = 0; t < tools.length; t += 1) {
      let z = b[t]
      const w = W[t]
      for (let d = 0; d < dim; d += 1) z += w[d] * x[d]
      if (z > bestScore) {
        bestScore = z
        best = t
      }
    }
    return tools[best]
  }

  let correct = 0
  for (const i of testIdx) if (predict(i) === samples[i].tool) correct += 1
  const acc = testIdx.length ? correct / testIdx.length : 0
  const trainAcc = (() => {
    let c = 0
    for (const i of trainIdx) if (predict(i) === samples[i].tool) c += 1
    return trainIdx.length ? c / trainIdx.length : 0
  })()

  const model = {
    version: 1,
    dim,
    tools,
    b,
    w: W.map((a) => Array.from(a)),
    trainedAt: new Date().toISOString(),
    samples: samples.length,
    trainAcc,
    testAcc: acc,
  }
  return { ok: true, model, report: { tools: tools.length, samples: samples.length, trainAcc, testAcc: acc } }
}

/** 打分：返回 [{name, p}]（p 是 softmax 后的概率） */
export function scoreTools({ model, vec, state = {}, aqua = 0 }) {
  if (!model) return []
  const x = featurize({ vec, state, aqua })
  if (x.length !== model.dim) return []
  const z = model.tools.map((t, i) => {
    let acc = Number(model.b[i]) || 0
    const w = model.w[i]
    for (let d = 0; d < model.dim; d += 1) acc += w[d] * x[d]
    return acc
  })
  const max = Math.max(...z)
  const exps = z.map((v) => Math.exp(v - max))
  const sum = exps.reduce((a, b2) => a + b2, 0) || 1
  return model.tools.map((name, i) => ({ name, p: exps[i] / sum }))
}

/**
 * 把头部概率混进检索分数（只会重排候选，不会引入目录外工具）
 * @param {Array<{name:string, score:number}>} hits
 */
export function blend({ hits, model, vec, state, aqua, alpha = ALPHA_DEFAULT }) {
  if (!model || !vec) return hits
  const probs = scoreTools({ model, vec, state, aqua })
  if (!probs.length) return hits
  const pmap = new Map(probs.map((p) => [p.name, p.p]))
  return hits
    .map((h) => ({ ...h, score: (1 - alpha) * h.score + alpha * (pmap.get(h.name) || 0) }))
    .sort((a, b) => b.score - a.score)
}

/** 追加一条选择日志（训练数据来源） */
export function appendLabel(entry) {
  try {
    mkdirSync(CLASSIFIER_DIR, { recursive: true })
    writeFileSync(LABELS_PATH, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf8' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function loadLabels() {
  try {
    if (!existsSync(LABELS_PATH)) return []
    return readFileSync(LABELS_PATH, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
