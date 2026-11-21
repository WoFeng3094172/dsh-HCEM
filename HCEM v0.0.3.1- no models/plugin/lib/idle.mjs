// 空闲调度：9min 开始做梦（一场梦，每 3min 抽卡续写）→ 30min 休眠
// 日志：一场梦记一次（不是每轮）；半梦流式落盘；休眠前收尾
import { buildDeck, drawCards, continueDream, evaluateDream, DREAM_CONFIG, refreshEmotion } from './dream.mjs'
import { createDreamPartial, appendDreamPartial, finalizeDreamPartial, listDreamPartials } from './journal.mjs'

export const IDLE_CONFIG = Object.freeze({
  dreamStartMin: 9, // 空闲 9 分钟开始做梦
  cardIntervalMs: 3 * 60 * 1000, // 每 3 分钟抽一次卡
  sleepMin: 30, // 空闲 30 分钟休眠
  maxTokens: 1500, // 每轮续写字数
  logThreshold: 3, // 整场自评 ≥3 → 记日志
})

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
} = {}) {
  let idleSince = Date.now()
  let timer = null
  let sleeping = false
  let lastDreamAt = 0
  let partialPath = null
  const pendingDreams = []
  // 梦场状态
  let session = null // { text, cards, startedAt, lastCardAt, abort }

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
    const now = Date.now()
    if (now - session.lastCardAt < IDLE_CONFIG.cardIntervalMs && session.text) return
    const cards = drawBatch()
    if (cards.length === 0) return
    session.lastCardAt = now
    session.cards += cards.length
    const r = await continueDream({
      previous: session.text,
      cards,
      persona: getPersona(),
      mood: getMood(),
      timeoutMs: 180000,
      maxTokens: IDLE_CONFIG.maxTokens,
      signal: session.abort.signal,
      onChunk: (chunk) => appendDreamPartial(partialPath, chunk),
    })
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
    if (idleMin >= IDLE_CONFIG.sleepMin) {
      if (!sleeping) await gracefulSleep()
      return
    }
    if (idleMin >= IDLE_CONFIG.dreamStartMin) {
      if (!session) {
        if (Date.now() - lastDreamAt >= 60 * 1000) await startSession()
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
      return { idleMin: (Date.now() - idleSince) / 60000, dreaming: Boolean(session), sleeping, pending: pendingDreams.length }
    },
    flushPending,
    gracefulSleep,
    endSession,
  }
}
