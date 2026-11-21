// 视频陪伴：检测到视频 → AI 主动问「要一起看吗？」（不模板化）
// 未回复/拒绝 → 走空闲流程（梦/休眠）
import { loadUserState, canProactive, askVideoPrompt } from './user-state.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
const ASKED_PATH = (dataDir) => join(dataDir, 'video-ask.json')

/** 今天是否已问过 */
export function askedToday(dataDir) {
  try {
    const p = ASKED_PATH(dataDir)
    if (!existsSync(p)) return false
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j?.date === new Date().toISOString().slice(0, 10)
  } catch {
    return false
  }
}

function markAsked(dataDir) {
  try {
    writeFileSync(ASKED_PATH(dataDir), JSON.stringify({ date: new Date().toISOString().slice(0, 10) }), 'utf8')
  } catch {}
}

/**
 * 可能主动问「一起看视频吗」
 * @param {object} opts { dataDir, L, screenDesc, force? }
 * @returns {Promise<{asked:boolean, text?:string, reason?:string}>}
 */
export async function maybeAskVideo({ dataDir, L = 55, screenDesc = '', force = false } = {}) {
  const state = loadUserState(dataDir)
  if (state === 'away') return { asked: false, reason: 'away' }
  if (!force && !canProactive(dataDir, { L })) return { asked: false, reason: 'busy' }
  if (!force && askedToday(dataDir)) return { asked: false, reason: 'asked-today' }
  const prompt = askVideoPrompt({ screenDesc, state })
  if (!prompt) return { asked: false, reason: 'away' }
  try {
    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0.9,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) return { asked: false, reason: 'empty' }
    markAsked(dataDir)
    return { asked: true, text }
  } catch (error) {
    return { asked: false, reason: 'error: ' + String((error && error.message) || error) }
  }
}
