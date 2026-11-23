import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// 空闲调度：9min 开始做梦（一场梦，每 3min 抽卡续写）→ 30min 休眠
// 日志：一场梦记一次（不是每轮）；半梦流式落盘；休眠前收尾
import { buildDeck, drawCards, continueDream, evaluateDream, DREAM_CONFIG, refreshEmotion } from './dream.mjs'
import { createDreamPartial, appendDreamPartial, finalizeDreamPartial, listDreamPartials } from './journal.mjs'

export const IDLE_CONFIG = Object.freeze({
  dreamStartMin: 9, // 空闲 9 分钟开始做梦
  cardIntervalMs: 3 * 60 * 1000, // 每 3 分钟抽一次卡
  sleepMin: 45, // 空闲 45 分钟休眠（覆盖「好奇」档最长的一次搭话窗口，梦不会被过早掐断）
  maxTokens: 1500, // 每轮续写字数
  dreamMaxMin: 20, // 一场梦最长 20 分钟（再长就把整个空闲窗口占满，搭话没机会开口）
  dreamCooldownMin: 20, // 梦结束后至少隔 20 分钟再做梦（给搭话留窗口）
  presenceFreshMin: 2, // 陪看/听歌信号多久内算「人在」：这段时间不睡觉、不做梦
  logThreshold: 3, // 整场自评 ≥3 → 记日志
})


// 快速调试：data/ui-state/idle-fast.json 里可以临时改做梦/休眠的时间，用来加速测试
function fastOverrides(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir || '.', 'ui-state', 'idle-fast.json'), 'utf8'))
    const out = {}
    if (Number.isFinite(Number(j?.dreamStartMin))) out.dreamStartMin = Math.max(0, Number(j.dreamStartMin))
    if (Number.isFinite(Number(j?.sleepMin))) out.sleepMin = Math.max(0, Number(j.sleepMin))
    if (Number.isFinite(Number(j?.cardIntervalMs))) out.cardIntervalMs = Math.max(0, Number(j.cardIntervalMs))
    if (Number.isFinite(Number(j?.dreamMaxMin))) out.dreamMaxMin = Math.max(0, Number(j.dreamMaxMin))
    if (Number.isFinite(Number(j?.dreamCooldownMin))) out.dreamCooldownMin = Math.max(0, Number(j.dreamCooldownMin))
    if (Number.isFinite(Number(j?.presenceFreshMin))) out.presenceFreshMin = Math.max(0, Number(j.presenceFreshMin))
    return out
  } catch {
    return {}
  }
}
function cfgNow(dir) {
  return { ...IDLE_CONFIG, ...fastOverrides(dir) }
}

export function createIdleScheduler({
  logger = console,
  dataDir,
  store = null,
  sleepAll = async () => {},
  onWake = null, // 从休眠里被用户输入叫醒时回调（负责把模型拉回来）
  getPersona = () => '',
  getMood = () => '',
  onDreamEnd = null, // 梦结束回调（外部可感知）
  onDreamStart = null, // 梦开始前回调（外部负责停视觉/听觉/TTS，只留 qwen3+embedding+omni）
  checkIntervalMs = 30 * 1000,
  continueDreamFn = continueDream, // 可被外部替换成云端续写
  canDream = () => true, // 还能不能做梦（云端配额用完就返回 false）
} = {}) {
  // 外部注入的续写/闸门：用常量接一下，静态检查才认得
  const dreamContinueImpl = continueDreamFn
  const dreamAllowed = canDream
  let idleSince = Date.now()
  let timer = null
  let sleeping = false
  let lastDreamAt = 0
  let nextDreamAt = 0
  let lastPresenceAt = 0
  let lastPresenceKind = ''
  let sleepPostponedLogged = false
  let partialPath = null
  const pendingDreams = []
  // 梦场状态
  let session = null // { text, cards, startedAt, lastCardAt, abort }

  /** 陪看/听歌等"人还在"的信号：不算用户说话，只推迟休眠/压住做梦 */
  function touchPresence(kind = 'activity') {
    lastPresenceAt = Date.now()
    lastPresenceKind = String(kind || 'activity')
  }
  function presenceFresh() {
    const min = Number(cfgNow(dataDir).presenceFreshMin) || 0
    return lastPresenceAt > 0 && Date.now() - lastPresenceAt < min * 60000
  }

  function touchUser() {
    idleSince = Date.now()
    // 之前这里是 bug：休眠后 sleeping 一直是 true，tick() 永远判「已休眠」，
    // 用户再怎么说话模型也不会醒。必须在这里清掉，并通知外部重新拉起模型。
    const wasSleeping = sleeping
    sleeping = false
    if (session?.abort) {
      try {
        session.abort.abort()
      } catch {}
    }
    if (wasSleeping) {
      logger.info?.('[hcem] 用户有输入，从休眠中唤醒')
      try {
        onWake?.()
      } catch (error) {
        logger.warn?.('[hcem] 唤醒失败: ' + String((error && error.message) || error))
      }
    }
  }

  function flushPending() {
    while (pendingDreams.length > 0) {
      const d = pendingDreams.shift()
      if (!dataDir) continue
      try {
        // 用 journal 的 appendJournal（旧 API 兼容）写一场梦
        import('./journal.mjs').then(({ appendJournal }) => {
          appendJournal({ dataDir, text: d.text, mood: d.mood })
        })
      } catch (error) {
        logger.warn?.('[hcem] 日志落盘失败: ' + String((error && error.message) || error))
      }
    }
  }

  /** 抽卡（一场梦的一批碎片） */
  function drawBatch() {
    if (!store) return []
    const deck = buildDeck({ store })
    const count = 3 + Math.floor(Math.random() * 4)
    return drawCards(deck, count)
  }

  /** 开始一场梦（先等外部让位/拉起模型完成） */
  async function startSession() {
    if (session) return
    session = { text: '', cards: 0, startedAt: Date.now(), lastCardAt: 0, abort: new AbortController() }
    partialPath = createDreamPartial(dataDir)
    logger.info?.('[hcem] 梦开始')
    // 做梦前让位：视觉/听觉/TTS 都不需要，只留 qwen3(卡牌) + embedding + omni(续写)
    try {
      try {
      await onDreamStart?.()
    } catch (e) {
      logger.warn?.('[hcem] 梦前让位失败: ' + String((e && e.message) || e))
    }
    } catch (e) {
      logger.warn?.('[hcem] 梦前让位异常: ' + String((e && e.message) || e))
    }
  }

  /** 梦场推进：抽卡 + 续写 */
  async function stepSession() {
    if (!session || !store) return
    if (session.abort?.signal?.aborted) return
    const now = Date.now()
    if (now - session.lastCardAt < cfgNow(dataDir).cardIntervalMs && session.text) return
    const cards = drawBatch()
    if (cards.length === 0) return
    session.lastCardAt = now
    session.cards += cards.length
    const r = await dreamContinueImpl({
      previous: session.text,
      cards,
      persona: getPersona(),
      mood: getMood(),
      timeoutMs: 180000,
      maxTokens: IDLE_CONFIG.maxTokens,
      signal: session.abort.signal,
      onChunk: (chunk) => appendDreamPartial(partialPath, chunk),
    })
    if (!session) return
    const t = String(r?.text ?? '').trim()
    if (t) {
      session.text += (session.text ? '\n\n' : '') + t
      logger.info?.(`[hcem] 梦续写（${t.length} 字，累计 ${session.text.length}）`)
    }
    if (r?.interrupted) {
      logger.info?.('[hcem] 梦被打断')
    }
  }

  /** 结束一场梦（30min 前/用户回来）→ 自评 + 记录整场 */
  async function endSession({ half = false } = {}) {
    if (!session) return
    const { text } = session
    const s = session
    session = null
    if (!text) {
      if (partialPath) {
        try {
          finalizeDreamPartial(dataDir, partialPath, { half: true })
        } catch {}
      }
      partialPath = null
      try {
        onDreamEnd?.({ text: '', score: 0 })
      } catch {}
      return
    }
    const score = await evaluateDream({ dream: text })
    const shouldLog = score >= DREAM_CONFIG.logThreshold || half
    if (shouldLog && dataDir) {
      const mood = `${half ? '半梦' : '梦'} ${score}/5（${s.cards} 碎片）`
      try {
        const { appendJournal } = await import('./journal.mjs')
        appendJournal({ dataDir, text, mood })
        logger.info?.(`[hcem] 整场梦已记录（${score}/5，${text.length} 字）`)
      } catch (error) {
        logger.warn?.('[hcem] 记录失败: ' + String((error && error.message) || error))
      }
    }
    if (partialPath) {
      try {
        finalizeDreamPartial(dataDir, partialPath, { half, mood: `${score}/5` })
      } catch {}
      partialPath = null
    }
    lastDreamAt = Date.now()
    nextDreamAt = Date.now() + cfgNow(dataDir).dreamCooldownMin * 60000
    try {
      onDreamEnd?.({ text, score })
    } catch {}
  }

  async function gracefulSleep() {
    if (sleeping) return
    sleeping = true
    logger.info?.('[hcem] 进入休眠（收尾中）')
    if (session) {
      // 收尾：结束当前梦（半梦）
      try {
        session.abort?.abort()
      } catch {}
      await new Promise((r) => setTimeout(r, 1500))
      await endSession({ half: true })
    }
    flushPending()
    try {
      await sleepAll()
    } catch (error) {
      logger.warn?.('[hcem] 休眠失败: ' + String((error && error.message) || error))
    }
    logger.info?.('[hcem] 休眠完成（模型已关）')
  }

  async function tick() {
    const idleMin = (Date.now() - idleSince) / 60000
    if (idleMin >= cfgNow(dataDir).sleepMin) {
      if (presenceFresh()) {
        // 在陪看/听歌：模型要留着用，别睡；等信号停了再走正常休眠
        if (!sleepPostponedLogged) {
          sleepPostponedLogged = true
          logger.info?.('[hcem] 检测到陪看/听歌（' + (lastPresenceKind || 'activity') + '），推迟休眠')
        }
        return
      }
      sleepPostponedLogged = false
      if (!sleeping) await gracefulSleep()
      return
    }
    sleepPostponedLogged = false
    // 梦被用户打断后要立刻收尾：否则 dreaming 一直为 true，搭话会被永久压住
    if (session && session.abort?.signal?.aborted) {
      await endSession({ half: true })
    }
    // 梦太长会把整个空闲窗口占满（搭话永远没机会），到上限就收尾
    if (session && Date.now() - session.startedAt >= cfgNow(dataDir).dreamMaxMin * 60000) {
      logger.info?.('[hcem] 梦到时长上限，收尾让位给搭话')
      await endSession({ half: false })
    }
    if (idleMin >= cfgNow(dataDir).dreamStartMin) {
      if (!session) {
        if (dreamAllowed() && !presenceFresh() && Date.now() >= nextDreamAt && Date.now() - lastDreamAt >= 60 * 1000) await startSession()
      }
      if (session) await stepSession()
    }
  }

  function recoverPartials() {
    try {
      for (const p of listDreamPartials(dataDir)) finalizeDreamPartial(dataDir, p, { half: true, mood: '（上次未完成）' })
    } catch {}
  }

  return {
    touchUser,
    touchPresence,
    recoverPartials,
    start() {
      if (timer) return
      timer = setInterval(() => {
        tick().catch(() => {})
      }, checkIntervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    getState() {
      return {
        idleMin: (Date.now() - idleSince) / 60000,
        dreaming: Boolean(session),
        sleeping,
        pending: pendingDreams.length,
        present: presenceFresh(),
        presenceKind: lastPresenceKind,
      }
    },
    flushPending,
    gracefulSleep,
    endSession,
  }
}
