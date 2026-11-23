/**
 * 感知调度器：把「截屏 + 监听」合并成一个自适应节拍，并据此决定「要不要主动搭话」
 *
 * 设计（用户定）：
 *   最终档位 = 用户选的搭话档 + L 修正（B 方案）
 *     L > 60 → +1（精神好，多说）
 *     L < 40 → -1（累了，少说）
 *   档位决定：基础采样间隔 + 评论概率权重
 *     0 话痨 3s / ×1.4
 *     1 好奇 6s / ×1.0
 *     2 安静 12s / 几乎不主动（只有「用户刚说话」或「情绪剧烈波动」才可能开口）
 *
 *   环境变化大 → 采样更勤（最短 2s）；连续安静 → 采样更慢（最长 30s）
 *   音频间隔 = 视觉间隔 × 2，且不低于 8s（因为一次要录 5s）
 *
 * 说话时机完全交给 perception/comment-scheduler.shouldComment()，本模块只负责：
 *   1) 决定下一次什么时候采样
 *   2) 攒够「变化」和「新场景」信号后，问一句「该不该说」
 *   3) 该说就回调 onComment（由 index.mjs 接到主动说话通道）
 */

import { fpsFromEmotion } from './emotion-fps.mjs'
import { shouldComment } from './comment-scheduler.mjs'

/** 档位参数：间隔 / 评论权重 */
export const TALK_TIERS = [
  { name: '话痨', baseIntervalMs: 3000, commentWeight: 1.4 },
  { name: '好奇', baseIntervalMs: 6000, commentWeight: 1.0 },
  { name: '安静', baseIntervalMs: 12000, commentWeight: 0 }, // 安静档默认不主动，见 below
]

export const MIN_INTERVAL_MS = 2000
export const MAX_INTERVAL_MS = 30000
export const AUDIO_MULTIPLIER = 2
export const AUDIO_MIN_MS = 8000
export const COMMENT_COOLDOWN_MS = 20000
export const CHANGE_WINDOW_MS = 30000

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)))

/**
 * 用户档位 + L 修正 → 最终档位（0 话痨 / 1 好奇 / 2 安静）
 */
export function effectiveTier(talk, L) {
  const base = clamp(talk ?? 1, 0, 2)
  const l = clamp(L ?? 55, 0, 100)
  let tier = base
  if (l > 60) tier -= 1
  else if (l < 40) tier += 1
  return clamp(tier, 0, 2)
}

/**
 * 由变化率 + 档位 + 情绪算下一次采样间隔
 * @param {object} p { talk, L, changeRate }
 */
export function intervalFor({ talk = 1, L = 55, changeRate = 0 } = {}) {
  const tier = effectiveTier(talk, L)
  const t = TALK_TIERS[tier]
  // 变化率越高 → 越勤（1/(1+2r) 把 0→1 映射到 1→1/3）
  const changeFactor = 1 / (1 + clamp(changeRate, 0, 1) * 2)
  // L 越高（精神）→ 略勤
  const emotionFactor = 1.4 - 0.6 * (clamp(L, 0, 100) / 100)
  const raw = t.baseIntervalMs * changeFactor * emotionFactor
  return Math.round(clamp(raw, MIN_INTERVAL_MS, MAX_INTERVAL_MS))
}

/**
 * 安静档的「几乎不主动」规则：
 *   默认不说；只有「用户刚说话」或「情绪剧烈波动」才放行。
 */
export function quietGate({ recentUserMessage = false, emotionDelta = 0 } = {}) {
  if (recentUserMessage) return { allow: true, probability: 0.5, reason: '用户在互动' }
  if (Number(emotionDelta) >= 0.5) return { allow: true, probability: 0.3, reason: '情绪剧烈波动' }
  return { allow: false, probability: 0, reason: '安静档不主动' }
}

/**
 * 创建调度器
 * @param {object} opts
 * @param {() => number} opts.getL         当前 L
 * @param {() => number} opts.getTalk      用户选的档位 0/1/2
 * @param {() => boolean} [opts.getRecentUserMessage] 最近 30s 是否用户说过话
 * @param {() => Promise<{ok:boolean, changeScore:number, newScene?:boolean, description?:string, image?:string}>} opts.capture
 * @param {() => Promise<{ok:boolean, text?:string, kind?:string, emotion?:string}>} [opts.listen]
 * @param {(payload:object) => Promise<void>|void} opts.onComment
 */
export function createSenseScheduler(opts = {}) {
  const {
    getL = () => 55,
    getTalk = () => 1,
    getRecentUserMessage = () => false,
    capture,
    listen,
    onComment,
    logger = console,
  } = opts

  let running = false
  let timer = null
  let lastCommentAt = 0
  let lastInterval = 0
  let ticks = 0
  let audioTicks = 0
  let nextAudioAt = 0
  const changes = [] // [{ at, score }]
  let lastScene = null
  let lastEmotion = null
  let lastDescription = ''

  function pushChange(score, at) {
    changes.push({ at, score: clamp(score, 0, 1) })
    const cutoff = at - CHANGE_WINDOW_MS
    while (changes.length && changes[0].at < cutoff) changes.shift()
  }

  function changeRate() {
    if (changes.length === 0) return 0
    const sum = changes.reduce((a, c) => a + c.score, 0)
    return clamp(sum / changes.length, 0, 1)
  }

  async function doCapture() {
    if (typeof capture !== 'function') return { ok: false }
    try {
      const r = (await capture()) || {}
      if (r.ok) {
        pushChange(Number(r.changeScore ?? 0), Date.now())
        if (r.description) lastDescription = r.description
      }
      return r
    } catch (e) {
      logger.warn?.('[sense] capture failed: ' + (e && e.message))
      return { ok: false }
    }
  }

  async function doListen() {
    if (typeof listen !== 'function') return { ok: false }
    try {
      const r = (await listen()) || {}
      if (r.ok) {
        audioTicks++
        if (r.emotion) lastEmotion = r.emotion
        if (r.kind && r.kind !== lastScene) lastScene = r.kind
      }
      return r
    } catch (e) {
      logger.warn?.('[sense] listen failed: ' + (e && e.message))
      return { ok: false }
    }
  }

  async function tick() {
    if (!running) return
    const now = Date.now()
    ticks++

    const cap = await doCapture()

    // 音频到点才录（视觉间隔 ×2，且不低于 8 秒）
    if (now >= nextAudioAt) {
      await doListen()
      nextAudioAt = Date.now() + Math.max(AUDIO_MIN_MS, lastInterval * AUDIO_MULTIPLIER)
    }

    // 该不该说话
    try {
      const L = clamp(getL(), 0, 100)
      const talk = getTalk()
      const tier = effectiveTier(talk, L)
      const delta = Math.abs(Number(cap.changeScore ?? 0))
      const recent = Boolean(getRecentUserMessage())
      const newScene = Boolean(cap.newScene)

      let decision
      if (tier >= 2) {
        // 安静档：几乎不主动
        const gate = quietGate({ recentUserMessage: recent, emotionDelta: delta })
        decision = gate.allow
          ? { speak: Math.random() < gate.probability, reason: gate.reason, maxChars: 20 }
          : { speak: false, reason: gate.reason, maxChars: 0 }
      } else {
        const base = shouldComment({ L, emotionDelta: delta, newScene, recentUserMessage: recent })
        // 说话内容长度用 shouldComment 的档；概率再用 talk 权重微调
        const w = TALK_TIERS[tier].commentWeight
        const p = clamp(base.probability * w, 0, 1)
        decision = { speak: Math.random() < p, reason: base.reason, maxChars: base.maxChars, probability: p }
      }

      const cooldownOk = now - lastCommentAt >= COMMENT_COOLDOWN_MS
      if (decision.speak && cooldownOk && typeof onComment === 'function') {
        lastCommentAt = now
        await onComment({
          reason: decision.reason,
          maxChars: decision.maxChars,
          tier,
          L,
          screenDesc: lastDescription,
          audioKind: lastScene,
          changeScore: delta,
        })
      } else if (decision.speak && !cooldownOk) {
        logger.debug?.('[sense] comment suppressed by cooldown')
      }
    } catch (e) {
      logger.warn?.('[sense] comment decision failed: ' + (e && e.message))
    }

    // 排下一次
    const next = intervalFor({ talk: getTalk(), L: getL(), changeRate: changeRate() })
    lastInterval = next
    timer = setTimeout(tick, next)
  }

  return {
    start() {
      if (running) return { ok: true, already: true }
      running = true
      nextAudioAt = 0
      lastInterval = TALK_TIERS[effectiveTier(getTalk(), getL())].baseIntervalMs
      logger.info?.(`[sense] started (talk=${getTalk()}, L=${Math.round(getL())}, base=${lastInterval}ms)`)
      tick()
      return { ok: true }
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      logger.info?.('[sense] stopped')
      return { ok: true }
    },
    status() {
      return {
        running,
        ticks,
        audioTicks,
        lastIntervalMs: lastInterval,
        changeRate: Number(changeRate().toFixed(3)),
        lastScene,
        lastEmotion,
        lastCommentAgoMs: lastCommentAt ? Date.now() - lastCommentAt : null,
      }
    },
  }
}
