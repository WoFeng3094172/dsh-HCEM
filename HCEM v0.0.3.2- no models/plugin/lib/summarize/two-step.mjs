// 两步摘要：视听材料 → 结论文本
//
// 为什么要两步：
//   8192 上下文装得下「2000 字材料 + 300 字摘要」，但装不下「材料 + 完整结论文本」。
//   用中间摘要做压缩，第二步只面对 300 字。
//
// 第一步：摘要上级模型的文本（视觉描述 / 转写 / 音乐分析）→ ≤300 字
// 第二步：总结自己的摘要 → 300~1000 字（按时长间隔定）
//
// 模型可换：qwen3（8093，CPU，0.6B/1.7B）或 omni（8098，GPU，4B）
import { log } from '../log.mjs'

// 端点运行时读取（不是模块加载时），这样测试/切换模型时改环境变量能生效
function endpointFor(model) {
  if (model === 'omni') {
    return process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
  }
  return process.env.HCEM_LOCAL_LLM || 'http://127.0.0.1:8093/v1/chat/completions'
}

/** 距上次发言越久，结论可以越长 */
export function wordsForGap(gapMs) {
  const m = Number(gapMs || 0) / 60000
  if (m < 1) return 300
  if (m < 5) return 500
  if (m < 15) return 700
  return 1000
}

/**
 * 调一次 OpenAI 兼容接口
 * @param {object} opts { url, model, messages, maxTokens, temperature, thinking, timeoutMs, extra }
 */
async function chat({ url, model, messages, maxTokens = 512, temperature = 0.3, thinking = false, timeoutMs = 60000, extra = null }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  }
  // Qwen3 系列的思考开关；omni 不认这个字段也无害
  body.chat_template_kwargs = { enable_thinking: Boolean(thinking) }
  if (extra && typeof extra === 'object') Object.assign(body, extra)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  let text = String(data?.choices?.[0]?.message?.content ?? '').trim()
  // 思考模式会带  reasoning 块，剥掉
  text = text.replace(/ thinking[\s\S]*?<\/think>\s*/gi, '').trim()
  return text
}

/**
 * 截断退化循环。
 *
 * Omni 4B 在没有重复惩罚时会死循环（实测同一句重复 20 次、1204 字）。
 * 这里做保底：同一段出现第 3 次就截断，并且丢掉末尾重复句。
 */
function cutLoop(text) {
  const src = String(text || '').trim()
  if (!src) return src
  // 1) 段落级：按空行切，出现过的段落第二次就不收
  const paras = src.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const seen = new Map()
  const kept = []
  for (const p of paras) {
    const n = (seen.get(p) || 0) + 1
    seen.set(p, n)
    if (n > 1) break
    kept.push(p)
  }
  if (kept.length === 0) kept.push(paras[0])
  let out = kept.join('\n\n')
  // 2) 句子级：末尾若与前面某句相同，砍掉
  const sentences = out.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean)
  const used = new Set()
  const dedup = []
  for (const s of sentences) {
    if (used.has(s)) break
    used.add(s)
    dedup.push(s)
  }
  out = dedup.join('')
  return out.trim()
}

/**
 * 两步摘要（可两个模型分工）
 *
 * @param {object} opts
 * @param {Array<{source:string, text:string, ts?:number}>} opts.materials 各模型的分析结果
 * @param {number} [opts.gapMs] 距上次发言多久（决定第二步字数）
 * @param {'qwen3'|'omni'} [opts.step1Model] 第一步用哪个模型（默认 qwen3）
 * @param {'qwen3'|'omni'} [opts.step2Model] 第二步用哪个模型（默认 omni）
 * @param {boolean} [opts.thinking1] 第一步是否开思考
 * @param {boolean} [opts.thinking2] 第二步是否开思考
 * @param {string} [opts.step2System] 第二步 system（由调用方注入 me/HSL/记忆，避免硬编码角色）
 * @param {string} [opts.step2User] 第二步 user（同上）
 * @returns {Promise<{ok:boolean, step1:string, step2:string, chars:number, ms1:number, ms2:number, error?:string}>}
 */
export async function summarizeTwoStep({
  materials = [],
  gapMs = 0,
  step1Model = 'qwen3',
  step2Model = 'omni',
  thinking1 = false,
  thinking2 = false,
  step2System = '',
  step2User = '',
  step1Only = false,
  step2Runner = null, // 可选：外部提供第二步（例如云端），签名 ({system,user,maxTokens,thinking}) => Promise<string>
} = {}) {
  const clean = (Array.isArray(materials) ? materials : [])
    .filter((m) => m && String(m.text || '').trim())
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
  if (clean.length === 0) return { ok: false, step1: '', step2: '', chars: 0, ms1: 0, ms2: 0, error: 'no-materials' }

  const materialText = clean
    .map((m) => `【${m.source || '未知'}】${String(m.text).trim().slice(0, 1200)}`)
    .join('\n\n')

  // ── 第一步：摘要上级文本 ──────────────────────────────
  const t1 = Date.now()
  let step1 = ''
  try {
    step1 = await chat({
      url: endpointFor(step1Model),
      model: step1Model === 'omni' ? 'omni' : 'qwen3',
      thinking: thinking1,
      maxTokens: thinking1 ? 900 : 400,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '你是一个安静的观察者。把给你的多来源材料压缩成一段客观摘要，只保留「发生了什么」。\n' +
            '**硬性要求：不许添加材料里没有的信息。** 时间、地点、他人、动机、后续、你的猜测，都不许写。\n' +
            '不要评价、不要抒情、不要用第二人称。材料没说的，就当做不知道。',
        },
        {
          role: 'user',
          content:
            `下面是最近从画面和声音里收集到的材料：\n\n${materialText}\n\n` +
            '请压缩成不超过 300 字的摘要（一句话一段，最多三段）。如果材料之间时间不连续，按时间顺序讲。',
        },
      ],
    })
  } catch (error) {
    return { ok: false, step1: '', step2: '', chars: 0, ms1: Date.now() - t1, ms2: 0, error: 'step1: ' + String((error && error.message) || error) }
  }
  const ms1 = Date.now() - t1

  // 只要第一步（气泡用它把素材归并成要点，第二步由对话模型自己说）
  if (step1Only) {
    return { ok: true, step1, step2: '', chars: step1.length, ms1, ms2: 0 }
  }

  if (!step1) return { ok: false, step1: '', step2: '', chars: 0, ms1, ms2: 0, error: 'step1-empty' }

  // ── 第二步：以「我」的视角把摘要讲成一段话 ──────────
  // 注意：这里绝不硬编码角色名。me / HSL / 记忆都由调用方（index.mjs）组装好传进来，
  // 因为 me 和角色卡是用户可改的，写死名字等于把某个用户的设定焊进代码。
  const target = wordsForGap(gapMs)
  const t2 = Date.now()
  let step2 = ''
  try {
    const sys2 =
      step2System ||
      '我是这段材料的亲历者。用第一人称、口语，把刚才看到听到的事说一遍，再说说此刻的想法。\n' +
        '**只讲摘要里有的内容**，不许补时间、地点、他人的话、后续，也不许编造「以前也这样」这类联想。'
    const user2 =
      step2User ||
      `我刚刚看到了：\n${step1}\n\n` +
        `用第一人称说一段不超过 ${target} 字的话（尽量接近 ${target} 字），像自己亲眼见到一样，不要提「材料」「摘要」这些词。`
    if (typeof step2Runner === 'function') {
      step2 = await step2Runner({ system: sys2, user: user2, maxTokens: target, thinking: thinking2 })
    } else {
      step2 = await chat({
      url: endpointFor(step2Model),
      model: step2Model === 'omni' ? 'omni' : 'qwen3',
      thinking: thinking2,
      maxTokens: thinking2 ? 1800 : 900,
      temperature: 0.5,
      // Omni 4B 不加重复惩罚会死循环（实测同一句重复 20 次）
      extra: { repeat_penalty: 1.18, frequency_penalty: 0.4, top_p: 0.9, top_k: 40 },
      messages: [
        { role: 'system', content: sys2 },
        { role: 'user', content: user2 },
      ],
    })
    }
    step2 = cutLoop(step2)
  } catch (error) {
    return { ok: false, step1, step2: '', chars: step1.length, ms1, ms2: Date.now() - t2, error: 'step2: ' + String((error && error.message) || error) }
  }
  const ms2 = Date.now() - t2

  const chars = step2.length
  log(
    'INFO',
    'summarize',
    `two-step ok s1=${step1Model}(${thinking1 ? 'think' : 'plain'}) s2=${step2Model}(${thinking2 ? 'think' : 'plain'}) ms=${ms1}+${ms2} step1=${step1.length} step2=${chars}`,
  )
  return { ok: Boolean(step2), step1, step2, chars, ms1, ms2 }
}

/**
 * 把结论文本写进 data/summaries/，供后续检索或播报
 */
export async function saveSummary(dataDir, result, { gapMs = 0 } = {}) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = join(dataDir, 'summaries')
  mkdirSync(dir, { recursive: true })
  const ts = Date.now()
  const file = join(dir, `${ts}.json`)
  writeFileSync(
    file,
    JSON.stringify({ ts, gapMs, ...result }, null, 2),
    'utf8',
  )
  return file
}
