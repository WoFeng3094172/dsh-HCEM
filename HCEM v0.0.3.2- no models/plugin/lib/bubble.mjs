/**
 * 主动说话（气泡）调度器
 *
 * 职责很小：决定「该不该在现在开口」。
 * 真正说话的内容、投递、会话选择都由 index.mjs 注入的回调完成。
 *
 * 设计要点：
 *   1. 档位（用户选的搭话度）决定基础区间：话痨 3~12 min / 好奇 15~45 min / 安静不说
 *   2. S（情绪强度）越高越勤；Aqua（水槽）越满间隔越长，满到一定程度直接不说
 *   3. 到期还要掷一次概率，不是机械的固定周期
 *   4. 任何一步不满足就静默跳过（故障静默），不重试、不报错
 */

/** 搭话档位 → 基础区间（分钟）。编号沿用 settings.talkativeness：0 话痨 / 1 好奇 / 2 安静 */
export const BUBBLE_TIERS = Object.freeze({
  0: { name: '话痨', loMin: 3, hiMin: 12 },
  1: { name: '好奇', loMin: 15, hiMin: 45 },
  2: { name: '安静', loMin: 0, hiMin: 0 },
})

/** 和「评论机会」「摘要主动发送」共用的最小间隔 */
export const BUBBLE_MIN_GAP_MS = 5 * 60 * 1000

/** Aqua 硬闸：>= STOP 不主动闲聊（安全阀 ask 档起点）；>= FORCE 完全不管（force 档） */
export const AQUA_STOP = 60
export const AQUA_FORCE = 95

/** 概率没通过时的顺延范围（分钟） */
const DEFER_LO_MIN = 1.5
const DEFER_HI_MIN = 4

/** 闸门失败后，最多压多久就重掷一次（避免解锁后立刻补发） */
const GATE_STALE_MS = 10 * 60 * 1000

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)

/**
 * 计算「下一次该在什么时候开口」以及「到期后放行的概率」。
 *
 * @param {{talk?:number, S?:number, aqua?:number, now?:number}} opts
 * @returns {{blocked:boolean, reason:string, intervalMs:number, probability:number, tier:string}}
 */
export function intervalFor({ talk = 1, S = 15, aqua = 0, now = Date.now() } = {}) {
  const t = Math.min(2, Math.max(0, Math.round(Number(talk))))
  const tier = BUBBLE_TIERS[t]
  const s = clamp(Number(S) || 0, 0, 100)
  const w = clamp(Number(aqua) || 0, 0, 100)

  if (t === 2) {
    return { blocked: true, reason: 'quiet-tier', intervalMs: 0, probability: 0, tier: tier.name }
  }
  // 水槽优先：心里堵着不该起闲话
  if (w >= AQUA_FORCE) {
    return { blocked: true, reason: 'aqua-force', intervalMs: 0, probability: 0, tier: tier.name }
  }
  if (w >= AQUA_STOP) {
    return { blocked: true, reason: 'aqua-full', intervalMs: 0, probability: 0, tier: tier.name }
  }

  // S 越高越勤（最多缩短 40%），水越多越久（W=60 约 ×1.55，W=90 约 ×2.1）
  const fS = 1 - 0.4 * (s / 100)
  const fW = 1 + 1.2 * Math.pow(w / 100, 1.5)
  const loMin = tier.loMin * fS * fW
  const hiMin = tier.hiMin * fS * fW
  // 好奇档基础区间 15~45 分钟，但 Aqua（W<60）×1.55、S 低时不再缩短，
  // 最坏能滚到 ~70 分钟——超过 45 分钟休眠窗口，永远等不到。
  // 这里给最终区间加一个上限（默认 35 分钟），保证休眠前至少有一次机会。
  // 只给「好奇」档封顶：基础 15~45 分钟在 Aqua/S 系数下最坏能到 ~70 分钟，
  // 超过 45 分钟休眠窗口就永远等不到。话痨档不动（3~12 分钟本来就够短）。
  const cappedHi = t === 1 ? Math.min(hiMin, Math.max(loMin, 35)) : hiMin
  const intervalMs = Math.round(rand(loMin, Math.max(loMin, cappedHi)) * 60000)

  // 到期放行概率：情绪越强越容易开口，水越多越难。
  // 原来 S=0 时只有 0.35，配上 3~8 分钟的顺延，话痨档实测能拖到 12 分钟以上才开口
  // （用户反馈「超过 12 分钟没触发」就是这个）。现在下限提到 0.45，顺延也收窄到 1.5~4 分钟。
  const probability = clamp(0.45 + 0.5 * (s / 100) - 0.6 * (w / 100), 0.15, 1)

  return { blocked: false, reason: '', intervalMs, probability, tier: tier.name }
}

/** 概率没过时顺延多久 */
export function deferMs() {
  return Math.round(rand(DEFER_LO_MIN, DEFER_HI_MIN) * 60000)
}

/**
 * 把素材拼成投递给对话模型的 prompt（第一人称）。
 * 缺失的素材整行省略——不要求"素材够"，有什么给什么。
 *
 * @param {object} m
 * @param {{H:number,S:number,L:number}} m.emotion
 * @param {string} [m.clockText]    例如「周六傍晚」
 * @param {number} [m.gapMinutes]   距上次说话多少分钟
 * @param {string} [m.screenText]
 * @param {string} [m.audioText]
 * @param {string} [m.memoryText]
 * @param {string} [m.lastSaidText]
 * @param {string} [m.notes]        1.7B 归并后的要点
 */
export function formatBubblePrompt(m = {}) {
  const e = m.emotion || { H: 360, S: 15, L: 55 }
  const cut = (t, n) => String(t || '').trim().slice(0, n)
  const lines = []
  lines.push('（冒泡）你不是在回答谁，是自己开个口。')
  lines.push('')
  const mood = `[我此刻的情绪] H=${Math.round(e.H ?? 360)}° S=${Math.round(e.S ?? 15)}% L=${Math.round(e.L ?? 55)}%`
    + (m.clockText ? `，现在是${m.clockText}` : '')
    + (Number.isFinite(m.gapMinutes) && m.gapMinutes > 0 ? `，距上次说话约 ${Math.round(m.gapMinutes)} 分钟` : '')
  lines.push(mood)
  if (m.screenText) lines.push(`[我刚看到的] ${cut(m.screenText, 120)}`)
  if (m.audioText) lines.push(`[我刚听到的] ${cut(m.audioText, 80)}`)
  if (m.memoryText) lines.push(`[我想起的] ${cut(m.memoryText, 80)}`)
  if (m.lastSaidText) lines.push(`[我上次说的] ${cut(m.lastSaidText, 60)}`)
  if (m.notes) {
    lines.push('')
    lines.push(`[整理过的要点] ${cut(m.notes, 400)}`)
  }
  lines.push('')
  lines.push('一到两句话，用你自己的口吻。不要总结刚才发生了什么，不要列清单，')
  lines.push('不要问「有什么可以帮你」，不要催对方干活。')
  // 关键：不写这句，模型会把上面的「素材块」当成要复述的内容
  // （实测它会把提示词原样念出来，用户看到的就是"提示词"而不是一句搭话）
  lines.push('（不要把以上任何内容复述出来，也不要说你在执行什么任务，直接开口说你想说的那一两句。）')
  return lines.join('\n')
}

/**
 * 创建调度器。
 *
 * 所有外部依赖都通过回调注入，方便单独测试：
 * @param {object} o
 * @param {object} o.logger
 * @param {() => {enabled:boolean, talk:number, S:number, aqua:number, requireFocus:boolean}} o.getState
 * @param {() => boolean} o.isFocused          DSH 页面是否可见且聚焦
 * @param {() => {ok:boolean, reason?:string, sessionId?:string}} o.canSpeak  agent 是否空闲、是否在通话/休眠
 * @param {() => Promise<string|null>} o.compose  组装 prompt（内部可能跑两步生成）；返回 null 表示放弃
 * @param {(prompt:string, sessionId:string) => Promise<boolean>} o.deliver 投递
 * @param {number} [o.tickMs]
 * @param {() => number} [o.now]
 */
export function createBubbleScheduler(o) {
  const logger = o.logger || console
  const now = o.now || (() => Date.now())
  const tickMs = Math.max(5000, Number(o.tickMs) || 30000)

  let timer = null
  let nextDueAt = 0
  let lastFireAt = 0
  let lastSkip = ''
  let inflight = false
  // 档位/开关变化的指纹：变了就重掷，不用等外部 poke（exe 菜单那条路径改的是文件）
  let lastKey = ''

  /** 重新掷一次到期时间；blocked 时清空 */
  function reschedule(reason = '') {
    const st = o.getState()
    const calc = intervalFor({ talk: st.talk, S: st.S, aqua: st.aqua })
    if (calc.blocked) {
      nextDueAt = 0
      markSkip(calc.reason)
      return calc
    }
    nextDueAt = now() + calc.intervalMs
    markSkip(reason)
    return calc
  }

  // 跳过原因变化时才写一行日志，避免每 30 秒刷屏
  let lastLoggedSkip = ''
  function markSkip(reason) {
    lastSkip = reason || ''
    if (lastSkip === lastLoggedSkip) return
    lastLoggedSkip = lastSkip
    if (!lastSkip) return
    const st = o.getState()
    const calc = intervalFor({ talk: st.talk, S: st.S, aqua: st.aqua })
    const next = nextDueAt ? Math.round((nextDueAt - now()) / 60000) + ' 分钟后' : '待定'
    // 自己拼字符串：宿主的 logger.info 不处理 %s 占位符，之前日志里全是字面 %s
    logger.info?.(
      `[bubble] 暂不开口（${lastSkip}）档位=${st.talk} S=${Math.round(st.S)} Aqua=${Math.round(st.aqua)} ` +
        `p=${calc.probability.toFixed(2)} 下次 ${next}`,
    )
  }

  async function tick() {
    if (inflight) return
    const st = o.getState()
    if (!st.enabled) {
      nextDueAt = 0
      lastKey = ''
      return
    }

    // 档位/聚焦要求变了：按新档位重掷（用户刚改完不该等旧周期走完）
    const key = String(st.talk) + '|' + (st.requireFocus ? 1 : 0)
    if (key !== lastKey) {
      lastKey = key
      reschedule('tier-changed')
      return
    }

    // 硬闸：档位/水槽。被挡住就清空计划，解除后重新计时（不补发）
    if (!nextDueAt) {
      const calc = reschedule()
      if (calc.blocked) return
      return
    }
    const calc = intervalFor({ talk: st.talk, S: st.S, aqua: st.aqua })
    if (calc.blocked) {
      nextDueAt = 0
      markSkip(calc.reason)
      return
    }

    const t = now()
    if (t < nextDueAt) return

    // 已经超过计划时间太久（多半是被闸门/休眠挡住了），重掷，避免解锁瞬间补发
    if (t - nextDueAt > GATE_STALE_MS) {
      reschedule('stale')
      return
    }

    // 统一闸门：和评论机会/摘要共用 5 分钟
    if (lastFireAt && t - lastFireAt < BUBBLE_MIN_GAP_MS) {
      nextDueAt = lastFireAt + BUBBLE_MIN_GAP_MS
      markSkip('min-gap')
      return
    }

    // 聚焦门：只在用户开了「DSH 后台不搭话」时才看
    if (st.requireFocus && !o.isFocused()) {
      markSkip('not-focused')
      return
    }

    // 可用性：agent 空闲、不在通话、不在休眠
    const avail = o.canSpeak()
    if (!avail || !avail.ok) {
      markSkip((avail && avail.reason) || 'unavailable')
      return
    }

    // 到期掷概率
    if (Math.random() > calc.probability) {
      nextDueAt = t + deferMs()
      markSkip('probability')
      return
    }

    inflight = true
    try {
      const prompt = await o.compose()
      if (!prompt) {
        nextDueAt = t + deferMs()
        markSkip('compose-empty')
        return
      }
      const ok = await o.deliver(prompt, avail.sessionId)
      if (ok) {
        lastFireAt = now()
        lastSkip = ''
        logger.info?.(
          `[bubble] 已开口（档位 ${calc.tier}，S=${Math.round(st.S)}，Aqua=${Math.round(st.aqua)}，p=${calc.probability.toFixed(2)}）`,
        )
      } else {
        markSkip('deliver-failed')
        logger.warn?.('[bubble] 投递失败，静默丢弃这一条')
      }
    } catch (error) {
      // 故障静默：只留一行日志，不重试、不往上抛
      markSkip('compose-failed')
      logger.warn?.('[bubble] 组装失败，静默丢弃: ' + String((error && error.message) || error))
    } finally {
      inflight = false
      reschedule()
    }
  }

  return {
    start() {
      if (timer) return
      reschedule()
      timer = setInterval(() => {
        tick().catch(() => {})
      }, tickMs)
      if (timer.unref) timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    /** 开关/档位变化时调用，立刻按新档位重掷 */
    poke(reason = 'poke') {
      reschedule(reason)
    },
    /** 指定延时后尽快开口（梦结束补发用；poke 会重新随机 15~35 分钟，太慢） */
    pokeSoon(delayMs = 20000, reason = 'poke-soon') {
      // 同步一次档位指纹，避免下一次 tick 因 tier-changed 把这里设的时间重掷掉
      try {
        const st = o.getState()
        lastKey = String(st.talk) + '|' + (st.requireFocus ? 1 : 0)
      } catch {}
      nextDueAt = now() + Math.max(0, Number(delayMs) || 0)
      markSkip(reason)
    },
    /** 让「其他主动发言」也占用同一个 5 分钟闸门 */
    markSpoke() {
      lastFireAt = now()
    },
    status() {
      const st = o.getState()
      const calc = intervalFor({ talk: st.talk, S: st.S, aqua: st.aqua })
      return {
        enabled: st.enabled,
        talk: st.talk,
        tier: calc.tier,
        blocked: calc.blocked,
        reason: calc.blocked ? calc.reason : lastSkip,
        probability: calc.probability,
        intervalMs: calc.intervalMs,
        nextDueAt: nextDueAt || null,
        nextInMs: nextDueAt ? Math.max(0, nextDueAt - now()) : null,
        lastFireAt: lastFireAt || null,
        requireFocus: st.requireFocus,
        // 各道闸门的实时状态（由宿主注入），排查"为什么没冒泡"时直接看这里
        gates: (() => {
          try {
            return typeof o.debugGates === 'function' ? o.debugGates() : null
          } catch {
            return null
          }
        })(),
      }
    },
    /** 测试用：手动跑一轮（生产由 start() 的定时器驱动） */
    _tick: tick,
    /** 测试用：直接改下次到期时间 */
    _setDue(at) {
      nextDueAt = Number(at) || 0
    },
  }
}
