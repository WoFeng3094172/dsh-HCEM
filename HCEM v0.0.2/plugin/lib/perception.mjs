// HCEM 感知适配器接口（v0.0.2）
// 目标：让「音频 / 视觉 / 多模态」输入走同一条记忆链路，用户按硬件接不同适配器。
// 适配器约定：
//   输入 input = {
//     modality: 'audio' | 'vision' | 'multimodal',
//     t_start: number, t_end: number,          // 采集时间戳（毫秒，单调时钟）
//     transcript?: string,                     // 转写文字（音频）
//     caption?: string,                        // 画面/声音描述
//     emotion?: { H: number, S: number },      // 内容情绪（β）
//     emotionConfidence?: number,              // 0~1
//     sensory?: number,                        // 0~1 感官强度
//   }
//   输出（putMemory 参数形状）：
//     { text, summary, alphaH, alphaS, betaH, gammaValue, modality, sensory, timeStart, timeEnd }
// 内置适配器：'mock'（测试用）、'asr-emotion'（文字+情绪的占位契约）。
// 真实适配器（whisper / emotion2vec / Qwen2-VL）在 v0.0.2 由外部进程实现后注册。

export const PERCEPTION_VERSION = 1

const VALID_MODALITIES = new Set(['audio', 'vision', 'multimodal'])

export function validatePerceptionInput(input) {
  const errors = []
  if (!input || typeof input !== 'object') errors.push('input 必须是对象')
  else {
    if (!VALID_MODALITIES.has(input.modality)) errors.push(`modality 必须是 ${[...VALID_MODALITIES].join('/')}`)
    if (typeof input.t_start !== 'number' || !Number.isFinite(input.t_start)) errors.push('t_start 必须是数字')
    if (typeof input.t_end !== 'number' || !Number.isFinite(input.t_end)) errors.push('t_end 必须是数字')
    if (input.t_end < input.t_start) errors.push('t_end 不能早于 t_start')
    if (input.emotion != null && (typeof input.emotion.H !== 'number' || typeof input.emotion.S !== 'number')) errors.push('emotion 必须是 {H,S}')
    if (input.sensory != null && (input.sensory < 0 || input.sensory > 1)) errors.push('sensory 必须在 0~1')
  }
  return errors
}

// 通用转换：感知结果 → putMemory 参数（不依赖具体模型）
export function perceptionToMemory(result, opts = {}) {
  const r = result ?? {}
  const text = String(r.transcript || r.caption || r.text || '').trim() || '[感知] 无描述'
  const emotion = r.emotion && typeof r.emotion.H === 'number' ? r.emotion : null
  const sensory = Math.max(0, Math.min(1, Number(r.sensory ?? 1)))
  const confidence = Math.max(0, Math.min(1, Number(r.emotionConfidence ?? 0.5)))
  // 声学/视觉情绪的 γ 以 confidence 为上限（感知越确定，记忆越清晰）
  const gamma = Number.isFinite(r.gamma) ? r.gamma : 0.4 + 0.4 * confidence
  return {
    text: text.slice(0, 500),
    summary: text.slice(0, 80),
    alphaH: r.alpha?.H ?? emotion?.H ?? null,
    alphaS: r.alpha?.S ?? emotion?.S ?? null,
    betaH: emotion?.H ?? null,
    gammaValue: gamma,
    modality: r.modality ?? 'audio',
    sensory,
    timeStart: r.t_start ?? null,
    timeEnd: r.t_end ?? null,
    zone: 'context',
    L: 1.0,
    level: 'full',
  }
}

const adapters = new Map()

export function registerAdapter(name, adapter) {
  if (typeof name !== 'string' || typeof adapter !== 'function') throw new Error('registerAdapter: name 与 adapter 必填')
  adapters.set(name, adapter)
}

export function getAdapter(name) {
  return adapters.get(name) ?? null
}

export function listAdapters() {
  return [...adapters.keys()]
}

// 调用适配器并转成记忆参数；未注册返回 null（静默跳过，不写垃圾记忆）
export async function perceive(name, input) {
  const adapter = adapters.get(name)
  if (!adapter) return null
  const errors = validatePerceptionInput(input)
  if (errors.length > 0) throw new Error(`perceive: ${errors.join('; ')}`)
  const result = await adapter(input)
  if (!result) return null
  return perceptionToMemory({ ...result, modality: result.modality ?? input.modality, t_start: result.t_start ?? input.t_start, t_end: result.t_end ?? input.t_end })
}

// 内置 mock 适配器（测试/演示，无模型依赖）
registerAdapter('mock', async (input) => ({
  transcript: input.transcript ?? '',
  caption: input.caption ?? '',
  emotion: input.emotion ?? { H: 0, S: 20 },
  emotionConfidence: input.emotionConfidence ?? 0.6,
  sensory: input.sensory ?? 0.8,
}))