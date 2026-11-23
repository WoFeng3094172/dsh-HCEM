// 梦系统：卡堆（因果链卡 + 记忆碎片卡）→ 盲抽 → OmniDimen 编梦 → 自评 → 日志
// 设计：视觉/声音卡 ≤35%；错峰（不追求速度）；α/β 刷新；δ 不动
import { appendJournal } from './journal.mjs'

const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
const QWEN3_URL = process.env.HCEM_QWEN3_LLM || 'http://127.0.0.1:8093/v1/chat/completions'

export const DREAM_CONFIG = Object.freeze({
  cardsMin: 3,
  cardsMax: 6,
  visualAudioMax: 0.35, // 视觉/声音卡最高 35%
  logThreshold: 3, // 自评 ≥3 → 记日志
})

// 卡类型
export const CARD = Object.freeze({ causal: '因果链', fragment: '记忆碎片', visual: '视觉', audio: '声音' })

/**
 * 从三区抽卡（生成卡堆）
 * @param {object} opts { store, rng? }
 */
export function buildDeck({ store, limit = 60 } = {}) {
  if (!store) return { causal: [], fragment: [], visual: [], audio: [] }
  const pick = (zones) => {
    const out = []
    for (const z of zones) {
      try {
        out.push(...store.listMemories({ zone: z, limit }))
      } catch {}
    }
    return out
  }
  // 真实的文字记忆落在 life/knowledge/pool_keep/pool_observe/context；
  // reincarnation 是导入的前世记忆，也值得进梦
  const text = pick(['life', 'knowledge', 'pool_keep', 'pool_observe', 'context', 'reincarnation'])
  // 不存在 video_buffer 这个区（之前错写，导致视觉卡永远是 0）；
  // 真正有内容的是 observe / keep / context
  const video = pick(['video_observe', 'video_keep', 'video_context', 'video_fast'])
  const audio = pick(['audio_1', 'audio_2', 'audio_buffer', 'audio_context'])

  const deck = { causal: [], fragment: [], visual: [], audio: [] }
  for (const m of text) {
    const t = String(m.text || '').slice(0, 200)
    if (!t) continue
    // 因果链卡：含「因为/所以/导致/于是」的记忆
    if (/(因为|所以|导致|于是|结果|因此)/.test(t)) {
      deck.causal.push({ type: CARD.causal, text: t, id: m.id })
    } else {
      deck.fragment.push({ type: CARD.fragment, text: t, id: m.id })
    }
  }
  for (const m of video) {
    deck.visual.push({ type: CARD.visual, text: String(m.summary || m.text || '').slice(0, 150), id: m.id })
  }
  for (const m of audio) {
    deck.audio.push({ type: CARD.audio, text: String(m.summary || m.text || '').slice(0, 150), id: m.id })
  }
  return deck
}

/** 随机整数 [min, max] */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * Qwen3-0.6B 盲抽：只定数量（不选内容）
 * @returns {Promise<number>} 抽几张（3-6）
 */
export async function decideCount({ rng = Math.random, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch(QWEN3_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `从 3 到 6 里选一个数字，只输出数字。` }],
        max_tokens: 8,
        temperature: 1,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json()
    const m = String(data?.choices?.[0]?.message?.content ?? '').match(/[3-6]/)
    if (m) return Number(m[0])
  } catch {}
  return randInt(rng, DREAM_CONFIG.cardsMin, DREAM_CONFIG.cardsMax)
}

/**
 * 盲抽卡（按数量随机，视觉/声音 ≤35%）
 * @param {object} deck
 * @param {number} count
 * @param {function} rng
 */
export function drawCards(deck, count, rng = Math.random) {
  const all = []
  for (const [kind, cards] of Object.entries(deck)) {
    for (const c of cards) all.push({ ...c, kind })
  }
  if (all.length === 0) return []
  const n = Math.min(count, all.length)
  // 盲抽：纯随机
  const shuffled = all.slice().sort(() => rng() - 0.5)
  const picked = shuffled.slice(0, n)
  // 视觉/声音 ≤35%
  const maxAV = Math.max(1, Math.floor(n * DREAM_CONFIG.visualAudioMax))
  const av = picked.filter((c) => c.kind === 'visual' || c.kind === 'audio')
  if (av.length > maxAV) {
    const keep = av.slice(0, maxAV)
    const drop = new Set(av.slice(maxAV).map((c) => c.id))
    return picked.filter((c) => !drop.has(c.id))
  }
  return picked
}

/**
 * OmniDimen 编梦（以 AI 为主角，从混乱中编逻辑）
 * @param {object} opts { cards, persona, mood, recentJournal }
 */
export async function composeDream({ cards = [], persona = '', mood = '', recentJournal = '', timeoutMs = 90000, maxTokens = 800, signal = null, onChunk = null } = {}) {
  const cardText = cards.map((c, i) => `${i + 1}. [${c.type}] ${c.text}`).join('\n')
  const long = maxTokens >= 2000
  const prompt = `你是${persona || '一个 AI 助手'}。现在你在做梦。

梦见的东西来自你的记忆碎片和因果链，它们可能毫无关联——
没关系，梦本来就荒诞。用第一人称（"我"）把梦写出来，
把这些碎片串成一个有情绪、有画面、有因果的梦。

${mood ? `此刻的情绪底色：${mood}` : ''}
${recentJournal ? `你最近的日志（供参考）：\n${recentJournal.slice(0, 500)}` : ''}

抽到的卡：
${cardText || '（无）'}

写梦（${long ? '1000-2000' : '300-600'} 字，第一人称，不要解释，不要标题）：`
  // 流式：可中断时保留已生成部分（半梦）
  let acc = ''
  let interrupted = false
  const timeout = AbortSignal.timeout(timeoutMs)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.9,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: composite,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const data = s.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const j = JSON.parse(data)
          const delta = j?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') {
            acc += delta
            if (onChunk) {
              try {
                onChunk(delta)
              } catch {}
            }
          }
        } catch {}
      }
    }
  } catch (error) {
    const name = String(error?.name || '')
    if (name === 'AbortError' || String(error).includes('abort')) {
      interrupted = true
    } else {
      return { text: acc.trim(), interrupted: false, error: String((error && error.message) || error) }
    }
  }
  return { text: acc.trim(), interrupted }
}

/** 自评（1-5）：AI 喜好 */
export async function evaluateDream({ dream, timeoutMs = 30000 } = {}) {
  const t = String(dream || '').slice(0, 600)
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `给这个梦打分（1-5，只输出数字）。判断标准：情感强度、新颖度、完整度。\n\n${t}` }],
        max_tokens: 8,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json()
    const m = String(data?.choices?.[0]?.message?.content ?? '').match(/[1-5]/)
    return m ? Number(m[0]) : 3
  } catch {
    return 3
  }
}

/**
 * 梦的 α/β 刷新（δ 不动）
 * @param {object} emotion { H, S, L }
 * @param {object} dreamEmotion 梦的情绪（{ H, S }）
 * @param {number} weight 混合权重（0-1，默认 0.25）
 */
export function refreshEmotion(emotion, dreamEmotion, weight = 0.25) {
  if (!emotion || !dreamEmotion) return emotion
  const mix = (a, b, w) => a * (1 - w) + b * w
  return {
    ...emotion,
    H: (mix(emotion.H ?? 360, dreamEmotion.H ?? 360, weight) + 360) % 360,
    S: Math.max(0, Math.min(100, mix(emotion.S ?? 15, dreamEmotion.S ?? 15, weight))),
  }
}

/**
 * 完整做梦流程
 * @returns {Promise<{ok:boolean, dream?:string, score?:number, logged?:boolean, cards?:number}>}
 */
export async function runDream({ store, dataDir, persona = '', mood = '', emotion = null, rng = Math.random, recentJournal = '' } = {}) {
  const deck = buildDeck({ store })
  const count = await decideCount({ rng })
  const cards = drawCards(deck, count, rng)
  if (cards.length === 0) return { ok: false, error: 'empty deck' }
  const composed = await composeDream({ cards, persona, mood, recentJournal })
  const dream = composed?.text ?? ''
  if (!dream) return { ok: false, error: 'dream empty', interrupted: composed?.interrupted ?? false }
  const score = await evaluateDream({ dream })
  let logged = false
  if (score >= DREAM_CONFIG.logThreshold && dataDir) {
    logged = appendJournal({ dataDir, text: dream, mood: `梦 ${score}/5` }).ok
  }
  return { ok: true, dream, score, logged, cards: cards.length }
}

/**
 * 续写梦（梦场内，基于前文 + 新碎片）
 * @returns {Promise<{text:string, interrupted:boolean}>}
 */
export function buildContinuePrompt({ previous = '', cards = [], persona = '', mood = '', maxTokens = 1500 } = {}) {
  const cardText = cards.map((c, i) => `· ${c.text}`).join('\n')
  return `你是${persona || '一个 AI 助手'}。你正做着一场很长的梦。

梦里之前是这样的：
${String(previous).slice(-1200)}

现在，梦里又飘来几段记忆碎片：
${cardText || '（无）'}

${mood ? `此刻的情绪底色：${mood}` : ''}

让这个梦继续下去，把它变得更完整、更有层次——像真的一直在做这个梦一样。
用第一人称（"我"），自然衔接，不要重新开头，不要解释，不要标题。
写梦（${maxTokens >= 2000 ? '800-1500' : '300-600'} 字）：`
}

export async function continueDream({ previous = '', cards = [], persona = '', mood = '', timeoutMs = 180000, maxTokens = 1500, signal = null, onChunk = null } = {}) {
  const prompt = buildContinuePrompt({ previous, cards, persona, mood, maxTokens })
  let acc = ''
  let interrupted = false
  const timeout = AbortSignal.timeout(timeoutMs)
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.9,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: composite,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const data = s.slice(5).trim()
        if (data === '[DONE]') continue
        try {
          const j = JSON.parse(data)
          const delta = j?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') {
            acc += delta
            if (onChunk) {
              try { onChunk(delta) } catch {}
            }
          }
        } catch {}
      }
    }
  } catch (error) {
    const name = String(error?.name || '')
    if (name === 'AbortError' || String(error).includes('abort')) interrupted = true
    else return { text: acc.trim(), interrupted: false, error: String((error && error.message) || error) }
  }
  return { text: acc.trim(), interrupted }
}
