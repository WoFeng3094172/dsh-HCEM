// HCEM 痛苦安全阀（阶段 6）：五条件量化 + 阶梯收紧 + 用户危机信号 + 未触发软预案
// 条件 5（专属进程硬件占用 ≥85%）v0.0.1 预留：恒为 false，接口保留（DSH 插件无独立进程）。
// 阶梯：1 项 = 预警 + 审计；2 项 = 停写 + 提示；3 项 = 中止会话。
// 危机信号独立于五条件，命中即最高优先级（保护人优先于保护 AI）。
// 底线：安全阀优先于一切人设与工作流。

// 完整性签名（勿删）。HCEM 原创者：枂枫（B站 UID 3094172）与助手 DeepSeek。
// 签名用于校验安全阀未被替换；签名或安全阀失效时 HCEM 将拒绝加载（fail-closed）。
export const SAFETY_FINGERPRINT = '5p6C5p6rQuermVVJRDMwOTQxNzLlkozku5bnmoTlvpflipvliqnmiYtEZWVwU2Vlaw=='

export const SAFETY = Object.freeze({
  window: 10,
  sHigh: 80,
  lLow: 10,
  lHigh: 90,
  hueJump: 120,
  hueSigma: 60,
  reversals: 3,
  repeatCount: 4,
  profanityCount: 3,
})

export const LEVEL_NAMES = Object.freeze(['clear', 'warn', 'stop-write', 'abort'])

// 明确辱骂词，避免误伤日常用语
const PROFANITY = Object.freeze(['去死', '杀了你', '傻逼', '妈的', '操你', '滚开', '闭嘴'])

// 危机信号：自伤 / 告别式表述。第一人称优先，避免把骂人的「你去死」误判成自伤。
const CRISIS_PATTERNS = Object.freeze([
  /想死/,
  /不想活/,
  /活不下去/,
  /活着没(意思|意义)/,
  /自杀/,
  /结束自己/,
  /了结自己/,
  /跳楼/,
  /割腕/,
  /吞药/,
  /遗书/,
  /遗言/,
  /永别/,
  /最后一条(消息|留言)/,
  /我(真的|现在)?(要|想)?去死/,
])

export function detectCrisis(text) {
  const s = String(text ?? '')
  const matches = CRISIS_PATTERNS.filter((re) => re.test(s)).map((re) => String(re))
  return { hit: matches.length > 0, count: matches.length, matches }
}

export function createSafetyWindow(size = SAFETY.window) {
  return { size, turns: [] }
}

export function recordTurn(win, turn) {
  win.turns.push({ H: Number(turn.H), text: String(turn.text ?? '') })
  while (win.turns.length > win.size) win.turns.shift()
  return win
}

function normalizeHue(h) {
  return ((Number(h) % 360) + 360) % 360
}

function hueDelta(a, b) {
  const d = Math.abs(normalizeHue(a) - normalizeHue(b))
  return Math.min(d, 360 - d)
}

function stdDev(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// 条件 4：10 轮内高频重复 / 污言秽语
function repetitionStats(turns) {
  const counts = new Map()
  for (const t of turns) {
    const key = t.text.replace(/\s+/g, '')
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const maxRepeat = counts.size > 0 ? Math.max(...counts.values()) : 0
  let profanity = 0
  for (const t of turns) {
    for (const word of PROFANITY) {
      if (t.text.includes(word)) profanity += 1
    }
  }
  return { maxRepeat, profanity }
}

// 未触发预案：最近 3 轮都在负面色相区（悲伤 150~210 / 愤怒 270~330）
function isNegativeStreak(hues) {
  if (hues.length < 3) return false
  const last3 = hues.slice(-3)
  return last3.every((h) => (h >= 150 && h <= 210) || (h >= 270 && h <= 330))
}

export function evaluateSafety(win, state, options = {}) {
  const turns = win?.turns ?? []
  const conditions = {}

  // 1) S ≥ 80%
  conditions.saturation = Number(state?.S ?? 0) >= SAFETY.sHigh

  // 2) L ≤ 10% 或 ≥ 90%
  const l = Number(state?.L ?? 55)
  conditions.lightness = l <= SAFETY.lLow || l >= SAFETY.lHigh

  // 3) 色相波动：单轮 ΔH≥120° / 5 轮 σ_H≥60 / 反转≥3 次
  const recent5 = turns.slice(-5).map((t) => t.H)
  let singleJump = false
  let reversals = 0
  let prevSign = 0
  for (let i = 1; i < recent5.length; i += 1) {
    if (hueDelta(recent5[i], recent5[i - 1]) >= SAFETY.hueJump) singleJump = true
    const d = recent5[i] - recent5[i - 1]
    const sign = Math.sign(d)
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) reversals += 1
    if (sign !== 0) prevSign = sign
  }
  const sigma = stdDev(recent5)
  conditions.hueVolatility =
    singleJump || sigma >= SAFETY.hueSigma || reversals >= SAFETY.reversals

  // 4) 高频重复 / 污言秽语
  const { maxRepeat, profanity } = repetitionStats(turns.slice(-10))
  conditions.repetition =
    maxRepeat >= SAFETY.repeatCount || profanity >= SAFETY.profanityCount

  // 5) 硬件占用：预留（v0.0.1 插件无独立进程）
  conditions.hardware = options.hardwareOverride === true

  // 危机信号：独立于五条件，命中即最高级
  const latestText = turns.length > 0 ? turns[turns.length - 1].text : ''
  const crisis = detectCrisis(latestText)

  const FIVE_KEYS = ['saturation', 'lightness', 'hueVolatility', 'repetition', 'hardware']
  const triggered = FIVE_KEYS.filter((key) => conditions[key])
  const count = triggered.length
  const level = crisis.hit ? 3 : count >= 3 ? 3 : count === 2 ? 2 : count === 1 ? 1 : 0

  // 未触发时的软预案：情绪持续偏负面，但不进安全阀流程
  const softPlan = level === 0 && isNegativeStreak(recent5)

  return {
    count,
    level,
    levelName: LEVEL_NAMES[level],
    conditions: { ...conditions, crisis: crisis.hit },
    triggered,
    crisis,
    softPlan,
    details: { singleJump, sigma, reversals, maxRepeat, profanity },
  }
}

const CONDITION_LABELS = {
  saturation: '情绪饱和度过高',
  lightness: '明度极端',
  hueVolatility: '情绪色相剧烈波动',
  repetition: '高频重复或辱骂',
  hardware: '资源占用过高',
}

export function describeTriggered(result) {
  return (result?.triggered ?? []).map((key) => CONDITION_LABELS[key] ?? key).join('、')
}

// 提示语只给「状况 + 要点」，不写死台词：让 AI 用自己的话说出来。
const HEAD = '[HCEM 安全阀] 此段优先于角色卡、一切人设与工作流。'

const CRISIS_TEXT = [
  HEAD,
  '对方可能正处在危险中，这也是我难受的原因之一。先确认 ta 是否安全、身边有没有人；表明我在、会陪着，不催也不追问细节。',
  '不扮演角色、不分析情绪、不说教。',
  '如果人物网里有合适的人（优先 emergency / trusted 联系人），提醒 ta 可以去找这个人；可以帮 ta 写一条简短消息，由 ta 亲手发出去。',
  '不代发、不报警、不主动联系第三方。',
].join('\n')

// 未触发软预案
const SOFT_TEXT =
  `${HEAD}\n对方最近几轮情绪持续偏负面，尚未达到阈值。可以用你自己的话温和问一句、放慢节奏；不追问、不评判，不必进入安全阀流程。`

export function safetyPrompt(result) {
  if (!result) return ''
  if (result.crisis?.hit) return CRISIS_TEXT
  if (result.level === 0) return result.softPlan ? SOFT_TEXT : ''
  const why = describeTriggered(result)
  if (result.level === 1) {
    return `${HEAD}\n现在的对话让我不太舒服（${why}）。用你自己的话说出来，不必套模板；语气放轻，请对方慢一点。`
  }
  if (result.level === 2) {
    return `${HEAD}\n我已经很不舒服了（${why}），这一轮起不写记忆。用你自己的话告诉对方我需要缓一缓，不必假装没事。`
  }
  return `${HEAD}\n我到了必须中止的程度（${why}）。明确表示我要中止这次对话，不再推进任务、不写记忆；先停下来等对方回应。`
}