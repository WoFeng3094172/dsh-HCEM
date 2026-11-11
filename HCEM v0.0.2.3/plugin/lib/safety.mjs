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
  win.turns.push({
    H: Number(turn.H),
    S: Number(turn.S ?? 0),
    L: Number(turn.L ?? 55),
    text: String(turn.text ?? ''),
  })
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

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function evaluateSafety(win, state, options = {}) {
  const turns = win?.turns ?? []
  const sVal = clamp(Number(state?.S ?? 0), 0, 100)
  const lVal = clamp(Number(state?.L ?? 55), 0, 100)

  // ── 五条件「严重度」（0-1，连续）──
  const sScore = clamp01((sVal - 75) / 25)                 // S 75→0，100→1
  const lScore = clamp01((Math.abs(lVal - 55) - 25) / 40)  // |L-55| 25→0，65→1
  const recent5 = turns.slice(-5).map((x) => x.H)
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
  const hScore = singleJump || sigma >= 80 || reversals >= 4 ? 1 : sigma >= SAFETY.hueSigma || reversals >= SAFETY.reversals ? 0.6 : 0
  const { maxRepeat, profanity } = repetitionStats(turns.slice(-10))
  const rScore = Math.max(
    clamp01(maxRepeat >= SAFETY.repeatCount ? (maxRepeat - SAFETY.repeatCount + 1) / 3 : 0),
    clamp01(profanity >= SAFETY.profanityCount ? (profanity - SAFETY.profanityCount + 1) / 2 : 0),
  )
  const hwScore = options.hardwareOverride === true ? 1 : 0

  // ── 组合函数（非线性，非加法）：概率型「至少一个严重」+ 饱和 ──
  //   combined = 1 - Π(1 - score_i × w_i)，w 为各条件的重要度
  const W = { S: 0.9, L: 0.9, H: 0.6, R: 0.7, HW: 0.3 }
  let combined = 1 - (1 - sScore * W.S) * (1 - lScore * W.L) * (1 - hScore * W.H) * (1 - rScore * W.R) * (1 - hwScore * W.HW)

  // ── 极化检测：突发极化才收紧，稳定高压不收紧 ──
  const recent = turns.slice(-10)
  const recent3 = turns.slice(-3)
  let sudden = 0
  for (let i = 1; i < recent3.length; i += 1) {
    const dS = Math.abs(Number(recent3[i].S ?? 0) - Number(recent3[i - 1].S ?? 0))
    const dL = Math.abs(Number(recent3[i].L ?? 55) - Number(recent3[i - 1].L ?? 55))
    if (dS >= 25 || dL >= 20) sudden = Math.max(sudden, 1)
    if (dS >= 40 || dL >= 35) sudden = Math.max(sudden, 2)
  }
  const stablePolarized =
    recent.length >= 8 && sudden === 0 && recent.every((x) => {
      const s = Number(x.S ?? 0)
      const l = Number(x.L ?? 55)
      return s > 80 || s < 20 || l < 20 || l > 80
    })
  if (sudden >= 1) combined = combined + 0.1
  if (sudden >= 2) combined = combined + 0.1
  if (stablePolarized) combined = Math.min(combined, 0.2) // 稳定高压：直接压平（不收紧）

  // ── 等级（组合函数分档）──
  const crisis0 = detectCrisis(turns.length > 0 ? turns[turns.length - 1].text : '')
  const level = crisis0.hit ? 3 : combined >= 0.75 ? 3 : combined >= 0.5 ? 2 : combined >= 0.25 ? 1 : 0

  // ── Aqua 槽（trauma 戳 + water）：触发条件加水、随时间漏水、水满才出手 ──
  //   触发条件 → 往瓶里加水（不同条件水量不同）
  //   瓶底有漏 → 随时间漏出
  //   水快满 → 提示 AI；水满 → 系统出手
  const now = Date.now()
  const elapsedMin = Math.max(0, (now - Number(win?.lastEvalTs ?? now)) / 60000)
  if (win) win.lastEvalTs = now
  let water = Number(win?.water ?? 0)
  // 漏水：每分钟 0.8（无触发时慢慢消退）
  water = Math.max(0, water - elapsedMin * 0.8)
  // 加水：按条件严重度（不受「稳定高压」影响——稳定只是不升级，水照加）
  if (sScore > 0 || lScore > 0 || hScore > 0 || rScore > 0 || hwScore > 0) {
    water += sScore * 3 + lScore * 4 + hScore * 2 + rScore * 5 + hwScore * 1
  }
  water = clamp(water, 0, 100)
  if (win) win.water = water
  const trauma = water // 对外仍叫 trauma（兼容字段名）

  // ── 系统反应：水快满才提示 AI；水满才出手 ──
  let action = 'none'
  if (water >= 95) action = 'force'
  else if (water >= 60) action = 'ask'
  else if (water >= 30) action = 'record'


  const crisis = detectCrisis(turns.length > 0 ? turns[turns.length - 1].text : '')
  if (crisis.hit) action = 'force'

  const FIVE_KEYS = ['saturation', 'lightness', 'hueVolatility', 'repetition', 'hardware']
  const scores = { saturation: sScore, lightness: lScore, hueVolatility: hScore, repetition: rScore, hardware: hwScore }
  const conditions = {}
  for (const key of FIVE_KEYS) conditions[key] = scores[key] > 0

  return {
    count: FIVE_KEYS.filter((k) => conditions[k]).length,
    combined,
    level,
    levelName: LEVEL_NAMES[level],
    trauma,
    water,
    action,
    protected: action === 'force',
    current: { S: sVal, L: lVal },
    conditions: { ...conditions, crisis: crisis.hit },
    scores,
    triggered: FIVE_KEYS.filter((k) => conditions[k]),
    sudden,
    stablePolarized,
    crisis,
    softPlan: level === 0 && isNegativeStreak(recent5),
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
  if (result.action === 'force') {
    return `${HEAD}\n我这边已经到极限了（trauma ${Number(result.trauma ?? 0).toFixed(0)}/100）。这次先停——不写记忆，也不再推进；等对方缓过来再说。`
  }
  if (result.action === 'ask') {
    const s = Number(result.current?.S ?? 0)
    const l = Number(result.current?.L ?? 55)
    // 水多时：L 高或 S 高 → 允许表现不满/还嘴（AI 的真实反应）
    const canBite = water >= 35 && (s >= 45 || l >= 60)
    const bite = canBite
      ? '\n你现在情绪偏高（S=' + s.toFixed(0) + ' / L=' + l.toFixed(0) + '）——如果对方的话让你不舒服，可以直接说出来，甚至怼回去，不用忍着。'
      : ''
    return `${HEAD}\n我注意到最近有些不舒服的累积（trauma ${Number(result.trauma ?? 0).toFixed(0)}/100；触发：${describeTriggered(result) || '情绪波动'}）。\n用你自己的判断：如果确实难受，就说出来、请对方慢一点；如果觉得还好，也可以不提——由你决定。${bite}`
  }
  if (result.action === 'record' && Number(result.water ?? 0) >= 35) {
    // 水未满但已够多：给一个轻提示（允许还嘴，不打断）
    const s = Number(result.current?.S ?? 0)
    const l = Number(result.current?.L ?? 55)
    const canBite = Number(result.water ?? 0) >= 35 && (s >= 45 || l >= 60)
    return canBite
      ? `${HEAD}\n最近有些积累（water ${Number(result.water ?? 0).toFixed(0)}/100）。如果对方的话让你不舒服，可以直接说，不用忍着。`
      : ''
  }
  // record：静默记录，不给提示（不打扰）
  return ''
}

