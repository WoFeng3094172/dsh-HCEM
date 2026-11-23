/**
 * 语音通话循环：一直听 → 听到一句就送进会话 → AI 回答时播报。
 *
 * 架构抄自 voice-call，但裁剪到 HCEM 现有能力：
 *   voice-call                          HCEM
 *   ─────────────────────────────────   ──────────────────────────────
 *   UtteranceDetector（Client 侧 VAD）   record_mic.py -1（Host 侧断句）
 *   remote.transcribe                   Qwen3-ASR 本地（CrispASR）
 *   remote.synthesize（流式）            CosyVoice + speakStream（逐句）
 *   binding.session.cancel()            无此接口 → 用 steer 送新话 + 停播放
 *   播放中 VAD onStart → interrupt      同样：开口瞬间停播放
 *
 * 关键一致的地方：**打断发生在开口那一刻**，不是等整句说完。
 * 所以 record_mic.py 开头会打一行 "start"，这里收到就立刻停播放。
 */

import { listenUtterance, interruptPlayback } from './voice-input.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一句说完后最多再探几次「接着说」 */
const MAX_MERGES = 2

/**
 * @param {object} opts
 * @param {(text:string)=>Promise<any>} opts.sendText 把识别文本送进会话
 * @param {(msg:string)=>void} [opts.log]
 * @param {(state:object)=>void} [opts.onState] 状态变化回调（给 UI 用）
 * @param {()=>boolean} [opts.isSpeaking] AI 是否正在播报（决定要不要打断）
 */
export function createVoiceCall({ sendText, log = () => {}, onState = () => {}, isSpeaking = () => false }) {
  let active = false
  let running = null
  let speaking = false
  let phase = 'idle'
  let level = 0
  let iterations = 0
  let lastError = ''
  let bargesIn = 0

  function publish(next, extra = {}) {
    phase = next
    try {
      onState({ phase: next, speaking, level, iterations, lastError, bargesIn, ...extra })
    } catch {}
  }

  /** 电平只更新数值，不触发一次状态回调风暴（UI 每帧都会问） */
  function setLevel(v) {
    const n = Number(v)
    level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
  }

  /** AI 开始/结束播报时调用，让 onStart 知道要不要打断 */
  function setSpeaking(v) {
    speaking = Boolean(v)
    publish(speaking ? 'speaking' : 'listening')
  }

  /** 打断：立刻停播放。返回是否真的打断了什么 */
  function bargeIn(reason = 'speech') {
    if (!isSpeaking() && !speaking) return false
    bargesIn += 1
    try {
      interruptPlayback()
    } catch (e) {
      log('打断失败: ' + String((e && e.message) || e))
    }
    log(`打断（${reason}）：停止播报`)
    publish('listening')
    return true
  }

  /** 用户开口：先打断（如果在播报），再切到「识别中」 */
  function itStarted() {
    bargeIn('onset')
    setLevel(0)
    publish('recognizing')
  }

  async function loop() {
    while (active) {
      let rec
      try {
        rec = await listenUtterance({
          onStart: () => {
            // 开口瞬间：立刻切到「识别中」，如果 AI 正在说就停——不等这句录完
            itStarted()
          },
          onLevel: (v) => setLevel(v),
        })
      } catch (e) {
        lastError = String((e && e.message) || e)
        log('听失败: ' + lastError)
        await sleep(600)
        continue
      }

      if (!active) break
      if (!rec.ok) {
        lastError = rec.error || '未知错误'
        publish('error', { error: lastError })
        await sleep(600)
        continue
      }
      if (rec.nospeech) {
        publish('listening')
        continue
      }

      let text = String(rec.text || '').trim()
      if (!text) {
        publish('listening')
        continue
      }

      // 接着说：一句说完后立刻再探一次（-2 模式，不等人声、从第一帧录）。
      // 用户常在气口停一下又说下去，不接住就会把一句话切成两半，
      // 切开后模型失去上下文，标点也跟着碎。
      //
      // 只在「看着没说完」时探：句尾有终止标点就认为说完了。
      // 否则每句都白等约 1.8 秒（探测要走满一个静音窗口）。
      // 也不在 AI 播报期间探，避免把 TTS 录回来。
      const looksUnfinished = !/[。！？!?…」』"”]$/.test(text)
      if (!speaking && looksUnfinished) {
        for (let k = 0; k < MAX_MERGES; k += 1) {
          if (!active) break
          publish('recognizing')
          let more
          try {
            more = await listenUtterance({
              continuation: true,
              onStart: () => setLevel(0),
              onLevel: (v) => setLevel(v),
            })
          } catch {
            break
          }
          const add = String((more && more.text) || '').trim()
          if (!more || !more.ok || !add) break
          text += add
          log('接着说，合并后: ' + text.slice(0, 80))
          // 接上之后已经收尾了就别再探
          if (/[。！？!?…]$/.test(add)) break
        }
      }

      iterations += 1
      publish('thinking', { text })
      log('听到: ' + text)
      try {
        const r = await sendText(text)
        log('送入会话: ' + JSON.stringify(r).slice(0, 200))
      } catch (e) {
        lastError = String((e && e.message) || e)
        log('送入失败: ' + lastError)
        publish('error', { error: lastError })
      }
      // 交给 AI/TTS，循环继续听（播放期间的打断由 onStart 负责）
      // 电平清零，否则说完之后条子还停在最后一帧的高度
      setLevel(0)
      publish('listening')
    }
    publish('idle')
  }

  return {
    start() {
      if (active) return { ok: true, already: true }
      active = true
      log('通话开始')
      publish('listening')
      running = loop().catch((e) => {
        log('通话循环退出: ' + String((e && e.message) || e))
      })
      return { ok: true }
    },
    async stop() {
      if (!active) return { ok: true, already: true }
      active = false
      log('通话结束')
      try {
        interruptPlayback()
      } catch {}
      try {
        await running
      } catch {}
      running = null
      publish('idle')
      return { ok: true }
    },
    setSpeaking,
    bargeIn,
    status() {
      return {
        active,
        phase: speaking ? 'speaking' : phase,
        speaking,
        level,
        iterations,
        lastError,
        bargesIn,
      }
    },
  }
}
