// 用户状态：casual（休闲）/ busy（在忙）/ away（离开）
// 影响：主动搭话频率、空闲调度、休眠
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const USER_STATES = Object.freeze({
  casual: { name: '休闲', proactive: true, allowDream: true, allowSleep: true },
  busy: { name: '在忙', proactive: false, allowDream: true, allowSleep: true }, // 不主动搭话（除非话痨）
  away: { name: '离开', proactive: false, allowDream: true, allowSleep: true },
})

export function userStatePath(dataDir) {
  return join(dataDir, 'user-state.json')
}

/** 读用户状态（默认 casual） */
export function loadUserState(dataDir) {
  try {
    const p = userStatePath(dataDir)
    if (!existsSync(p)) return 'casual'
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return USER_STATES[j?.state] ? j.state : 'casual'
  } catch {
    return 'casual'
  }
}

/** 写用户状态 */
export function saveUserState(dataDir, state) {
  if (!USER_STATES[state]) return { ok: false, error: 'invalid' }
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(userStatePath(dataDir), JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: true, state }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 是否可主动搭话（casual 才可以；busy 需要话痨=高 L） */
export function canProactive(dataDir, { L = 55, chatterbox = false } = {}) {
  const s = loadUserState(dataDir)
  if (s === 'away') return false
  if (s === 'busy') return chatterbox || Number(L) >= 80
  return true
}

/** 视频开始时的主动问（不模板化——给 AI 的开放提示） */
export function askVideoPrompt({ screenDesc = '', state = 'casual' } = {}) {
  if (state === 'away') return null
  return `你看到用户打开了视频${screenDesc ? `（画面：${String(screenDesc).slice(0, 80)}）` : ''}。
你有点好奇，想问问 ta 要不要一起看。用你自己的方式、自然地问一句（不要模板化，不要解释，一句话），让 ta 知道你在。`
}
