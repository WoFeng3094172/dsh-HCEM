// 分类头运行时：开关读取、检索混合、训练入口（默认关闭，不训练不动）
import {
  loadConfig,
  loadModel,
  blend,
  appendLabel,
  loadLabels,
  trainHead,
  saveModel,
  featurize,
} from './classifier.mjs'

let cached = { key: '', model: null, cfg: null }

function cfgNow() {
  const cfg = loadConfig()
  return cfg
}

/**
 * 在检索结果上做混合（若开关关闭 / 没有模型 / 维度不符，原样返回）
 * @param {{hits:Array<{name:string,score:number}>, vec:number[]|null, state:object, aqua:number}} o
 */
export function applyHead({ hits, vec, state, aqua }) {
  const cfg = cfgNow()
  if (!cfg.enabled || !vec) return hits
  // 模型文件变了要重新读
  const m = loadModel()
  if (!m) return hits
  const key = String(m.trainedAt || '') + ':' + m.dim
  if (cached.key !== key) cached = { key, model: m, cfg }
  try {
    return blend({ hits, model: cached.model, vec, state, aqua, alpha: cfg.alpha })
  } catch {
    return hits
  }
}

/** 记录一次真实的工具选择（训练数据的唯一合法来源） */
export function logChoice({ query, tool, source = 'model', state = {}, aqua = 0 }) {
  return appendLabel({
    ts: new Date().toISOString(),
    query: String(query || '').slice(0, 300),
    tool: String(tool || ''),
    source, // model=模型自己选的 / user=用户纠正 / explicit=用户点名
    state: { H: state.H, S: state.S, L: state.L },
    aqua,
  })
}

/**
 * 训练入口（供 AI 工具调用）
 * @param {{embed:(texts:string[])=>Promise<number[][]>, minSamples?:number}} o
 */
export async function trainFromLabels({ embed, minSamples = 40 } = {}) {
  const labels = loadLabels()
  if (labels.length < minSamples) {
    return { ok: false, error: `标签不足：${labels.length} 条（至少 ${minSamples}，建议 2000+）` }
  }
  if (typeof embed !== 'function') return { ok: false, error: 'embedding 不可用（8094 没起）' }
  const samples = []
  for (const l of labels) {
    if (!l?.query || !l?.tool) continue
    try {
      const [vec] = await embed([l.query])
      if (!Array.isArray(vec)) continue
      samples.push({ vec, tool: l.tool, state: l.state || {}, aqua: l.aqua || 0 })
    } catch {}
  }
  if (samples.length < minSamples) return { ok: false, error: `有效样本不足：${samples.length}` }
  const r = trainHead({ samples })
  if (!r.ok) return r
  const saved = saveModel(r.model)
  if (!saved.ok) return saved
  return { ok: true, report: r.report, modelPath: 'data/classifier/head.json' }
}

export { cfgNow as classifierConfig, loadLabels }
