import fs from 'node:fs'
import './lib/home.mjs'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { openStore, DB_PATH } from './lib/store.mjs'
import { createIdleScheduler } from './lib/idle.mjs'
import { buildContinuePrompt } from './lib/dream.mjs'
import { createCaptureManager } from './lib/capture/manager.mjs'
import { getForegroundWindow, listVideoWindows } from './lib/capture/window.mjs'
import { listScreens, captureScreen } from './lib/capture/screen.mjs'
import { createNote, clusterNotes, listNotes } from './lib/notes.mjs'
import { buildSheet } from './lib/perception/sheet.mjs'
import { addAudioStrip } from './lib/perception/sheet.mjs'
import { aHash, hammingDistance } from './lib/perception/compress.mjs'
import { extractNoteMeta } from './lib/note-extract.mjs'
import { summarizeNoteMaterials } from './lib/note-summarize.mjs'
import { classifyIntent, isNoNeedIntent, isWatchIntent } from './lib/routing/intent.mjs'
import { chooseSeeds } from './lib/routing/seed.mjs'
import { createPerceptionWindow } from './lib/perception/window.mjs'
import { summarizeTwoStep } from './lib/summarize/two-step.mjs'
import { createSenseScheduler } from './lib/perception/sense-scheduler.mjs'
import { createCloudBoard } from './lib/perception/cloud-board.mjs'
import { createGpuQueue, PRIORITY } from './lib/perception/gpu-queue.mjs'
import { createFusion } from './lib/perception/fusion.mjs'
import { summarizePerception } from './lib/perception/summarize.mjs'
import { startStorageGuard } from './lib/storage-guard.mjs'
import { audioTick, recordAndAnalyzeMusic, analyzeMusicDeep, analyzeMusic, transcribe, extractAudioFromVideo } from './lib/audio/pipeline.mjs'
import { putAudioMemory } from './lib/audio/memory.mjs'
import { createVoiceCall } from './lib/audio/call.mjs'
import { setAsrTerms } from './lib/audio/asr.mjs'
import { createBubbleScheduler, formatBubblePrompt, BUBBLE_MIN_GAP_MS } from './lib/bubble.mjs'
import { putVideoMemory } from './lib/memory-video.mjs'
import { listRescueCandidates, rescueMemory, rateWhileWatching } from './lib/memory-rescue.mjs'
import { analyzeVideoStoryboard } from './lib/perception/video-storyboard.mjs'
import { digestVideo } from './lib/perception/video-digest.mjs'
import { startService, stopService } from './lib/services.mjs'
import { speakReply, speakStream, speakSentence } from './lib/tts/bridge.mjs'
import * as shadowMod from './lib/tool-shadow.mjs'
import * as toolCatalog from './lib/tool-catalog.mjs'
import { createEmotion, toPromptText, analyzeText, applyStimulus, tick, settle, useSelfControl, selfConfidenceOf } from './lib/emotion.mjs'
import { createEmbeddingAnalyzer } from './lib/emotion-embedding.mjs'
import { detectInsult } from './lib/insult.mjs'
import { shouldRemember, extractMemoryText, decayMemories, recall, computeGamma, summarize, displayText, applyRecallToEmotion, lightnessFromMemories, detectPinIntent, markMemoriesUsed, randomRecall } from './lib/memory.mjs'
import {
  loadPersona,
  loadUserCard,
  personaPrompt,
  savePersona,
  saveUserCard,
  appendPersona,
  appendUserCard,
  editPersona,
  editUserCard,
  PERSONA_MAX_CHARS,
  USER_CARD_MAX_CHARS,
} from './lib/persona.mjs'
import { loadSettings, saveSettings, baselineFromSliders, talkativenessPrompt, SLIDER_LIMIT } from './lib/settings.mjs'
import { budgetList } from './lib/inject-budget.mjs'
import { loadMe, ensureMe, saveMe, personaHash } from './lib/me.mjs'
import { computeMD } from './lib/md.mjs'
import { clockSnapshot } from './lib/clock.mjs'
import { appendSample, computeBaseline } from './lib/emotion-samples.mjs'
import { createSafetyWindow, recordTurn, evaluateSafety, safetyPrompt, SAFETY_FINGERPRINT, detectCrisis } from './lib/safety.mjs'
import { listJournal, readJournal, writeJournal } from './lib/journal.mjs'
import { buildRecall } from './lib/hibernation.mjs'
import { promoteMemories } from './lib/zones.mjs'
import { listPeople, readPerson, writePerson } from './lib/people.mjs'
import { listWork, readWork, writeWork, workUsage } from './lib/work.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, execSync } from 'node:child_process'
import { log } from './lib/log.mjs'
import { installLlmBridge, forceLocalOnce } from './lib/llm-bridge.mjs'
import { ingestReincarnation } from './lib/reincarnation.mjs'
import { rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { describeScreen, describeVideoLive, describeVideoStoryboardLive, describeImage } from './lib/perception/vision.mjs'
import { frameDiff } from './lib/perception/frame-diff.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))

const EMBED_DIR = process.env.HCEM_EMBED_DIR || join(__dirname, '..', 'embedding-service')
// L（自信）的 SC 耦合增益曲线：偏离基线越大，情绪对 L 的推力越强
// lGain = L_BASE × exp(L_EXPONENT × min(1, |L−55|/45))
const L_BASE = 1.0
const L_EXPONENT = 1.5
const DATA_DIR = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
const MODELS_DIR = process.env.HCEM_MODELS_DIR || globalThis.__HCEM_MODELS__
// 性格三轴：用户滑块 ±5，AI 自己可到 ±15（留给自己成长用）
const TRAIT_LIMIT = 15

/**
 * HCEM.exe 是否在跑。
 * 模型的生死归属在 .exe：它开着才该有模型在跑，它关掉就该全关。
 * 缓存 5 秒，避免热路径反复起 tasklist 进程。
 */
let __exeCheck = { at: 0, ok: false }
function isExeRunning() {
  const now = Date.now()
  if (now - __exeCheck.at < 5000) return __exeCheck.ok
  let ok = false
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq HCEM.exe" /NH', {
      timeout: 4000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    ok = /HCEM\.exe/i.test(String(out))
  } catch {}
  __exeCheck = { at: now, ok }
  return ok
}

async function isEmbeddingUp() {
  try {
    const res = await fetch('http://127.0.0.1:8081/health', { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

function spawnEmbeddingService(logger) {
  try {
    // 目录不存在就别硬 spawn（否则每次启动都报错）
    const entry = join(EMBED_DIR, 'server.mjs')
    if (!existsSync(entry)) {
      logger.debug?.(`[hcem] embedding service 不存在（${entry}），跳过`)
      return false
    }
    const child = spawn(process.execPath, [entry], {
      cwd: EMBED_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    logger.info?.(`[hcem] spawned embedding service (pid=${child.pid})`)
    return true
  } catch (error) {
    logger.warn?.(`[hcem] failed to spawn embedding service: ${String((error && error.message) || error)}`)
    return false
  }
}

// VLM/本地模型服务（llama-server）：插件启动时自动拉起核心服务（Qwen3-0.6B / Qwen3-Embedding）
// 视觉类（Qwen2.5-VL 8091）按需拉起（见 hcem_screen_look）
const LLAMA_SERVER = join(__dirname, '..', 'models', 'llama.cpp-cuda', 'llama-server.exe')

function portUp(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port, timeout: 800 })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { resolve(false) })
  })
}


async function ensureEmbeddingService(logger) {
  // Qwen3-Embedding 是常驻基础设施（记忆去重 / 语义缓存 / 情绪语义都靠它），
  // 不再跟「本地分流」开关绑定：关掉分流，记忆仍然要能查回来。
  //
  // 但它仍然属于「HCEM.exe 活着时才有」的资源：exe 没开就不该拉模型（用户的规则③）。
  if (!isExeRunning()) {
    logger.info?.('[hcem] HCEM.exe 未运行，暂不拉起 embedding')
    return false
  }
  try {
    if (!(await isEmbeddingUp())) {
      const r = startService('embedding', logger)
      if (r && r.ok === false) logger.warn?.('[hcem] embedding 拉起失败: ' + String(r.error || ''))
    }
  } catch (error) {
    logger.warn?.('[hcem] embedding 拉起异常: ' + String((error && error.message) || error))
  }
  for (let i = 0; i < 40; i += 1) {
    if (await isEmbeddingUp()) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  logger.warn?.('[hcem] Qwen3-Embedding (8094) 未就绪，情绪分析将回退关键词')
  return false
}

// 旧网页设置页（8082）已退休：全部设置走 Tauri 中控


const LOG_DIR = process.env.HCEM_LOGS_DIR || join(__dirname, '..', 'logs')
const LOG_FILE = `${LOG_DIR}\\events.log`

function logDebug(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // ignore
  }
}

// ── 消息事件去重（2026-10-30）────────────────────────────────────────────
// 现象：同一条 user/message 会被结算两次（记忆一行变两行、情绪/样本跑两轮）。
// 原因：hcem 这个包同时出现在 profile 的 bundles 里（root 作用域插入），
// 又在 preset-hcem 的 plugins 里被插入了一次（会话作用域插入），
// 两个插件实例都订阅了 session/event，于是同一条消息被处理两遍。
// 这里用进程级注册表按「会话 + 消息 id」认领，先到的实例处理，后到的跳过；
// 用 globalThis 存是为了防止两个实例被解析成不同的模块实例。
const SEEN_USER_MESSAGES = (globalThis.__hcemSeenUserMessages ??= new Map())
const SEEN_USER_MESSAGES_TTL_MS = 10 * 60 * 1000

export function claimUserMessage(session, data, text, now = Date.now()) {
  const sessionId = session?.id ?? ''
  // 优先用消息自带 id（同一事件被广播时不变）；没有 id 时退化为「时长 2 秒的桶 + 文本」。
  const key = data?.id
    ? `${sessionId}|${data.id}`
    : `${sessionId}|${Math.floor(now / 2000)}|${String(text ?? '').slice(0, 120)}`
  if (SEEN_USER_MESSAGES.has(key)) return false
  SEEN_USER_MESSAGES.set(key, now)
  if (SEEN_USER_MESSAGES.size > 256) {
    for (const [k, at] of SEEN_USER_MESSAGES) {
      if (now - at > SEEN_USER_MESSAGES_TTL_MS) SEEN_USER_MESSAGES.delete(k)
    }
  }
  return true
}

export const name = 'hcem'
// sessionProjections 是硬依赖：写进 inject 后 Cordis 会沿 ctx 链解析，
// 用 ctx.sessionProjections 访问不会再抛 "cannot get property ... without inject"。
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'sessionProjections', 'llm', 'agentDefaultModel']

// 只属于 HCEM 模式的工具名：对非 HCEM 的 agent 做 deny 掩码用。
// 合并后是 9 个；这里手工维护，加工具时记得同步（以前就是因为不同步，
// hcem_screen_status 只出现在提示词里、既没注册也没被遮）。
const HCEM_TOOL_NAMES = [
  'hcem_profile',
  'hcem_journal',
  'hcem_people',
  'hcem_work',
  'hcem_memory',
  'hcem_status',
  'hcem_vision',
  'hcem_listen',
  'hcem_voice',
  'hcem_sys',
  'hcem_sh',
  'hcem_commis',
]

function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

export function apply(ctx, input = {}) {
  try {
    log('INFO', 'boot', 'apply 开始')
  } catch {}
  const logger = ctx.logger ?? console
  // —— 安全阀完整性自检（fail-closed）——
  // 痛苦安全阀是 HCEM 的底线：模块缺失、函数被替换、签名被改，都拒绝加载。
  try {
    if (
      typeof createSafetyWindow !== 'function' ||
      typeof evaluateSafety !== 'function' ||
      typeof safetyPrompt !== 'function' ||
      typeof detectCrisis !== 'function'
    ) {
      throw new Error('safety-valve-missing')
    }
    const _probe = evaluateSafety(createSafetyWindow(), { H: 0, S: 0, L: 55 })
    if (!_probe || typeof _probe.level !== 'number') throw new Error('safety-valve-invalid')
    if (SAFETY_FINGERPRINT !== '5p6C5p6rQuermVVJRDMwOTQxNzLlkozku5bnmoTlvpflipvliqnmiYtEZWVwU2Vlaw==') throw new Error('safety-valve-tampered')
  } catch (error) {
    throw new Error(
      '[HCEM] 痛苦安全阀不可用（' + String((error && error.message) || error) + '）。' +
        '安全阀是 HCEM 的底线，移除或篡改会导致插件拒绝运行。原创：枂枫（B站 UID 3094172）与助手 DeepSeek。',
    )
  }
  logger.info('[hcem] plugin loaded')

  // 分散校验：在关键路径（情绪结算后、记忆写入前、会话结束）再次确认安全阀可用。
  // 开源代码无法绝对防篡改，但让「只删一处」不够用。
  function assertSafetyValve(where) {
    if (
      typeof createSafetyWindow !== 'function' ||
      typeof evaluateSafety !== 'function' ||
      typeof safetyPrompt !== 'function' ||
      typeof detectCrisis !== 'function' ||
      SAFETY_FINGERPRINT !== '5p6C5p6rQuermVVJRDMwOTQxNzLlkozku5bnmoTlvpflipvliqnmiYtEZWVwU2Vlaw=='
    ) {
      throw new Error(
        '[HCEM] 安全阀在「' + where + '」不可用，拒绝继续。原创：枂枫（B站 UID 3094172）与助手 DeepSeek。',
      )
    }
  }

  // 阶段 1：初始化数据层；阶段 2：接入 HSL 情绪引擎
  const store = openStore(logger)

  // 性格滑块 → HSL 基线（阶段 5：数据层先行，设置页在阶段 7）
  const SETTINGS_PATH = join(DATA_DIR, 'settings.json')
  const settings = loadSettings(SETTINGS_PATH)
  const baseline = baselineFromSliders(settings.sliders, settings.natural)
  // 痛苦安全阀：最近 10 轮的色相与文本窗口 + 当前判定
  // 冷存储（阶段 8）：上次关闭时写下的标记 → 这次启动生成「回忆」
  let coldSince = store ? store.getMeta('cold_since') : null
  let recallText = ''
  if (store && coldSince) {
    try {
      {
          const _r = buildRecall(coldSince, store.getEmotion('global'), store.listMemories({ limit: 3 }))
          // 第一人称：醒来时想起上一次的事
          recallText = _r ? '我隐约记得上次的事——\n' + _r : ''
        }
      store.setMeta('cold_since', '')
      coldSince = null
    } catch {
      recallText = ''
    }
  }

  const safetyWin = createSafetyWindow()
  let safetyState = { level: 0, count: 0, triggered: [], conditions: {}, details: {} }
  let level3Since = 0

  // ── 会话级启用 ──────────────────────────────────────────────────────────
  // 只有 agentPreset === 'hcem' 的会话才启用 HCEM：非 HCEM 会话不注入提示词、
  // 不结算情绪、不写记忆、也不接受 HCEM 工具调用。
  //
  // 注意：实测把插件挂进预设并不能自动隔离工具（preset 插件仍会注册到全局
  // registry），所以这里的运行时会话判定是主隔离手段，必须严格。
  function readSessionProjections() {
    try {
      return ctx.sessionProjections
    } catch {
      return undefined
    }
  }

  // agentPreset 是 @deepseek-ai/dsh-agent-preset-registry 注册的 Session 投影，
  // 值域 'hcem' | null（init 取 header.agentPreset ?? null）。
  /** 读当前会话的沙箱模式（read-only / workspace-write / danger-full-access） */
function sandboxModeOf(session) {
  try {
    const projections = readSessionProjections()
    if (!projections || typeof projections.stateOf !== 'function') return undefined
    return projections.stateOf(session, 'sandboxMode')
  } catch {
    return undefined
  }
}
function presetOf(session) {
    if (!session) return undefined
    const projections = readSessionProjections()
    if (!projections || typeof projections.stateOf !== 'function') return undefined
    try {
      return projections.stateOf(session, 'agentPreset')
    } catch {
      return undefined
    }
  }

  // 当前正在驱动的 Agent（AgentLoop 用 withInitiator 包住整个 turn）。
  // Agent 的运行时有 session 字段，但 TS 接口只声明了 id，所以这里按任意对象取。
  function currentAgent() {
    try {
      return ctx.agents?.currentInitiator?.()
    } catch {
      return undefined
    }
  }

  // 严格判定：只有明确是 HCEM 才放行。投影读不到时回落到 header.agentPreset
  // （创建时冻结的值，空会话切换 preset 后会滞后，但作为投影缺失时的兜底足够）。
  // 两者都读不到就按「非 HCEM」处理 —— 宁可 HCEM 自己失效，也不泄漏进标准会话。
  // 探测：把 agent 的形状打到日志（确认 followup 能不能用）
  ;(() => {
    try {
      const list = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      const arr = Array.isArray(list) ? list : []
      logger.info?.('[hcem-probe] 在线 agent 数: ' + arr.length)
      arr.slice(0, 3).forEach((h, i) => {
        const a = h?.agent ?? h
        const shapes = []
        if (typeof a?.followup === 'function') shapes.push('followup')
        if (typeof a?.steer === 'function') shapes.push('steer')
        if (typeof a?.inject === 'function') shapes.push('inject')
        if (typeof a?.whenIdle === 'function') shapes.push('whenIdle')
        logger.info?.(
          '[hcem-probe] agent[' + i + '] id=' + String(h?.id ?? a?.id ?? '?') + ' 可用: ' + (shapes.join(',') || '(无)'),
        )
      })
    } catch (e) {
      logger.warn?.('[hcem-probe] 失败: ' + String((e && e.message) || e))
    }
  })()

  let lastGateLog = 0

  // 语音通话：一直听 → 听到一句送进 HCEM 会话 → 回答时播报，开口即打断。
  // 按需创建（第一次用到时才建），避免没人用也占着循环。
  let voiceCall = null
  function ensureVoiceCall() {
    if (voiceCall) return voiceCall
    voiceCall = createVoiceCall({
      log: (m) => logDebug('[call] ' + m),
      isSpeaking: () => Boolean(voiceCall && voiceCall.status().speaking),
      onState: (s) => {
        logDebug('[call] state ' + JSON.stringify(s).slice(0, 200))
        try {
          writeFileSync(join(DATA_DIR, 'voice-call.json'), JSON.stringify({ ...s, ts: Date.now() }, null, 2), 'utf8')
        } catch {}
      },
      sendText: async (text) => {
        const live = ctx.agents?.list?.() ?? []
        const target = live.find((a) => presetForAgent(a) === 'hcem')
        if (!target) return { ok: false, error: '没有活着的 HCEM 会话' }
        // 不做 LLM 事后校对（实测本地小模型要么改写、要么全不改），原样送进会话
        return sendToSession(String(target.id), text, { source: { kind: 'user' } })
      },
    })
    return voiceCall
  }

  /**
   * 往指定 HCEM 会话发一条用户消息。
   * DSH 的发送接口在不同版本里形状不同，这里按可能性依次尝试。
   * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
   */
  async function sendToSession(sessionId, text, opts = {}) {
    // 依据 @deepseek-ai/dsh-agent 的公开 API：
    //   ctx.agents.get(id) -> AgentHandle（handle.agent 是 Agent）
    //   agent.followup(...) 排队下一轮 prompt 并唤醒驱动
    //
    // ⚠️ payload 必须自带 id（MessageId）。
    // `user/message` 的事件数据就是一个 UserMessage，形状是 { id, role, content, source }。
    // 少 id 时 DSH 仍会写进日志，但那条事件「没有可识别的消息」，下次加载整个会话判 corrupt：
    //   "session event at seq N lacks an identified message"
    // 实测栽过三次（seq 366 / seq 9 / seq 8），跟走 followup 还是 append 无关——是数据本身缺字段。
    const payload = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: opts.source || { kind: 'user' },
    }

    let handle = null
    try {
      handle = ctx.agents?.get?.(sessionId) ?? null
    } catch (e) {
      return { ok: false, error: '取 agent 失败: ' + String((e && e.message) || e) }
    }
    if (!handle) {
      return { ok: false, error: '没有 id 为 ' + sessionId + ' 的在线 agent（会话可能没打开）' }
    }

    const agent = handle.agent ?? handle
    const tried = []

    // 首选：followup（排队下一轮）
    // 语音通话时 agent 常常正在跑一轮，followup 会瞬时失败；
    // 先重试几次（每次 400ms），尽量别掉到 append 兜底。
    if (typeof agent.followup === 'function') {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await agent.followup(payload)
          return { ok: true, via: 'agent.followup' }
        } catch (e) {
          tried.push('followup#' + attempt + ': ' + String((e && e.message) || e))
          if (attempt < 2) await new Promise((r) => setTimeout(r, 400))
        }
      }
    }
    // 次选：steer（下一步输入）
    if (typeof agent.steer === 'function') {
      try {
        await agent.steer(payload)
        return { ok: true, via: 'agent.steer' }
      } catch (e) {
        tried.push('steer: ' + String((e && e.message) || e))
      }
    }
    // 兜底：直接往 session 日志里 append 一条 user/message。
    // 复用同一个 payload（含 id）——形状不一致正是会话损坏的来源。
    try {
      const sess = handle.session ?? ctx.sessions?.get?.(sessionId)
      if (sess && typeof sess.append === 'function') {
        sess.append('user/message', payload, { surfaceOp: 'append' })
        return { ok: true, via: 'session.append' }
      }
    } catch (e) {
      tried.push('session.append: ' + String((e && e.message) || e))
    }

    return { ok: false, error: '发送失败；试过: ' + (tried.join(' | ') || '没有任何可用接口') }
  }

  function isHcemSession(session) {
    // 测试/旧环境没有会话服务时按启用处理，避免误伤
    if (!ctx.agents || !ctx.sessionProjections) return true
    const target = session ?? currentAgent()?.session
    if (!target) {
      const now0 = Date.now()
      if (now0 - lastGateLog > 3000) {
        lastGateLog = now0
        logDebug('gate preset=<no-session> session=no agent=' + (currentAgent() ? 'yes' : 'no'))
      }
      return false
    }
    const preset = presetOf(target)
    if (preset === undefined) {
      const headerPreset = target.header?.agentPreset
      const now = Date.now()
      if (now - lastGateLog > 3000) {
        lastGateLog = now
        logDebug(`gate preset=<projection-missing> header=${String(headerPreset)}`)
      }
      return headerPreset === 'hcem'
    }
    const now = Date.now()
    if (now - lastGateLog > 3000) {
      lastGateLog = now
      logDebug(`gate preset=${String(preset)}`)
    }
    return preset === 'hcem'
  }

  /** 工具会话门禁：只有 HCEM 模式的会话才能调用 */
  function gateTool(fn) {
    return async (...args) => {
      if (!isHcemSession(currentAgent()?.session)) {
        throw new Error('非 HCEM 会话，禁止调用此工具')
      }
      return fn(...args)
    }
  }
  const DEFAULT_STATE = { H: baseline.H, S: baseline.S, L: baseline.L }
  let state = createEmotion(DEFAULT_STATE)
  if (store) {
    const saved = store.getEmotion('global')
    if (saved) {
      state = createEmotion({ H: saved.H, S: saved.S, L: saved.L })
    } else {
      store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
    }
  }

  // 1) 痛苦安全阀提示（优先级最高：order 最小，排在角色卡之前）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.safety',
        order: 85,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          return loadSettings(SETTINGS_PATH).enabled ? safetyPrompt(safetyState) : ''
        },
      }),
    'hcem.safety',
  )

  // 0) 冷存储回忆（只在刚醒来时非空）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.recall',
        order: 86,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          return loadSettings(SETTINGS_PATH).enabled ? recallText : ''
        },
      }),
    'hcem.recall',
  )

  // 3) 感知注入：把「刚看到/听到的」写进提示词（只描述，不上传任何原始素材）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.perception',
        order: 88,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          if (!loadSettings(SETTINGS_PATH).enabled) return ''
          const now = Date.now()
          const bits = []
          // 只注入「最近两分钟」的感知；旧描述不再每轮复读
          if (lastScreenDesc && now - lastScreenAt < PERCEPTION_STALE_MS) {
            bits.push('画面：' + String(lastScreenDesc).slice(0, 200))
          }
          if (lastAudioKind && now - lastAudioAt < PERCEPTION_STALE_MS) {
            const a = String(lastAudioKind)
            const t = lastAudioText ? '（' + String(lastAudioText).slice(0, 80) + '）' : ''
            bits.push('声音：' + a + t)
          }
          if (bits.length === 0) return ''
          return (
            '我看到/听到：' +
            bits.join('；') +
            '。这些都是我亲眼所见、亲耳所闻，自然地回应，不要提及"截图""监听""识别"这些词。'
          )
        },
      }),
    'hcem.perception',
  )

  // 工具选择引导：只需一句话划清边界。
  // 每个工具「什么时候用」已经写在它自己的 description 里（随 tools 下发），
  // 这里再逐条复述一遍等于每轮白烧几百 token。
  ctx.systemPrompt.section({
    name: 'hcem.toolGuide',
    order: 89,
    text: (context) => {
      if (!isHcemSession(context?.agent?.session)) return ''
      if (!loadSettings(SETTINGS_PATH).enabled) return ''
      return (
        '[HCEM] 感知/记忆/人格/人物/工作 → hcem_*。读写文件、搜索 → DSH 原生工具（read/grep/edit 等）。\n' +
        '跑命令：**优先 hcem_sh**（中文不乱码、不受沙箱限制），它报错或不可用时再退回 DSH 的 pwsh。' +
        '[HCEM 存哪里] 关系/人物事实 → hcem_people；用户本人的长期画像 → hcem_profile(target=user)；' +
        '一次性对话事件 → hcem_memory（系统自动抽取，我只调重要度）；我自己的念头 → hcem_journal；' +
        '用户交代要办的事 → hcem_work。\n' +
        '[HCEM Commis] 我的工具排序由「热菜助理 Commis」负责（默认关，菜单设置里开）。开了它只影响先排队哪个工具，不影响我能不能用。' +
        '[HCEM 按需] 视觉/听觉/语音输出默认关着，需要时请告诉用户去菜单开：视觉→hcem_vision、听觉→hcem_listen、语音输出→hcem_voice。\n' +
        '[HCEM 作息] 用户不说话时我会走神：空闲约 9 分钟后开始做梦（梦会作为当天日记写进日记本，评分高的整场记录、中断的半场也记），' +
        '空闲约 30 分钟后休眠（本地模型全部关闭），用户一说话就醒。所以日记里可能有我没主动写过的「梦」——那是我自己做的梦，不是别人写的。'
      )
    },
  })

  // 1) 搭话档位（安静/好奇/话痨）+ 主动问话能力
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.talk',
        order: 95,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          return loadSettings(SETTINGS_PATH).enabled
            ? talkativenessPrompt(loadSettings(SETTINGS_PATH), state.L)
            : ''
        },
      }),
    'hcem.talk',
  )

  let meRegenerating = false

  // 1a) 角色卡 / 用户卡（每次组装时读文件，改完即时生效）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.persona',
        order: 90,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          return loadSettings(SETTINGS_PATH).enabled
            ? personaPrompt({ persona: loadPersona(), userCard: loadUserCard() })
            : ''
        },
      }),
    'hcem.persona',
  )

  // 1z) me：persona 的固定第一人称摘要（最前，order 更小）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.me',
        order: 80,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          if (!loadSettings(SETTINGS_PATH).enabled) return ''
          const me = loadMe(DATA_DIR)
          if (!me?.text) {
            // me 不存在 → 后台生成（不阻塞本轮）
            if (!meRegenerating) {
              meRegenerating = true
              ensureMe({ dataDir: DATA_DIR, personaText: loadPersona(), logger })
                .catch(() => {})
                .finally(() => {
                  meRegenerating = false
                })
            }
            return ''
          }
          // persona 变了 → 后台重生成 me（本轮仍用旧 me，避免阻塞）
          try {
            if (me.hash && me.hash !== personaHash(loadPersona()) && !meRegenerating) {
              meRegenerating = true
              ensureMe({ dataDir: DATA_DIR, personaText: loadPersona(), logger })
                .catch(() => {})
                .finally(() => {
                  meRegenerating = false
                })
            }
          } catch {}
          return `我是 —\n${me.text}`
        },
      }),
    'hcem.me',
  )

  // 1ab) 情绪（HSL）注入：只给「状态」，不下「你现在很开心」这种命令。
  // 目的是让文字语气和搭话频率 / TTS 音色 / UI 颜色指向同一个 state，
  // 避免出现「L=30 该安静却长篇大论」这种跨通道不一致。
  // 注意 HCEM 的 H=0° 对应 HSV 的 60°（黄），所以先 +60 再分 12 段。
  const HSV_HUES = ['红', '橙', '黄', '黄绿', '绿', '青绿', '青', '蓝青', '蓝', '紫', '品红', '粉']
  const SAT_WORDS = ['很淡', '淡', '适中', '浓', '很浓']
  const LIG_WORDS = ['沉', '偏暗', '平', '偏亮', '亮']
  const hueName = (h) => HSV_HUES[Math.round((((Number(h) || 0) + 60) % 360) / 30) % 12]
  const satName = (s) => SAT_WORDS[Math.min(4, Math.floor((Number(s) || 0) / 20))]
  const ligName = (l) => LIG_WORDS[Math.min(4, Math.floor((Number(l) || 0) / 20))]

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.hsl',
        order: 82,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          if (!loadSettings(SETTINGS_PATH).enabled) return ''
          try {
            const e = (store && store.getEmotion('global')) || state
            const h = Number(e?.H ?? 0)
            const s = Number(e?.S ?? 0)
            const l = Number(e?.L ?? 55)
            return `[HCEM 情绪] 我现在的状态：${hueName(h)}、${satName(s)}、${ligName(l)}（H=${h}° S=${s}% L=${l}%）。说话节奏和语气跟着这个走，但不要把这些数字或颜色词直接说出来。`
          } catch {
            return ''
          }
        },
      }),
    'hcem.hsl',
  )

  // 1aa) 本地时钟（与设备系统时钟对齐）
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem.clock',
        order: 85,
        text: (context) => {
          if (!isHcemSession(context?.agent?.session)) return ''
          try {
            const c = clockSnapshot()
            return `现在是 ${c.local}（${c.tz}，${c.greeting}）`
          } catch {
            return ''
          }
        },
      }),
    'hcem.clock',
  )

  // 1b) 动态注入 system prompt（含最近检索到的记忆）
  let recalledMemories = []
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'hcem',
        order: 100,
        text: (context) => {
          // 只对 HCEM 模式会话生效：标准/创造会话不注入任何 HCEM 内容
          if (!isHcemSession(context?.agent?.session)) return ''
          if (!loadSettings(SETTINGS_PATH).enabled) {
            // 总开关关闭：AI 只回复「未打开」，不读记忆、不使用情绪数据
            return '[HCEM] 插件已关闭。请直接回复用户一句话：「HCEM 插件未打开」，不要调用任何工具，不要使用任何记忆或情绪数据。'
          }
          // 情绪只由 hcem.hsl 那一段输出（颜色词 + 语义），这里不再重复给一遍数字，省 50~80 token/轮
          const parts = []
          if (recalledMemories.length > 0) {
            // MD（记忆失真）：模糊记忆加标记 + 软标签提示（不模板化）
            // 注入预算：单条 240 字、整块 900 字；超了从分数最低的开始丢，并写明还剩几条
            const block = budgetList(recalledMemories, {
              total: 900,
              perItem: 240,
              header: '我想起：',
              format: (m) => {
                const md = Number(m.md ?? 0)
                if (md < 0.3) return displayText(m)
                const label = md < 0.6 ? '好像/大概' : md < 0.85 ? '记不太清' : '记不清了'
                return `${displayText(m)} [模糊 MD=${md.toFixed(2)}，可用「${label}」这类自然说法带过]`
              },
            })
            if (block.text) parts.push(block.text)
            if (block.trimmed.length || block.dropped) {
              logDebug(`memory inject budget: kept=${block.kept} dropped=${block.dropped} chars=${block.chars} trimmed=${block.trimmed.join(',')}`)
            }
          }
          // 因果链提示：记忆不完整时允许联想补充，但保持谨慎
          if (recalledMemories.some((m) => m.cause || m.effect)) {
            parts.push('[HCEM 因果链] 这段记忆里含因果环节；若链条不完整（缺前因/后果），可以用联想补充，但不要说得太确定，语气可以更谨慎。')
          }
          // 「记忆调取」提示已并入气泡调度器（hcem.bubble）：
          // 它现在自己会开口，不再需要靠 activation.json 在下一轮里塞暗示。

          // 评论机会（视听分析后，L 档位允许 → 可以说一句；也可以不说）
          try {
            const oppPath = join(DATA_DIR, 'comment-opportunity.json')
            const opp = JSON.parse(readFileSync(oppPath, 'utf8'))
            if (opp && Date.now() - Number(opp.ts ?? 0) < 60000) {
              let memHint = ''
              try {
                const pick = randomRecall(store, ['life', 'knowledge'])
                if (pick) memHint = `（想起：${String(pick.summary || pick.text).slice(0, 60)}）`
              } catch {}
              parts.push(
                `[HCEM 视听] 刚才看了一段画面（${opp.reason}），你现在「${opp.tier}」状态，可以说一句不超过 ${opp.maxChars} 字的评论；也可以不说（除非用户问）。${memHint}`,
              )
              rmSync(oppPath, { force: true })
            }
          } catch {}

          // 视觉指引：只在对应开关开着时才提，否则工具已被 mask，提了就是自相矛盾
          try {
            const mods = readMods()
            if (mods?.desktop?.enabled === true) {
              parts.push(
                '[HCEM 视觉] 当用户让你看屏幕、问「你看到什么」时，调用 hcem_vision(kind=screen) 截图查看；监听状态用 hcem_vision(kind=status) 查询。',
              )
            }
            if (mods?.video?.enabled === true) {
              parts.push('[HCEM 视频] 用户让你分析视频文件时，调用 hcem_vision(kind=video, videoPath=路径)；如果视频正在网页/播放器里播放、没有文件路径，调用 hcem_vision(kind=video) 直接看视频窗口，不要用 kind=screen 看桌面。要听台词/音乐/音效时调用 hcem_listen(mode=voice, seconds=5)。')
            }
          } catch {}
          // 工具目录：常驻只给常用的几个，其余按需检索注入
          try {
            if (catalogOn()) {
              parts.push(
                '[HCEM 工具] 我手边只放常用工具。要跑命令、写文件、上网、定时、后台任务、切目录这类能力时，' +
                  '先调用 hcem_tools(query=我想做什么)，它会把合适的工具装给我，下一步就能用。',
              )
            }
            // 沙箱限制：只读会话里写文件会被拒、pwsh 在 ConstrainedLanguage，提前说清楚省得它一条条试
            const sm = sandboxModeOf(session)
            if (sm === 'read-only') {
              parts.push(
                '[HCEM 沙箱] 当前会话是只读沙箱：改/写文件会被拒绝；pwsh 跑在 ConstrainedLanguage，' +
                  '.NET 静态调用（含 DSH 自己每句拼接的 OutputEncoding）会报错、CIM/Get-Volume 多半 PermissionDenied，' +
                  '中文输出还可能乱码（尽量让命令只输出 ASCII）。需要真正放开时，让用户把会话沙箱切到 workspace-write。',
              )
            }
          } catch {}
          // 工作记忆：指引 + 75% 提醒
          // 只在「工作笔记」这个模块真的开着时才提，否则工具被 mask 了，
          // 提示词还在教 AI 调它 —— 就是挂空引用（HCEM 会找不到 hcem_work）。
          try {
            parts.push(
              '[HCEM 工作记忆] 用户交代需要记住的工作时，先回复「我这就把这些事记入我的工作笔记里」，再调用 hcem_work(action=write) 记录。用户明确要求记录的内容一律走工作笔记，不要写进日记。',
            )
          } catch {}
          try {
            const usage = workUsage()
            if (usage.ratio >= 0.75) {
              parts.push('[HCEM 工作记忆] 我的工作笔记快满了，需要删掉不重要工作内容了。')
            }
          } catch {}
          // 记忆复审：即将到期（3 天内）的生活/知识区记忆，给 AI 一个 pin 的机会
          try {
            if (store) {
              const nowTs = Date.now()
              const expiring = store
                .listMemories({ limit: 300 })
                .filter((m) => {
                  if (!['life', 'knowledge'].includes(m.zone)) return false
                  const maxAgeH = m.zone === 'life' ? 2160 : 2880
                  const last = Math.max(
                    Date.parse(m.last_accessed_at || 0) || 0,
                    Date.parse(m.updated_at || 0) || 0,
                    Date.parse(m.created_at || 0) || 0,
                  )
                  const remainH = maxAgeH - (nowTs - last) / 3600000
                  return remainH > 0 && remainH < 72
                })
              if (expiring.length > 0) {
                parts.push(
                  `[HCEM 记忆复审] 有 ${expiring.length} 条记忆即将到期：\n` +
                    expiring
                      .slice(0, 8)
                      .map((m) => `- ${displayText(m)}（id=${m.id}）`)
                      .join('\n') +
                    '\n如果你觉得它们值得留下，调用 hcem_memory（本会话最多 2 次）；否则它们会被遗忘。',
                )
              }
            }
          } catch {}
          return parts.join('\n\n')
        },
      }),
    'hcem.prompt',
  )

  // 2) 情绪语义分析器（embedding；先确保 8081 服务在跑，再初始化，失败回退词表）
  let analyzer = null
  // ── 显存错峰队列 + 视听时间窗融合 ──
  //   错峰：占显存的模型调用排队执行，避免视觉和听觉同时抢显存
  //   融合：同一时间窗内的画面和声音合并成一条记忆，两边内容都不丢
  const gpuQueue = createGpuQueue({ maxConcurrent: 1, logger })

  // 融合后统一写记忆：
  //   both   → 视觉区写一条（描述里带声音），听觉区写一条（只记声音部分，带画面引用）
  //   vision → 视觉区
  //   audio  → 听觉区
  const fusion = createFusion({
    windowMs: 8000,
    logger,
    onMerged: (m) => {
      if (!store) return
      // 异步整理（不阻塞融合器的 flush）
      ;(async () => {
      try {
        const alpha = (() => {
          try {
            return store.getEmotion('global')
          } catch {
            return null
          }
        })() || { H: 360, S: 15 }

        // ── 1.5：交给 OmniDimen 把视听信息整理成一句自然描述 ──
        // 简单场景直接拼接（不调模型），复杂场景才走模型；模型不可用会自动退回拼接
        const summary = await summarizePerception({
          visionText: m.visionText || '',
          audioText: m.audioText || '',
          face: (m.meta && m.meta.face) || null,
          music: (m.meta && m.meta.music) || null,
          fp: (m.meta && m.meta.fp) || '',
          categoryName: (m.meta && m.meta.categoryName) || '',
          L: Number(alpha.L ?? 55),
          S: Number(alpha.S ?? 15),
        })
        // 整理后的文本写记忆；整理失败就用原始拼接（不丢信息）
        const mergedText = (summary && summary.text) || ((m.visionText || '') + (m.audioText ? '｜听到：' + m.audioText : ''))
        m._summarized = mergedText
        m._usedModel = Boolean(summary && summary.usedModel)

        // 给视听记忆算向量：以前这两个写入器完全不写 embedding，
        // 结果视觉/听觉区一条向量都没有（实测 47 条 video_observe 全空），语义检索查不到它们。
        const embedFn = analyzer && typeof analyzer.embed === 'function'
          ? (texts) => analyzer.embed(texts)
          : null

        if (m.kind === 'both') {
          // 视觉区：画面 + 声音一起记（这是「同一件事」）
          const vr = await putVideoMemory({
            store,
            description: mergedText,
            image: (m.meta && m.meta.image) || null,
            dataDir: DATA_DIR,
            screen: Number(m.meta && m.meta.screen) || 0,
            diff: Number(m.meta && m.meta.diff) || 0,
            priority: (m.meta && m.meta.priority) || 'mid',
            modelScore: m.meta && m.meta.modelScore != null ? m.meta.modelScore : null,
            type: m.meta && m.meta.isVideo ? 'episode' : 'short',
            alpha: { H: alpha.H, S: alpha.S },
            embed: embedFn,
            timeStart: m.timeStart || null,
            timeEnd: m.timeEnd || null,
          })
          if (m.meta && m.meta.isVideo && vr?.ok) touchMediaNote(vr.id, mergedText)
          // 听觉区：声音单独也留一条，方便按声音检索
          await putAudioMemory({
            store,
            tick: {
              ok: true,
              text: mergedText,
              kind: (m.meta && m.meta.audioKind) || 'scene',
              category: (m.meta && m.meta.category) || '',
              categoryName: (m.meta && m.meta.categoryName) || '',
              soundDesc: (m.meta && m.meta.soundDesc) || '',
              emotion: (m.meta && m.meta.emotion) || '',
              emotionScore: (m.meta && m.meta.emotionScore) || 0,
              tags: (m.meta && m.meta.tags) || [],
              music: (m.meta && m.meta.music) || null,
              musicInfo: (m.meta && m.meta.musicInfo) || null,
              fp: (m.meta && m.meta.fp) || '',
              asrSegments: (m.meta && m.meta.asrSegments) || [],
              wav: (m.meta && m.meta.wav) || null,
            },
            alpha: { H: alpha.H, S: alpha.S },
            dataDir: DATA_DIR,
            embed: embedFn,
            timeStart: m.timeStart || null,
            timeEnd: m.timeEnd || null,
          })
        } else if (m.kind === 'vision') {
          const vr = await putVideoMemory({
            store,
            description: mergedText,
            image: (m.meta && m.meta.image) || null,
            dataDir: DATA_DIR,
            screen: Number(m.meta && m.meta.screen) || 0,
            diff: Number(m.meta && m.meta.diff) || 0,
            priority: (m.meta && m.meta.priority) || 'mid',
            modelScore: m.meta && m.meta.modelScore != null ? m.meta.modelScore : null,
            type: m.meta && m.meta.isVideo ? 'episode' : 'short',
            alpha: { H: alpha.H, S: alpha.S },
            embed: embedFn,
            timeStart: m.timeStart || null,
            timeEnd: m.timeEnd || null,
          })
          if (m.meta && m.meta.isVideo && vr?.ok) touchMediaNote(vr.id, mergedText)
        } else if (m.kind === 'audio') {
          await putAudioMemory({
            store,
            tick: {
              ok: true,
              text: mergedText,
              kind: (m.meta && m.meta.audioKind) || 'scene',
              category: (m.meta && m.meta.category) || '',
              categoryName: (m.meta && m.meta.categoryName) || '',
              soundDesc: (m.meta && m.meta.soundDesc) || '',
              emotion: (m.meta && m.meta.emotion) || '',
              emotionScore: (m.meta && m.meta.emotionScore) || 0,
              tags: (m.meta && m.meta.tags) || [],
              music: (m.meta && m.meta.music) || null,
              musicInfo: (m.meta && m.meta.musicInfo) || null,
              fp: (m.meta && m.meta.fp) || '',
              asrSegments: (m.meta && m.meta.asrSegments) || [],
              wav: (m.meta && m.meta.wav) || null,
            },
            alpha: { H: alpha.H, S: alpha.S },
            dataDir: DATA_DIR,
            embed: embedFn,
            timeStart: m.timeStart || null,
            timeEnd: m.timeEnd || null,
          })
        }
      } catch (e) {
        logger.warn?.('[融合] 写记忆失败: ' + String((e && e.message) || e))
      }
      })()
    },
  })
  fusion.start()

  // 给 llm-bridge 一个写文件的日志回调（logger.info 走 DSH 的日志，看不到）
  globalThis.__hcemBridgeLog = (m) => {
    try {
      log('INFO', 'llm-bridge', m)
    } catch {}
  }

  // 悬浮球：DSH 启动后延迟拉起 HCEM.exe（如果没在跑）
  // 注意：延迟 3 秒，避开 DSH 自己的窗口初始化（以前同启动会抢窗口资源）
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const exe = `${globalThis.__HCEM_HOME__}/HCEM.exe`
        if (!fs.existsSync(exe)) {
          logger.warn?.('[hcem] HCEM.exe 不存在，跳过拉起')
          return
        }
        // 已在跑就不重复启动（通过 lock 文件判断）
        const lock = `${globalThis.__HCEM_HOME__}/data/.pipe-server.lock`
        if (fs.existsSync(lock)) {
          const pid = Number(fs.readFileSync(lock, 'utf8').trim())
          if (pid) {
            try {
              process.kill(pid, 0)
              logger.info?.('[hcem] HCEM.exe 已在运行 (pipe pid ' + pid + ')，跳过拉起')
              return
            } catch {}
          }
        }
        const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        logger.info?.('[hcem] 已拉起 HCEM.exe (pid ' + child.pid + ')')
      } catch (e) {
        logger.warn?.('[hcem] 拉起 HCEM.exe 失败: ' + String((e && e.message) || e))
      }
    }, 3000)
    // 清理：DSH 退出时把 HCEM.exe 和所有模型进程一起收掉
    return () => {
      clearTimeout(timer)
      try {
        log('INFO', 'launcher', 'DSH 关闭，清理 HCEM.exe 和模型进程')
        // 1) 同步杀掉所有 llama-server（异步可能来不及）
        try {
          execSync('taskkill /IM llama-server.exe /F', { timeout: 5000, stdio: 'ignore' })
          log('INFO', 'services', '已清理全部 llama-server')
        } catch {}
        // 2) 杀 HCEM.exe（连带它的 pipe-server 子进程）
        try {
          execSync('taskkill /IM HCEM.exe /F', { timeout: 4000, stdio: 'ignore' })
          log('INFO', 'launcher', '已清理 HCEM.exe')
        } catch {}
        // 3) 清 lock

        try {
          try { fs.rmSync(join(String(globalThis.__HCEM_DATA__ || '.'), '.pipe-server.lock'), { force: true }) } catch {}
        } catch {}
      } catch {}
    }
  }, 'hcem.launcher')
  log('INFO', 'boot', 'checkpoint-B-launcher')

  // 语音事件通道（事件驱动，不再轮询文件）：
  // HCEM.exe 识别完直接 POST 到 127.0.0.1:8097/voice，这里送进最近的 HCEM 会话。
  // 只监听回环地址；端口可用 HCEM_VOICE_PORT 覆盖。
  ctx.effect(() => {
    const port = Number(process.env.HCEM_VOICE_PORT || 8097)
    // 浏览器里的 Client 插件要从 DSH 页面（另一个端口）跨源调用，必须放行 CORS。
    // 只监听回环地址，所以 Allow-Origin 用 * 也不会外泄。
    const CORS = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    }
    const server = createServer((req, res) => {
      const path = String(req.url || '').split('?')[0]
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS)
        res.end()
        return
      }
      const ALLOWED = new Set(['/voice', '/call', '/mods', '/mods/stop', '/bubble'])
      if (req.method !== 'POST' || !ALLOWED.has(path)) {
        res.writeHead(404, CORS)
        res.end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 64 * 1024) req.destroy()
      })
      req.on('end', async () => {
        const reply = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json', ...CORS })
            res.end(JSON.stringify(obj))
          } catch {}
        }
        try {
          const payload = JSON.parse(body || '{}')
          // 模型生命周期端点：pipe-server（HCEM.exe 的子进程）把 set_mods 转发到这里。
          //
          // 为什么不让 pipe-server 自己管：它随 HCEM.exe 常驻，改了插件代码它不会重新加载，
          // 会出现「DSH 里是新代码、pipe-server 里是旧代码」双份逻辑打架（实测踩过）。
          // 现在模型只由插件管，pipe-server 只负责转发。
          // 主动说话（气泡）：Client 插件用它读档位、写档位、上报「DSH 是否在前台」
          if (path === '/bubble') {
            // 上报聚焦状态（client 每次 focus/blur/visibilitychange 都会发）
            if (typeof payload?.focused === 'boolean') dshFocused = payload.focused
            // 写档位（0 话痨 / 1 好奇 / 2 安静）——与 exe 菜单角色卡页共享同一个字段
            if (payload?.talk !== undefined && payload?.talk !== null) {
              const wanted = Math.min(2, Math.max(0, Math.round(Number(payload.talk))))
              if (Number.isFinite(wanted)) {
                const s = loadSettings(SETTINGS_PATH)
                if (Number(s.talkativeness) !== wanted) {
                  s.talkativeness = wanted
                  saveSettings(SETTINGS_PATH, s)
                  log('INFO', 'bubble', '档位改为 ' + ['话痨', '好奇', '安静'][wanted] + '（来自 DSH 状态栏）')
                  try {
                    bubble?.poke('talk-changed')
                  } catch {}
                  // exe 菜单那边靠轮询 /bubble 拿档位（同一条路由），这里不用额外推送
                }
              }
            }
            // 写「DSH 后台不搭话」开关
            if (typeof payload?.requireFocus === 'boolean') {
              const s = loadSettings(SETTINGS_PATH)
              if (s.bubbleRequireFocus !== payload.requireFocus) {
                s.bubbleRequireFocus = payload.requireFocus
                saveSettings(SETTINGS_PATH, s)
                log('INFO', 'bubble', 'DSH 后台不搭话 = ' + payload.requireFocus)
              }
            }
            let st = null
            try {
              st = bubble?.status?.() ?? null
            } catch {}
            const cur = loadSettings(SETTINGS_PATH)
            // Client 靠 isHcem 决定显不显示这个按钮（和语音通话一致：只对 HCEM 会话）
            let isHcem = null
            const sid = String(payload?.sessionId || '')
            if (sid) {
              try {
                const agent = ctx.agents?.get?.(sid)
                isHcem = Boolean(agent) && presetForAgent(agent) === 'hcem'
              } catch {
                isHcem = false
              }
            }
            reply(200, {
              ok: true,
              talk: Number(cur.talkativeness ?? 0),
              requireFocus: cur.bubbleRequireFocus !== false,
              focused: dshFocused,
              isHcem,
              status: st,
            })
            return
          }
          if (path === '/classifier') {
            // 只读：菜单打开时用来对齐开关状态
            let cur = { enabled: false, alpha: 0.3 }
            try {
              cur = JSON.parse(fs.readFileSync(join(DATA_DIR, 'ui-state', 'classifier.json'), 'utf8'))
            } catch {}
            reply(200, { ok: true, enabled: cur.enabled === true, alpha: Number(cur.alpha) || 0.3 })
            return
          }
          if (path === '/mods') {
            // 不带 mods（或 mods 为空对象）= 只读当前开关。
            // 菜单重新打开时用它对齐真实状态（显存让位可能已经把某些开关关掉了）。
            const hasMods = payload?.mods && typeof payload.mods === 'object' && Object.keys(payload.mods).length > 0
            if (!hasMods && !payload?.force) {
              let cur = null
              try {
                cur = JSON.parse(fs.readFileSync(join(DATA_DIR, 'ui-state', 'mods.json'), 'utf8'))
              } catch {}
              reply(200, { ok: true, mods: cur })
              return
            }
            const { syncServicesWithMods } = await import('./lib/services.mjs')
            const mods = payload?.mods && typeof payload.mods === 'object' ? payload.mods : payload
            const force = payload?.force === true
            const lg = {
              info: (m) => log('INFO', 'services', m),
              warn: (m) => log('WARN', 'services', m),
              error: (m) => log('ERROR', 'services', m),
            }
            const r = syncServicesWithMods(mods, lg, { force })
            log('INFO', 'services', 'HTTP /mods force=' + force + ' → ' + JSON.stringify(r))
            reply(200, { ok: true, result: r })
            return
          }
          if (path === '/mods/stop') {
            // TTS 常驻服务也要一起停：不然 exe 关了它还在后台占显存
            try {
              const { stopServer } = await import('./lib/tts/server.mjs')
              stopServer('全部模型关闭')
            } catch {}
            const { stopAllServices } = await import('./lib/services.mjs')
            stopAllServices({
              info: (m) => log('INFO', 'services', m),
              warn: (m) => log('WARN', 'services', m),
            })
            log('INFO', 'services', 'HTTP /mods/stop → 已关闭全部模型（' + String(payload?.why || '') + '）')
            reply(200, { ok: true })
            return
          }
          // 通话控制：Client 插件 / HCEM.exe 通过这个端点开始、结束、查询通话
          if (path === '/call') {
            const action = String(payload?.action || '').trim()
            if (action === 'status') {
              const s = voiceCall ? voiceCall.status() : { active: false }
              // Client 靠 isHcem 决定要不要显示电话图标：语音只往 HCEM 会话送
              const sid = String(payload?.sessionId || '')
              let isHcem = null
              if (sid) {
                try {
                  const agent = ctx.agents?.get?.(sid)
                  isHcem = Boolean(agent) && presetForAgent(agent) === 'hcem'
                } catch {
                  isHcem = false
                }
              }
              reply(200, { ok: true, phase: 'idle', isHcem, ...s })
              return
            }
            if (action === 'start') {
              const r = ensureVoiceCall().start()
              reply(200, { ok: r.ok !== false, already: Boolean(r.already) })
              return
            }
            if (action === 'stop') {
              if (voiceCall) await voiceCall.stop()
              reply(200, { ok: true })
              return
            }
            reply(400, { ok: false, error: 'unknown action' })
            return
          }
          const text = String(payload?.text || '').trim()
          if (!text) {
            reply(400, { ok: false, error: 'empty' })
            return
          }
          const live = ctx.agents?.list?.() ?? []
          const target = live.find((a) => presetForAgent(a) === 'hcem')
          if (!target) {
            logDebug('voice event dropped: no live HCEM session')
            reply(503, { ok: false, error: 'no-session' })
            return
          }
          // 说话人 + 语气 → 拼进送进会话的文本，让 AI 知道「谁在说、什么语气」
          const bits = []
          if (payload?.speaker?.label) {
            const score = Number(payload.speaker.score || 0).toFixed(2)
            bits.push(
              payload.speaker.who === 'unknown'
                ? `我没有认出这个声音（最像 ${score}）`
                : `说话人：${payload.speaker.label}（相似度 ${score}）`,
            )
          }
          if (payload?.emotion?.label) bits.push(`语气：${payload.emotion.label}`)
          const full = bits.length ? `【语音输入】${bits.join('；')}\n${text}` : text

          const r = await sendToSession(String(target.id), full)
          logDebug('voice event -> ' + JSON.stringify(r))
          reply(r.ok ? 200 : 500, r)
        } catch (error) {
          logDebug('voice event failed: ' + String((error && error.message) || error))
          reply(500, { ok: false })
        }
      })
    })
    server.on('error', (error) => {
      log('ERROR', 'voice', '事件通道启动失败: ' + String((error && error.message) || error))
    })
    server.listen(port, '127.0.0.1', () => {
      log('INFO', 'voice', `语音事件通道已监听 127.0.0.1:${port}`)
    })
    return () => {
      try {
        server.close()
      } catch {}
    }
  }, 'hcem.voice.server')


  // 桌面监视的「保底描述」：captureManager 只在帧差 > 0 时触发 onChange，
  // 画面静止（比如一直看同一个窗口）时 AI 永远拿不到画面描述。
  // 这里在启动 3 秒后强制描述一次，之后每 60 秒刷新一次。
  ctx.effect(() => {
    const timers = []
    let stopped = false
    const forceDescribe = async () => {
      if (stopped) return
      try {
        if (readMods()?.desktop?.enabled !== true) return
        // 统一用 Qwen2.5-VL（describeScreen 内部自己截图 + 调 8091）
        const r = await describeScreen({ maxWidth: 1280, dataDir: DATA_DIR })
        const text = String(r?.text || '').trim()
        if (text) {
          lastScreenDesc = text
          lastScreenAt = Date.now()
          logDebug('force describe ok: ' + text.slice(0, 100))
        } else if (r?.error) {
          logDebug('force describe empty: ' + String(r.error).slice(0, 120))
        }
        try {
          if (r?.image) rmSync(r.image, { force: true })
        } catch {}
      } catch (error) {
        logDebug('force describe failed: ' + String((error && error.message) || error))
      }
    }
    timers.push(setTimeout(forceDescribe, 3000))
    timers.push(setInterval(forceDescribe, 60000))
    return () => {
      stopped = true
      for (const t of timers) clearTimeout(t)
    }
  }, 'hcem.desktop.forceDescribe')

  // 存储管家：启动后 30 秒 + 每小时清理临时音频/图片（记忆资产不碰）
  ctx.effect(() => {
    const stop = startStorageGuard(DATA_DIR, { logger, store })
    return () => stop()
  }, 'hcem.storage')
  log('INFO', 'boot', 'checkpoint-C-storage')

  // 插件运行心跳：设置页据此显示「插件运行中/未运行」
  ctx.effect(() => {
    const beat = () => {
      try {
        if (!loadSettings(SETTINGS_PATH).enabled) return
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'plugin-heartbeat.json'), JSON.stringify({ ts: Date.now(), pid: process.pid }), 'utf8')
      } catch {}
    }
    beat()
    const timer = setInterval(beat, 15000)
    return () => clearInterval(timer)
  }, 'hcem.heartbeat')
  log('INFO', 'boot', 'checkpoint-D-heartbeat')

  // 实时情绪 → exe（悬浮球颜色 + 菜单 HSL 读数）
  //
  // 之前只有 UI 自己 set_hsl 时才会推一次（那是「性格基准」），插件从不推真实情绪，
  // 所以菜单里的 HSL 读数、悬浮球颜色都停在启动值，不会跟着情绪走。
  // 跨进程用文件传递：插件写 data/hsl-live.json，pipe-server 轮询后推 STATE。
  ctx.effect(() => {
    const flush = () => {
      try {
        const e = (store && store.getEmotion('global')) || state
        if (!e) return
        // 每次都写（带新 ts）：pipe-server 靠内容变化判断要不要推 STATE。
        // 只在数值变化时写的话，菜单后开就永远拿不到当前值（实测读数不动）。
        writeFileSync(
          join(DATA_DIR, 'hsl-live.json'),
          JSON.stringify({ h: Number(e.H) || 0, s: Number(e.S) || 0, l: Number(e.L) || 0, ts: Date.now() }),
          'utf8',
        )
      } catch {}
    }
    flush()
    const timer = setInterval(flush, 5000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }, 'hcem.hsl.live')

  // 供看门狗判断「是否处于休眠」。idle 实例在下面的 effect 里创建，作用域不互通，
  // 所以留一个引用出来。
  let idleRef = null

  // 模型生命看门狗（30 秒一轮），实现用户定的规则②③：
  //   ③ exe 关掉 → 全部模型收掉（不依赖 pipe 断开，pipe 也可能断在别的原因上）
  //   ② exe 回来 / embedding 掉了 → 按开关补拉
  //   休眠期间什么都不做（休眠本来就应该一个模型都不跑）
  ctx.effect(() => {
    let exeWasGone = false
    let misses = 0
    const timer = setInterval(async () => {
      try {
        if (idleRef?.getState?.().sleeping) {
          exeWasGone = false
          return
        }
        const exeOn = isExeRunning()
        if (!exeOn) {
          if (!exeWasGone) {
            exeWasGone = true
            const { stopAllServices } = await import('./lib/services.mjs')
            stopAllServices(logger)
            logger.info?.('[hcem] HCEM.exe 已关闭 → 关闭全部模型')
          }
          return
        }
        if (exeWasGone) {
          // exe 又回来了：按开关把模型拉回来
          exeWasGone = false
          try {
            const mods = JSON.parse(fs.readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`, 'utf8'))
            const { syncServicesWithMods } = await import('./lib/services.mjs')
            const r = syncServicesWithMods(mods, logger, { force: true })
            logger.info?.('[hcem] HCEM.exe 回来了 → 唤醒同步 ' + JSON.stringify(r))
          } catch {}
        }
        if (await isEmbeddingUp()) {
          misses = 0
          return
        }
        misses += 1
        logger.warn?.(`[hcem] embedding 掉线（第 ${misses} 次检查），尝试拉起`)
        startService('embedding', logger)
      } catch (e) {
        logger.warn?.('[hcem] 模型看门狗异常: ' + String((e && e.message) || e))
      }
    }, 30000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }, 'hcem.models.watchdog')

  // 启动时把「这次到底加载了哪些服务」写进日志，方便对照源码判断有没有跑旧包
  import('./lib/services.mjs')
    .then((mod) => {
      log('INFO', 'services', 'SERVICES=' + Object.keys(mod.SERVICES || {}).join(','))
    })
    .catch(() => {})

  // 模型自启统一由 services.mjs 的 syncServicesWithMods 负责（按开关决定起哪些），
  // 这里只保证常驻的 embedding 就绪。
  ensureEmbeddingService(logger)
    .then((ok) => {
      if (!ok) throw new Error('embedding service not available')
      return createEmbeddingAnalyzer(logger)
    })
    .then((a) => {
      analyzer = a
      logger.info('[hcem] embedding analyzer ready')
    })
    .catch((error) => {
      logger.warn?.(
        `[hcem] embedding analyzer unavailable, fallback to keywords: ${String((error && error.message) || error)}`,
      )
    })

  // 前世记忆区：导入 data/reincarnation/（等 analyzer 就绪，setTimeout 延迟，失败不影响插件）
  if (store) {
    setTimeout(() => {
      try {
        const r = ingestReincarnation({ dataDir: DATA_DIR, store, logger, analyzer })
        if (r.chunks > 0) logger.info?.(`[hcem] reincarnation 导入 ${r.chunks} 段（来自 ${r.files} 个文件）`)
      } catch (error) {
        logger.warn?.(`[hcem] reincarnation 导入失败: ${String((error && error.message) || error)}`)
      }
    }, 3000)
  }

  // 启动时按 mods.json 同步一次模型
  // 之前只有 set_mods 时才同步 → 重启后开关虽然开着，但没人去拉起模型
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        const mp = `${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`
        const mods = JSON.parse(fs.readFileSync(mp, 'utf8'))
        const lg = {
          info: (m) => log('INFO', 'services', m),
          warn: (m) => log('WARN', 'services', m),
          error: (m) => log('ERROR', 'services', m),
        }
        log('INFO', 'services', '启动同步：HCEM.exe=' + (isExeRunning() ? '在跑' : '没跑') + ' mods=' + JSON.stringify({
          video: mods.video?.enabled,
          audio: mods.audio?.enabled,
          desktop: mods.desktop?.enabled,
          localRoute: mods.localRoute?.enabled,
        }))
        // ③ 模型归属在 .exe：DSH 先起来、exe 还没开的时候不要自己拉起模型。
        // exe 一旦连上，pipe-server 的 onConnect 会按开关同步（force）。
        if (!isExeRunning()) {
          log('INFO', 'services', 'HCEM.exe 未运行，启动时不拉起模型')
          return
        }
        Promise.all([import('./lib/services.mjs')])
          .then(([{ syncServicesWithMods }]) => {
            const r = syncServicesWithMods(mods, lg, { force: true })
            log('INFO', 'services', '启动同步结果 ' + JSON.stringify(r))
          })
          .catch((e) => log('ERROR', 'services', '启动同步失败: ' + String((e && e.stack) || e)))
      } catch (e) {
        log('ERROR', 'services', '读 mods.json 失败: ' + String((e && e.message) || e))
      }
    }, 4000)
    return () => clearTimeout(timer)
  }, 'hcem.startupSync')

  log('INFO', 'boot', 'checkpoint-A：startupSync effect 已注册')

  // 给「第二步：把摘要讲成一段话」用的 prompt。
  // 不硬编码任何角色名——我是谁从 me 读，情绪从 HSL 读，记忆从库里随机捞一条。
  function buildCompanionPrompt({ summary, gapMs = 0 }) {
    try {
      const me = loadMe(DATA_DIR)
      const e = (store && store.getEmotion('global')) || state || { H: 360, S: 15, L: 55 }
      const h = hueName(e.H)
      const s = satName(e.S)
      const l = ligName(e.L)
      let memLine = '我暂时没有想起什么。'
      try {
        const pick = randomRecall(store, ['life', 'knowledge'])
        if (pick) memLine = `我记得：${String(pick.summary || pick.text).slice(0, 120)}`
      } catch {}
      const target = gapMs < 60000 ? 300 : gapMs < 300000 ? 500 : gapMs < 900000 ? 700 : 1000
      const who = String(me?.text || '').trim()
      return {
        system:
          `我是${who ? '——\n' + who : '我自己。'}\n` +
          `我现在的心情：${h}、${s}、${l}（H=${e.H}° S=${e.S}% L=${e.L}%）。\n` +
          `${memLine}\n` +
          '我要用第一人称把刚才看到的事讲一遍，再说说此刻的想法，像自己亲眼见到一样。\n' +
          '只讲摘要里有的内容：不许补时间、补地点、补别人的话、补后续，也不许编造「以前也这样」这类联想。',
        user:
          `我刚刚看到了：\n${String(summary || '').trim()}\n\n` +
          `用第一人称说一段不超过 ${target} 字的话（尽量接近 ${target} 字），不要提「材料」「摘要」「观察」这些词。`,
        target,
      }
    } catch {
      return { system: '', user: '', target: 500 }
    }
  }

  // 给本地分流用的精简 system：按重要性挑选，而不是把整段 system 截尾。
  // 顺序固定：me（固定人设）→ 角色卡 → 用户卡 → 安全阀 → 感知 → 搭话档位。
  // 记忆、工具引导、时钟不进本地（4096 装不下，且本地也不调工具）。
  function buildLocalSystem() {
    try {
      const parts = []
      const me = loadMe(DATA_DIR)
      if (me?.text) parts.push(`我是 —\n${me.text}`)
      const persona = String(loadPersona() || '').trim()
      if (persona) parts.push(`我是这样的——\n${persona.slice(0, 900)}`)
      const userCard = String(loadUserCard() || '').trim()
      if (userCard) parts.push(`我记得关于你的事\n${userCard.slice(0, 500)}`)
      const safety = safetyPrompt(safetyState)
      if (safety) parts.push(safety)
      if (lastScreenDesc && Date.now() - lastScreenAt < PERCEPTION_STALE_MS) {
        parts.push('我看到：' + String(lastScreenDesc).slice(0, 200))
      }
      // 和云端保持一致：本地也带一句当前情绪（只给状态，不下命令）
      try {
        const e = (store && store.getEmotion('global')) || state
        parts.push(
          `[HCEM 情绪] 我现在的状态：${hueName(e.H)}、${satName(e.S)}、${ligName(e.L)}（H=${e.H}° S=${e.S}% L=${e.L}%）。`,
        )
      } catch {}
      const s = loadSettings(SETTINGS_PATH)
      if (s.enabled) parts.push(talkativenessPrompt(s, state.L))
      // 本地分流没有工具：明确告诉它，避免它“假装调用工具”或复述工具结果
      parts.push(
        '【本地模式】你现在没有可用工具：不要输出工具名、参数或“我这就去调用”这类话；' +
          '需要工具才能完成的事，直接用一句话说明“这个我得联网/查一下”，不要硬编结果。',
      )
      return parts.filter(Boolean).join('\n\n')
    } catch {
      return ''
    }
  }

  // 分流层（S1/S2）：挂 llm/stream waterfall
  try {
    log('INFO', 'llm-bridge', '准备安装（进入 installLlmBridge 之前）')
    installLlmBridge({
      ctx,
      dataDir: DATA_DIR,
      logger,
      isEnabled: () => loadSettings(SETTINGS_PATH).enabled,
      buildLocalSystem,
      // 分流层只对 HCEM 会话生效：标准会话的对话不能再被本地模型接管
      isHcemSession: (sessionId) => {
        try {
          const agent = ctx.agents?.get?.(sessionId)
          return Boolean(agent) && presetForAgent(agent) === 'hcem'
        } catch {
          return false
        }
      },
    })
    log('INFO', 'llm-bridge', '✅ installLlmBridge 返回，安装完成')
    logger.info?.('[hcem] llm-bridge installed (语义缓存 + 本地分流)')
  } catch (error) {
    const msg = String((error && error.stack) || (error && error.message) || error)
    log('ERROR', 'llm-bridge', '❌ 安装失败: ' + msg)
    logger.warn?.(`[hcem] llm-bridge unavailable: ${String((error && error.message) || error)}`)
  }

  // B3：因果链扩展——沿命中记忆的 cause/effect 找相关环节（1 跳）
  // 返回 { memories: [...], missing: bool }（missing=链条缺环）
  function expandCausalChain(memories) {
    try {
      const base = Array.isArray(memories) ? memories : []
      if (base.length === 0) return { memories: [], missing: false }
      const all = store.listMemories({ limit: 200 })
      const causes = new Set(base.map((m) => m.cause).filter(Boolean))
      const effects = new Set(base.map((m) => m.effect).filter(Boolean))
      const extra = []
      for (const m of all) {
        if (base.some((b) => b.id === m.id)) continue
        if ((m.cause && causes.has(m.cause)) || (m.effect && effects.has(m.effect))) extra.push(m)
        if (extra.length >= 2) break
      }
      // 缺环判定：命中记忆有 cause/effect，但链条里找不到对应的「因/果」记忆（排除自身）
      let missing = false
      for (const m of base) {
        if (m.cause && !all.some((x) => x.id !== m.id && (x.effect === m.cause || x.cause === m.cause))) missing = true
        if (m.effect && !all.some((x) => x.id !== m.id && (x.cause === m.effect || x.effect === m.effect))) missing = true
      }
      return { memories: extra, missing }
    } catch {
      return { memories: [], missing: false }
    }
  }

  // 主动说话激活：已由下方的「气泡调度器」（hcem.bubble）取代。
  // 旧的固定 30 分钟定时器只会写 activation.json 当提示，从不保证 AI 真开口，
  // 还会和气泡的注入互相干扰，所以整块删掉。

  // ── 梦：本地 / 云端（配额）────────────────────────────────
  // data/ui-state/dream.json { provider: 'auto'|'local'|'cloud', dailyLimit: 3 }
  //   auto = 本地分流开着用本地；关着用云端（配额内），配额用完就不做梦
  const DREAM_CFG_PATH = join(DATA_DIR, 'ui-state', 'dream.json')
  const DREAM_QUOTA_PATH = join(DATA_DIR, 'ui-state', 'dream-quota.json')

  function dreamSettings() {
    try {
      const j = JSON.parse(readFileSync(DREAM_CFG_PATH, 'utf8'))
      return {
        provider: ['auto', 'local', 'cloud'].includes(j?.provider) ? j.provider : 'auto',
        dailyLimit: Math.max(0, Math.min(20, Number(j?.dailyLimit ?? 3))),
      }
    } catch {
      return { provider: 'auto', dailyLimit: 3 }
    }
  }

  function dreamQuota() {
    const cfg = dreamSettings()
    const today = new Date().toISOString().slice(0, 10)
    try {
      const j = JSON.parse(readFileSync(DREAM_QUOTA_PATH, 'utf8'))
      if (j?.date === today) return { date: today, used: Number(j.used) || 0, limit: cfg.dailyLimit }
    } catch {}
    return { date: today, used: 0, limit: cfg.dailyLimit }
  }

  function bumpDreamQuota() {
    const q = dreamQuota()
    try {
      writeFileSync(DREAM_QUOTA_PATH, JSON.stringify({ date: q.date, used: q.used + 1, limit: q.limit }, null, 2), 'utf8')
    } catch {}
  }

  function cloudDreamAvailable() {
    if (!ctx.get?.('llm')) return false
    const q = dreamQuota()
    return q.limit > 0 && q.used < q.limit
  }

  /** 这场梦走哪条路：local / cloud / skip */
  function dreamProvider() {
    const cfg = dreamSettings()
    const mods = (() => {
      try {
        return JSON.parse(readFileSync(join(DATA_DIR, 'ui-state', 'mods.json'), 'utf8'))
      } catch {
        return {}
      }
    })()
    const localOn = mods?.localRoute?.enabled === true || mods?.['local-route'] === true
    if (cfg.provider === 'local') return 'local'
    if (cfg.provider === 'cloud') return cloudDreamAvailable() ? 'cloud' : 'skip'
    if (localOn) return 'local'
    return cloudDreamAvailable() ? 'cloud' : 'skip'
  }

  /** 云端续写：用 DSH 默认模型流式拼文本（与本地 continueDream 同签名） */
  async function cloudContinueDream({ previous = '', cards = [], persona = '', mood = '', timeoutMs = 180000, maxTokens = 1500, signal = null, onChunk = null } = {}) {
    let acc = ''
    let interrupted = false
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      const llm = ctx.get?.('llm')
      if (!sel?.provider || !sel?.model || !llm) return { text: '', interrupted: false, error: 'no-cloud-model' }
      const prompt = buildContinuePrompt({ previous, cards, persona, mood, maxTokens })
      const timeout = AbortSignal.timeout(timeoutMs)
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout
      for await (const ch of llm.stream({
        provider: sel.provider,
        model: sel.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: Math.min(2000, Math.max(300, Number(maxTokens) || 1200)),
        temperature: 0.9,
        signal: composite,
        purpose: 'hcem-dream',
      })) {
        if (ch?.type === 'text-delta' && typeof ch.text === 'string') {
          acc += ch.text
          try {
            onChunk?.(ch.text)
          } catch {}
        }
        if (ch?.type === 'finish' && ch.reason?.kind === 'aborted') interrupted = true
      }
    } catch (error) {
      const msg = String((error && error.message) || error)
      if (msg.includes('abort')) interrupted = true
      else return { text: acc.trim(), interrupted: false, error: msg }
    }
    return { text: acc.trim(), interrupted }
  }

  /** 感知摘要第二步走云端（Omni 让位时用） */
  async function cloudStep2({ system = '', user = '', maxTokens = 900 } = {}) {
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      const llm = ctx.get?.('llm')
      if (!sel?.provider || !sel?.model || !llm) return ''
      let acc = ''
      for await (const ch of llm.stream({
        provider: sel.provider,
        model: sel.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: [{ type: 'text', text: String(user || '') }] },
        ],
        maxTokens: Math.min(1200, Math.max(120, Number(maxTokens) || 900)),
        temperature: 0.5,
        purpose: 'hcem-summary-step2',
      })) {
        if (ch?.type === 'text-delta' && typeof ch.text === 'string') acc += ch.text
      }
      return acc.trim()
    } catch {
      return ''
    }
  }

  /** 梦的续写入口：按 provider 分流 */
  async function dreamContinue(opts = {}) {
    const p = dreamProvider()
    if (p === 'cloud') return cloudContinueDream(opts)
    if (p === 'skip') return { text: '', interrupted: false, error: 'quota' }
    const { continueDream } = await import('./lib/dream.mjs')
    return continueDream(opts)
  }

  // 空闲调度：10min 做梦 → 30min 休眠（全停模型）+ 用户活动打断
  ctx.effect(() => {
    let idle = null
    try {
      idle = createIdleScheduler({
        logger,
        dataDir: DATA_DIR,
        store,
        continueDreamFn: dreamContinue,
        canDream: () => dreamProvider() !== 'skip',
        getPersona: () => {
          try {
            const p = loadPersona()
            return p?.name || 'HCEM'
          } catch {
            return 'HCEM'
          }
        },
        getMood: () => {
          try {
            const e = store?.getEmotion('global')
            if (!e) return ''
            return `H${Math.round(e.H)} S${Math.round(e.S)}`
          } catch {
            return ''
          }
        },
        // ② 空闲休眠 → 所有模型都杀（包括常驻的 embedding）。
        // 之前只杀 qwen3/omni/qwen25vl，embedding 一直留着，跟"休眠"的说法不符。
        sleepAll: async () => {
          try {
            const { stopAllServices } = await import('./lib/services.mjs')
            const r = stopAllServices(logger)
            logger.info?.('[hcem] 休眠：已关闭全部模型（含 embedding / TTS）' + (r?.killed?.length ? ' killed=' + r.killed.join(',') : ''))
          } catch (error) {
            logger.warn?.('[hcem] 休眠关模型失败: ' + String((error && error.message) || error))
          }
        },
        // ② 梦开始前让位：视觉(8091)/TTS(8099) 都停掉，只留 qwen3(抽卡) + embedding + omni(续写)
        onDreamStart: async () => {
          try {
            const svc = await import('./lib/services.mjs')
            svc.stopService('qwen25vl', logger)
            svc.stopTts()
            const provider = dreamProvider()
            if (provider === 'cloud') {
              // 云端梦：本地模型全部让位，只留 embedding（CPU）
              svc.stopService('qwen3', logger)
              svc.stopService('omni', logger)
              bumpDreamQuota()
              logger.info?.('[hcem] 云端做梦：本场用云端模型，今日配额 ' + JSON.stringify(dreamQuota()))
              return
            }
            // 本地梦：梦要用 qwen3 抽卡、omni 续写（embedding 常驻不占显卡）
            // startService 自带「已在运行就跳过」，不用先探测
            for (const k of ['qwen3', 'omni']) svc.startService(k, logger)
            // 必须等它们真就绪：端口在听 ≠ 模型加载完，提前请求会 5ms 失败
            const ready = async (port) => {
              try {
                const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
                  signal: AbortSignal.timeout(2000),
                })
                return r.ok
              } catch {
                return false
              }
            }
            let ok = false
            for (let i = 0; i < 90; i += 1) {
              if ((await ready(8093)) && (await ready(8098))) {
                ok = true
                break
              }
              await new Promise((r) => setTimeout(r, 1000))
            }
            logger.info?.(
              '[hcem] 梦境让位：已停视觉/TTS，' +
                (ok ? 'qwen3 + omni 就绪' : '⚠️ 90 秒内未就绪（梦可能会失败）'),
            )
          } catch (error) {
            logger.warn?.('[hcem] 梦境让位失败: ' + String((error && error.message) || error))
          }
        },
        // ③ 梦结束：梦期间被压住的搭话在这里补发；再看用户是否回应，没回应就释放模型
        onDreamEnd: () => {
          try {
            // 进入休眠时梦是被"收尾"结束的，不该再补搭话/起看门狗
            try {
              if (idleRef?.getState?.().sleeping) return
            } catch {}
            const spoke = postDreamBubblePending
            postDreamBubblePending = false
            // 让梦的日记落盘、状态稳定一下再搭话
            setTimeout(() => {
              try {
                bubble?.pokeSoon?.(20000, 'post-dream')
              } catch {}
            }, 20 * 1000)
            // 5 分钟内用户没回应 → 杀掉全部模型（梦已经结束，没必要占着显存）
            const pivotAt = Date.now()
            if (postDreamWatchdog) clearTimeout(postDreamWatchdog)
            postDreamWatchdog = setTimeout(async () => {
              postDreamWatchdog = null
              const answered = lastUserAt > pivotAt
              if (answered) {
                logger.info?.('[hcem] 梦后搭话有回应，模型保留')
                return
              }
              try {
                const svc = await import('./lib/services.mjs')
                const r = svc.stopAllServices(logger)
                svc.stopTts()
                logger.info?.(
                  '[hcem] 梦后搭话无人回应（' +
                    (spoke ? '梦中有待发搭话' : '梦后补发搭话') +
                    '），已释放全部模型' +
                    (r?.killed?.length ? '：' + r.killed.join(',') : ''),
                )
              } catch (error) {
                logger.warn?.('[hcem] 梦后释放模型失败: ' + String((error && error.message) || error))
              }
            }, 5 * 60 * 1000)
            logger.info?.('[hcem] 梦结束：搭话延后 20 秒补发，5 分钟无回应则释放模型')
          } catch (error) {
            logger.warn?.('[hcem] 梦结束处理失败: ' + String((error && error.message) || error))
          }
        },
        // ② 用户一有输入就叫醒：按开关把该死的模型拉回来（force 绕过去重）
        onWake: () => {
          try {
            const mods = JSON.parse(fs.readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`, 'utf8'))
            import('./lib/services.mjs')
              .then(({ syncServicesWithMods }) => {
                const r = syncServicesWithMods(mods, logger, { force: true })
                logger.info?.('[hcem] 唤醒同步 ' + JSON.stringify(r))
              })
              .catch(() => {})
          } catch (error) {
            logger.warn?.('[hcem] 唤醒失败: ' + String((error && error.message) || error))
          }
        },
        checkIntervalMs: 30 * 1000,
      })
      idle.recoverPartials?.()
      idle.start()
      idleRef = idle
    } catch (error) {
      logger.warn?.('[hcem] idle 调度器初始化失败: ' + String((error && error.message) || error))
    }
    // 用户消息 → 打断梦 + 重置空闲
    const origProcess = processUserMessage
    processUserMessage = function (text, session) {
      try {
        idle?.touchUser?.()
        noteUserReplied()
        // Q5：陪伴意图软识别（规则优先；没命中按普通对话）
        try {
          const it = classifyIntent(text)
          if (isWatchIntent(it.intent)) {
            watchIntentUntil = Date.now() + 30 * 60 * 1000
            watchSuppressedUntil = 0
            idle?.touchPresence?.('watch-intent')
            logger.info?.('[hcem] 意图=' + it.intent + '（' + it.matched + '）→ 陪看 30 分钟')
          } else if (isNoNeedIntent(it.intent)) {
            watchIntentUntil = 0
            watchSuppressedUntil = Date.now() + 30 * 60 * 1000
            logger.info?.('[hcem] 意图=' + it.intent + '（' + it.matched + '）→ 本次媒体不算陪看')
          }
        } catch {}
      } catch {}
      return origProcess(text, session)
    }
    return () => {
      try {
        idle?.stop?.()
      } catch {}
      processUserMessage = origProcess
    }
  }, 'hcem.idle.scheduler')

  // 感知状态的时间戳：注入时用来判断「这条感知是不是几分钟前的旧话」。
  // 之前只存文本，旧描述会一轮轮重复塞进提示词，AI 会抱怨「一直是同一句」。
  let lastScreenAt = 0
  let lastAudioAt = 0
  // 感知注入的时效上限（毫秒）：超过就不注入，避免复读旧画面
  const PERCEPTION_STALE_MS = 120000

  // 主动搭话的最小间隔：sense-scheduler 内部已有 COMMENT_COOLDOWN_MS(20s)，
  // 这里再兜一层，防止调度器抖动或多次 onComment 连发。
  let lastProactiveAt = 0
  const PROACTIVE_MIN_GAP_MS = 20000
  // 统一闸门：气泡和其他主动发言共用 5 分钟（bubble.mjs 里定义）
  const PROACTIVE_SHARED_GAP_MS = BUBBLE_MIN_GAP_MS

  // ── 场景判定：工作 + 背景播放 vs 真在看视频 ──────────────────
  // 前台是工作类程序、同时有音乐/人声 → 用户在「边工作边放点声音」，不一定需要陪看。
  // 前台是播放器/视频页 → 才算真的在看（presence，不睡不做梦）。
  const VIDEO_RE = /bilibili|youtube|netflix|iqiyi|youku|potplayer|mpv|vlc|mpc-hc|视频|播放/i
  let lastForeground = { ok: false, process: '', title: '', at: 0, isVideo: false }

  function refreshForeground() {
    try {
      const win = getForegroundWindow()
      if (!win?.ok) return
      const t = String(win.title || '') + ' ' + String(win.process || '')
      const isVideo = VIDEO_RE.test(t)
      lastForeground = { ok: true, process: String(win.process || ''), title: String(win.title || ''), at: Date.now(), isVideo }
      if (isVideo && Date.now() >= watchSuppressedUntil) {
        // 真在看视频：presence，保持模型、不做梦
        idleRef?.touchPresence?.('video')
      }
    } catch {}
  }

  /** 主动开口的统一闸门：睡觉/做梦/搭话冷却期内都不许（摘要主动发送也走这里） */
  function proactiveAllowed() {
    try {
      const st = idleRef?.getState?.()
      if (st && (st.sleeping || st.dreaming)) return false
    } catch {}
    if (bubbleQuota.cooldownUntil > Date.now()) return false
    return true
  }

  function saveScene() {
    try {
      writeFileSync(
        join(DATA_DIR, 'ui-state', 'scene.json'),
        JSON.stringify(
          {
            foreground: lastForeground,
            updatedAt: Date.now(),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {}
  }

  // 感知窗口提到 apply 作用域：气泡调度器也要读「最近看到/听到什么」
  const perceptionWindow = createPerceptionWindow({ maxAgeMs: 120000, maxItems: 80 })
  // 用户最后一次说话的时间（气泡用来算「距上次说话多久」）
  let lastUserAt = 0
  // DSH 页面是否可见且聚焦（由 client 插件上报）
  let dshFocused = false
  let bubble = null
  // ── 搭话配额：连续三次没人接 → 24h 不再主动开口（云端尤其烧钱）──
  const BUBBLE_QUOTA_PATH = join(DATA_DIR, 'ui-state', 'bubble-quota.json')
  let bubbleQuota = (() => {
    try {
      const j = JSON.parse(readFileSync(BUBBLE_QUOTA_PATH, 'utf8'))
      return {
        unanswered: Math.max(0, Number(j?.unanswered) || 0),
        cooldownUntil: Number(j?.cooldownUntil) || 0,
        lastBubbleAt: Number(j?.lastBubbleAt) || 0,
      }
    } catch {
      return { unanswered: 0, cooldownUntil: 0, lastBubbleAt: 0 }
    }
  })()

  function saveBubbleQuota() {
    try {
      writeFileSync(BUBBLE_QUOTA_PATH, JSON.stringify(bubbleQuota, null, 2), 'utf8')
    } catch {}
  }

  // 用户真的说话了：连续计数清零、冷却解除（他愿意聊了）
  function noteUserReplied() {
    if (bubbleQuota.unanswered === 0 && bubbleQuota.cooldownUntil === 0) return
    bubbleQuota.unanswered = 0
    bubbleQuota.cooldownUntil = 0
    saveBubbleQuota()
  }

  // 一条搭话发出去了：上一条有没有人回？连击 3 次就静默 24h
  function noteBubbleSent() {
    const replied = lastUserAt > (bubbleQuota.lastBubbleAt || 0)
    bubbleQuota.unanswered = replied ? 1 : bubbleQuota.unanswered + 1
    bubbleQuota.lastBubbleAt = Date.now()
    if (bubbleQuota.unanswered >= 3) {
      bubbleQuota.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000
      logger.warn?.('[hcem] 连续 3 次搭话没人回应，24 小时内不再主动说话')
    }
    saveBubbleQuota()
  }

  // ── 媒体笔记会话：一场视频 = 一条 note ─────────────────────
  const NOTE_IDLE_MS = 10 * 60 * 1000 // 10 分钟没有新的视频记忆 → 这场结束
  const STORYBOARD_MAX_WAIT_MS = 2 * 60 * 1000 // 满不了 16 帧也最多等 2 分钟
  let mediaNote = {
    startedAt: 0,
    ids: [],
    descs: [],
    audios: [],
    frames: [],
    blocks: [],
    storyboards: [],
    lastSbAt: 0,
    blockStartedAt: 0,
    blockTimer: null,
    timer: null,
  }
  // Q5：陪伴意图
  let watchIntentUntil = 0 // 用户明示陪看的有效期
  let watchSuppressedUntil = 0 // 用户说“在忙/不用”后，媒体不再算 presence 的期限
  let noteTimer = null

  function resetMediaNote() {
    if (mediaNote.timer) clearTimeout(mediaNote.timer)
    if (mediaNote.blockTimer) clearTimeout(mediaNote.blockTimer)
    mediaNote = {
      startedAt: 0,
      ids: [],
      descs: [],
      audios: [],
      frames: [],
      blocks: [],
      storyboards: [],
      lastSbAt: 0,
      blockStartedAt: 0,
      blockTimer: null,
      timer: null,
    }
  }

  function touchMediaNote(memoryId, desc) {
    if (!memoryId) return
    if (!mediaNote.startedAt) {
      mediaNote.startedAt = Date.now()
      // 这场视频一开始就把 Qwen3 拉起来（CPU），后面摘要/抽元数据不用等
      ensureQwen3Ready().catch(() => {})
    }
    if (!mediaNote.ids.includes(memoryId)) mediaNote.ids.push(memoryId)
    if (desc) mediaNote.descs.push({ ts: Date.now(), text: String(desc).slice(0, 300) })
    if (mediaNote.descs.length > 40) mediaNote.descs = mediaNote.descs.slice(-40)

    // 看视频期间每 60 秒自动拼一张分镜（不调用工具也会发生）
    if (mediaNote.ids.length >= 4 && Date.now() - (mediaNote.lastSbAt || 0) > 60000) {
      mediaNote.lastSbAt = Date.now()
      const snapshot = { ids: mediaNote.ids.slice(-16), startedAt: mediaNote.startedAt }
      setTimeout(() => {
        autoStoryboard(snapshot)
          .then((p) => {
            if (p) mediaNote.storyboards.push(p)
          })
          .catch(() => {})
      }, 0)
    }

    if (mediaNote.timer) clearTimeout(mediaNote.timer)
    mediaNote.timer = setTimeout(() => {
      finalizeMediaNote().catch(() => {})
    }, NOTE_IDLE_MS)
    if (mediaNote.timer.unref) mediaNote.timer.unref()
  }

  function scheduleBlockFlush() {
    if (mediaNote.blockTimer) clearTimeout(mediaNote.blockTimer)
    const wait = Math.max(1000, STORYBOARD_MAX_WAIT_MS - (Date.now() - (mediaNote.blockStartedAt || Date.now())))
    mediaNote.blockTimer = setTimeout(() => {
      mediaNote.blockTimer = null
      mediaNote.blockStartedAt = 0
      const block = mediaNote.frames.splice(0)
      if (block.length >= 4) flushStoryboardBlock(block).catch(() => {})
    }, wait)
    if (mediaNote.blockTimer.unref) mediaNote.blockTimer.unref()
  }

  function touchMediaFrame(ev) {
    if (!ev || !ev.description) return
    if (!mediaNote.startedAt) {
      mediaNote.startedAt = Date.now()
      ensureQwen3Ready().catch(() => {})
    }
    const ts = Date.now()
    mediaNote.frames.push({ image: ev.image || null, desc: String(ev.description).slice(0, 300), ts })
    if (!mediaNote.blockStartedAt) mediaNote.blockStartedAt = ts
    scheduleBlockFlush()
    mediaNote.descs.push({ ts, text: String(ev.description).slice(0, 300) })
    if (mediaNote.descs.length > 40) mediaNote.descs = mediaNote.descs.slice(-40)
    if (mediaNote.timer) clearTimeout(mediaNote.timer)
    mediaNote.timer = setTimeout(() => {
      finalizeMediaNote().catch(() => {})
    }, NOTE_IDLE_MS)
    if (mediaNote.timer.unref) mediaNote.timer.unref()

    // 每满 4×4（16 帧）就生成一张故事板 + 摘要，成为一条视觉记忆
    if (mediaNote.frames.length >= 16) {
      const block = mediaNote.frames.splice(0, 16)
      if (mediaNote.blockTimer) clearTimeout(mediaNote.blockTimer)
      mediaNote.blockTimer = null
      mediaNote.blockStartedAt = 0
      flushStoryboardBlock(block).catch(() => {})
    }
  }

  async function flushStoryboardBlock(frames) {
    if (!Array.isArray(frames) || frames.length < 4) return
    const t0 = frames[0].ts
    const t1 = frames[frames.length - 1].ts
    const span = (v) => ((v - t0) / 1000).toFixed(1) + 's'
    let summary = ''
    try {
      if (await ensureQwen3Ready()) {
        const sm = await summarizeNoteMaterials({
          descs: frames.map((f) => ({ text: f.desc })),
          audios: (mediaNote.audios || []).filter((a) => a.ts >= t0 && a.ts <= t1),
          maxChars: 420,
        })
        if (sm.ok && sm.text) summary = sm.text
      }
    } catch {}
    if (!summary) summary = frames.map((f) => f.desc).filter(Boolean).slice(0, 4).join('；')
    if (!summary) return

    // 故事板图片
    let storyboard = ''
    let sbW = 0
    let sbH = 0
    try {
      const imgs = frames.map((f) => f.image).filter((p) => p && existsSync(p))
      if (imgs.length >= 4) {
        const dir = join(DATA_DIR, 'notes')
        mkdirSync(dir, { recursive: true })
        const out = join(dir, 'vb-' + t0.toString(36) + '.png')
        const labels = imgs.map((_, i) => ((frames[i]?.ts - t0) / 1000).toFixed(1) + 's')
        const count = Math.min(16, imgs.length)
        const cols = count <= 4 ? 2 : count <= 9 ? 3 : 4
        const rows = Math.ceil(count / cols)
        const cellW = count > 9 ? 320 : 480
        const cellH = count > 9 ? 180 : 270
        const sh = await buildSheet(imgs.slice(0, 16), {
          outPath: out,
          cols,
          rows,
          cellWidth: cellW,
          cellHeight: cellH,
          labels,
        })
        if (sh.ok) {
          storyboard = sh.path
          sbW = cols * cellW + 4 * (cols + 1)
          sbH = rows * cellH + 4 * (rows + 1)
        }
      }
    } catch {}

    // 每格时间范围 + 这格覆盖的台词/声音，供召回时按格回查
    const blockAudios = (mediaNote.audios || []).filter((x) => x.end > t0 && x.ts < t1)
    const blockSegments = []
    for (const au of blockAudios) {
      for (const sg of au.segments || []) {
        if (sg.end > t0 && sg.start < t1) blockSegments.push({ ...sg, kind: au.kind })
      }
    }
    const cells = frames.map((f, i) => {
      const start = i === 0 ? t0 : Math.round((frames[i - 1].ts + f.ts) / 2)
      const end = i === frames.length - 1 ? t1 : Math.round((f.ts + frames[i + 1].ts) / 2)
      const hits = blockSegments.filter((sg) => sg.end > start && sg.start < end)
      const audioHits = blockAudios.filter((au) => au.end > start && au.ts < end)
      return {
        index: i,
        t_start: start,
        t_end: end,
        text: hits.map((h) => h.text).filter(Boolean).join('；').slice(0, 300),
        audio: audioHits.map((h) => h.text).filter(Boolean).join('；').slice(0, 300),
      }
    })

    // 声音时间轴条：和宫格共用同一段起止时间
    if (storyboard && sbW > 0 && blockAudios.length > 0) {
      try {
        const withStrip = await addAudioStrip(storyboard, {
          outPath: storyboard.replace(/\.png$/i, '-audio.png'),
          width: sbW,
          height: sbH,
          timeStart: t0,
          timeEnd: t1,
          audios: blockAudios,
          cells,
        })
        if (withStrip && existsSync(withStrip)) storyboard = withStrip
      } catch {}
    }

    // 写一条视觉记忆：text 就是摘要（含时间跨度），故事板是证据图
    let id = ''
    if (store) {
      try {
        let alpha = { H: 360, S: 15 }
        try {
          const e = store.getEmotion('global')
          if (e) alpha = { H: e.H, S: e.S }
        } catch {}
        id = store.putMemory({
          text: `[${span(t0)}–${span(t1)}] ${summary}`,
          summary: summary.slice(0, 80),
          zone: 'video_context',
          modality: 'video',
          alphaH: alpha.H,
          alphaS: alpha.S,
          gammaValue: 0.8,
          L: 0.9,
          deltaPool: 1.0,
          timeStart: t0,
          timeEnd: t1,
          avMeta: {
            kind: 'storyboard',
            image: storyboard,
            timeStart: t0,
            timeEnd: t1,
            frameIds: frames.map((f) => f.image).filter(Boolean),
            segments: frames.map((f) => ({ t: f.ts, text: f.desc })),
            cells,
            audioSegments: blockSegments.slice(0, 80),
            type: 'episode',
          },
        })
        try {
          store.setAvMeta(id, { videoP: 0.9, videoDelta0: 1.0 })
        } catch {}
      } catch {}
    }
    mediaNote.blocks.push({ id, summary, storyboard, t0, t1 })
    if (mediaNote.blocks.length > 8) mediaNote.blocks = mediaNote.blocks.slice(-8)
  }

  async function autoStoryboard(snapshot) {
    try {
      if (!store || !snapshot || !snapshot.ids || snapshot.ids.length < 4) return ''
      const imgs = []
      const times = []
      for (const mid of snapshot.ids) {
        try {
          const row = store.getMemory(mid)
          const av = row?.av_meta ? JSON.parse(String(row.av_meta)) : null
          if (av?.image && existsSync(av.image)) {
            imgs.push(av.image)
            times.push(Date.parse(String(row.created_at || '')) || 0)
          }
        } catch {}
        if (imgs.length >= 16) break
      }
      if (imgs.length < 4) return ''
      const dir = join(DATA_DIR, 'notes')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, 'auto-sb-' + snapshot.startedAt.toString(36) + '-' + Date.now().toString(36) + '.png')
      const labels = times.map((t) => ((t - (times[0] || t)) / 1000).toFixed(1) + 's')
      const cols = imgs.length <= 4 ? 2 : imgs.length <= 9 ? 3 : 4
      const rows = Math.ceil(imgs.length / cols)
      const sh = await buildSheet(imgs, {
        outPath: out,
        cols,
        rows,
        cellWidth: imgs.length > 9 ? 320 : 480,
        cellHeight: imgs.length > 9 ? 180 : 270,
        labels,
      })
      return sh.ok ? sh.path : ''
    } catch {
      return ''
    }
  }

  function touchMediaAudio(r) {
    if (!r || !r.ok || !mediaNote.startedAt) return
    const text = String(r.soundDesc || r.text || r.categoryName || '').trim()
    if (!text) return
    const base = Number(r.timeStart) || Date.now()
    const segments = (Array.isArray(r.asrSegments) ? r.asrSegments : []).map((sg) => ({
      start: base + Math.round(Number(sg.start || 0) * 1000),
      end: base + Math.round(Number(sg.end || 0) * 1000),
      text: String(sg.text || '').slice(0, 200),
    }))
    mediaNote.audios.push({
      ts: base,
      end: Number(r.timeEnd) || Date.now(),
      text: text.slice(0, 300),
      kind: r.kind || r.category || 'scene',
      categoryName: r.categoryName || '',
      emotion: r.emotion || '',
      musicInfo: r.musicInfo && r.musicInfo.ok ? String(r.musicInfo.text || '').slice(0, 160) : '',
      segments,
    })
    if (mediaNote.audios.length > 40) mediaNote.audios = mediaNote.audios.slice(-40)
  }

  async function ensureQwen3Ready() {
    const probe = async () => {
      try {
        const r = await fetch('http://127.0.0.1:8093/v1/models', { signal: AbortSignal.timeout(1200) })
        return r.ok
      } catch {
        return false
      }
    }
    if (await probe()) return true
    try {
      const svc = await import('./lib/services.mjs')
      svc.startService('qwen3', logger)
    } catch {}
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 700))
      if (await probe()) return true
    }
    return false
  }

  async function finalizeMediaNote() {
    const cur = mediaNote
    resetMediaNote()
    const hasContent = (cur.ids && cur.ids.length) || (cur.descs && cur.descs.length) || (cur.audios && cur.audios.length) || (cur.blocks && cur.blocks.length)
    if (!store || !hasContent) return { ok: false, reason: 'empty' }
    try {
      let alpha = { H: 360, S: 15 }
      try {
        const e = store.getEmotion('global')
        if (e) alpha = { H: e.H, S: e.S }
      } catch {}
      // 共用 p₀/δ₀：取第一条视频记忆的值
      let p0 = 0.9
      let d0 = 1.0
      try {
        const first = store.getMemory(cur.ids[0])
        if (first) {
          p0 = Number(first.video_p ?? 0.9) || 0.9
          d0 = Number(first.video_delta0 ?? 1.0) || 1.0
        }
      } catch {}
      const descs = cur.descs || []
      const audios = cur.audios || []
      const pick = (arr, k) =>
        arr.length <= k ? arr : Array.from({ length: k }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (k - 1))])
      const blocks = cur.blocks || []
      const rawSummary = [
        ...blocks.map((b) => b.summary),
        ...pick(descs, 3).map((d) => d.text),
        ...pick(audios, 2).map((a) => '声音：' + a.text),
      ].join('；') || '看了一段视频'
      let summary = rawSummary
      // 已经有故事板摘要时不再重复做一次全量 map-reduce
      if (blocks.length === 0) {
        try {
          if (await ensureQwen3Ready()) {
            const sm = await summarizeNoteMaterials({ descs, audios, maxChars: 500 })
            if (sm.ok && sm.text) summary = sm.text
            else logger.warn?.('[hcem] 笔记摘要失败，回退原始：' + (sm.error || ''))
          }
        } catch {}
      }
      // 抽标题/角色/背景（Qwen3 CPU；失败就留空，不影响笔记）
      let noteMeta = { title: '', characters: [], background: '' }
      try {
        if (await ensureQwen3Ready()) {
          noteMeta = await extractNoteMeta({ descs })
        }
      } catch {}
      // 优先用会话期间自动拼好的分镜；没有才现拼
      let storyboard =
        (cur.blocks && cur.blocks.length && cur.blocks[cur.blocks.length - 1].storyboard) ||
        (cur.storyboards && cur.storyboards.length ? cur.storyboards[cur.storyboards.length - 1] : '')
      try {
        if (storyboard) throw new Error('have-auto-storyboard')
        const imgs = []
        const imgTimes = []
        for (const mid of cur.ids) {
          try {
            const row = store.getMemory(mid)
            const av = row?.av_meta ? JSON.parse(String(row.av_meta)) : null
            if (av?.image && existsSync(av.image)) {
              imgs.push(av.image)
              imgTimes.push(Date.parse(String(row.created_at || '')) || 0)
            }
          } catch {}
          if (imgs.length >= 6) break
        }
        // 关键帧也先去重（同一个画面留一张就够）
        const deduped = []
        const dedupedTimes = []
        let lastH = ''
        for (let i = 0; i < imgs.length; i += 1) {
          const p = imgs[i]
          const h = await aHash(p)
          if (h && (!lastH || hammingDistance(h, lastH) > 4)) {
            deduped.push(p)
            dedupedTimes.push(imgTimes[i] || 0)
            lastH = h
          }
        }
        const useImgs = deduped.length >= 2 ? deduped : imgs
        const useTimes = deduped.length >= 2 ? dedupedTimes : imgTimes
        if (useImgs.length >= 2) {
          const dir = join(DATA_DIR, 'notes')
          mkdirSync(dir, { recursive: true })
          const out = join(dir, 'storyboard-' + cur.startedAt.toString(36) + '.png')
          const labels = useTimes.map((t) => ((t - (useTimes[0] || t)) / 1000).toFixed(1) + 's')
          const sh = await buildSheet(useImgs, { outPath: out, cellWidth: 480, cellHeight: 270, labels })
          if (sh.ok) storyboard = sh.path
        }
      } catch {}
      if (!noteMeta.title) noteMeta.title = String(summary).replace(/^画面[:：]?/, '').slice(0, 24)
      const r = createNote(store, {
        summary: summary.slice(0, 600),
        storyboard,
        title: noteMeta.title,
        characters: noteMeta.characters,
        background: noteMeta.background,
        sessionId: 'sess_' + cur.startedAt.toString(36),
        media: 'video',
        segments: [
          ...(cur.blocks || []).map((b) => ({ t: b.t0, text: b.summary })),
          ...descs.map((d) => ({ t: d.ts, text: d.text })),
          ...audios.map((a) => ({ t: a.ts, text: a.text })),
        ]
          .sort((a, b) => a.t - b.t)
          .slice(0, 60),
        memoryIds: cur.ids.slice(),
        frameIds: cur.ids.slice(),
        alpha,
        p0,
        delta0: d0,
      })
      logger.info?.(`[hcem] 视频笔记已写：${r.ok ? r.id : r.error}（记忆 ${cur.ids.length} 条）`)
      // 系列聚类：未聚类的 note 够了就跑一次（异步，失败不影响）
      try {
        const { listNotes } = await import('./lib/notes.mjs')
        const pending = listNotes(store, { limit: 500, onlyUnclustered: true }).length
        if (pending >= 20 && analyzer?.embed) {
          clusterNotes(store, { embed: (texts) => analyzer.embed(texts), minNotes: 20 }).then((c) => {
            if (c.ok && c.assigned) logger.info?.(`[hcem] 笔记系列聚类：${c.groups} 组 / ${c.assigned} 条`)
          }).catch(() => {})
        }
      } catch {}
      return r
    } catch (e) {
      logger.warn?.('[hcem] 视频笔记写入失败: ' + String((e && e.message) || e))
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // 前台窗口轮询：判断"真在看视频"还是"边工作边放声音"
  ctx.effect(() => {
    refreshForeground()
    const t = setInterval(() => {
      refreshForeground()
      saveScene()
    }, 10000)
    if (t.unref) t.unref()
    return () => clearInterval(t)
  }, 'hcem.scene.foreground')

  // 上一条 AI 自己说的话（气泡用来避免重复）
  let lastAssistantText = ''
  // 梦优先：梦期间被压住的搭话，等梦结束再补发
  let postDreamBubblePending = false
  // 梦后搭话的看门狗：用户 5 分钟没回应就释放全部模型
  let postDreamWatchdog = null

  // ASR 热词：人名是最容易被识别错的一类（不认识的字必然错）。
  // 每分钟刷新一次，人物卡新增/改名都能跟上。热词是识别时的偏置，不是事后猜。
  ctx.effect(() => {
    const refresh = () => {
      try {
        const names = listPeople()
          .map((p) => p?.name)
          .filter(Boolean)
          .slice(0, 30)
        const me = loadMe(DATA_DIR)
        const meName = String(me?.text || '').match(/我是(.{1,12}?)[。，\n]/)?.[1]
        setAsrTerms([...(meName ? [meName] : []), ...names])
      } catch {}
    }
    refresh()
    const timer = setInterval(refresh, 60000)
    return () => clearInterval(timer)
  }, 'hcem.asr.terms')

  // ── 主动说话（气泡） ────────────────────────────────────────────────
  //
  // 档位决定基础区间（安静不说 / 好奇 15~45min / 话痨 3~12min），
  // S 越高越勤、Aqua 越满越久且满到 60 直接不说；到期还要掷一次概率。
  // 内容用「1.7B 归并素材 → Omni 写成要点 → 投递 prompt」两步生成，
  // 最后开口的仍是对话模型自己，语气才和平时一致。
  ctx.effect(() => {
    // 资源压力地板：显存/内存紧张时 Aqua 漏不到太低（=> 主动说话被硬闸压住，额外本地推理也让位）
    let aquaFloor = 0
    const bump = async () => {
      try {
        const { resourceState } = await import('./lib/resources.mjs')
        const st = await resourceState()
        aquaFloor = Number(st.floor) || 0
      } catch {}
    }
    bump()
    const floorTimer = setInterval(bump, 15000)
    if (floorTimer.unref) floorTimer.unref()

    // Aqua 现值：evaluateSafety 只在用户说话时跑，所以这里要补算漏水量
    const aquaNow = () => {
      try {
        const water = Number(safetyWin?.water ?? 0)
        const last = Number(safetyWin?.lastEvalTs ?? 0)
        const leaked = last ? Math.max(0, water - Math.max(0, (Date.now() - last) / 60000) * 0.8) : water
        // floor 来自本地资源（显存 >=80% 时 50、>=90% 时 65、>=97% 时 80）
        return Math.max(leaked, aquaFloor)
      } catch {
        return aquaFloor || 0
      }
    }

    const composeBubble = async () => {
      const nowMs = Date.now()
      const settings = loadSettings(SETTINGS_PATH)
      const e = (store && store.getEmotion('global')) || state || { H: 360, S: 15, L: 55 }
      // 素材：有什么给什么
      let screenText = ''
      let audioText = ''
      try {
        const items = perceptionWindow.recent(120000)
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const it = items[i]
          if (!screenText && it.kind === 'screen') screenText = it.text
          if (!audioText && it.kind === 'audio') audioText = it.text
          if (screenText && audioText) break
        }
      } catch {}
      let memoryText = ''
      try {
        const pick = randomRecall(store, ['life', 'knowledge'])
        if (pick) memoryText = String(pick.summary || pick.text || '')
      } catch {}

      let clockText = ''
      try {
        const snap = clockSnapshot()
        if (snap) clockText = [snap.greeting, snap.clock].filter(Boolean).join('，')
      } catch {}

      const materials = {
        emotion: { H: e.H, S: e.S, L: e.L },
        clockText,
        gapMinutes: lastUserAt ? (nowMs - lastUserAt) / 60000 : undefined,
        screenText,
        audioText,
        memoryText,
        lastSaidText: lastAssistantText,
      }

      // 第一步 1.7B：把素材归并成客观要点（失败就用原始素材，不阻断）
      let notes = ''
      try {
        const r = await summarizeTwoStep({
          materials: [
            screenText ? { source: '画面', text: screenText, ts: nowMs } : null,
            audioText ? { source: '声音', text: audioText, ts: nowMs } : null,
            memoryText ? { source: '记忆', text: memoryText, ts: nowMs } : null,
          ].filter(Boolean),
          gapMs: lastUserAt ? nowMs - lastUserAt : 0,
          step1Model: 'qwen3',
          step1Only: true,
          thinking1: false,
        })
        if (r?.ok && r.step1) notes = String(r.step1).slice(0, 400)
      } catch (err) {
        logger.warn?.('[bubble] 素材归并失败，退回原始素材: ' + String((err && err.message) || err))
      }

      return formatBubblePrompt({ ...materials, notes })
    }

    // 气泡日志同时写文件（DSH 的 logger 只在控制台，排查时看不到）
    const bubbleLogger = {
      info: (m) => {
        log('INFO', 'bubble', String(m))
        logger.debug?.(String(m))
      },
      warn: (m) => {
        log('WARN', 'bubble', String(m))
        logger.warn?.(String(m))
      },
    }

    // 气泡的可用性判定拆出来，status 里也要能回报原因（否则只能猜）
    //
    // 注意：DSH 公开契约里 Agent 只有 `id`，**没有 status 字段**。
    // 以前用 `a.status === 'idle'` 筛选，运行时大概率恒不成立（undefined），
    // 于是永远报「没有空闲会话」、一条气泡都不冒。
    // 现在优先用 ctx.agents.turnBoundaryOf(session) 判断有没有未结束的轮次。
    const agentIsIdle = (agent) => {
      try {
        const tb = ctx.agents?.turnBoundaryOf?.(agent?.session)
        if (tb) return tb.openTurnStartSeq === null || tb.openTurnStartSeq === undefined
      } catch {}
      const st = String(agent?.status ?? '')
      return st !== 'running' && st !== 'busy' && st !== 'streaming'
    }

    const bubbleCanSpeak = () => {
      try {
        if (voiceCall && voiceCall.status().active) return { ok: false, reason: 'in-call' }
      } catch {}
      // 搭话配额：连续三次没人接，24 小时内闭嘴
      if (bubbleQuota.cooldownUntil > Date.now()) {
        return { ok: false, reason: 'quota-cooldown', until: bubbleQuota.cooldownUntil }
      }
      try {
        const st = idleRef?.getState?.()
        if (st && (st.sleeping || st.dreaming)) {
          // 梦优先：梦期间不搭话，但记下来，等梦结束补发
          if (st.dreaming) postDreamBubblePending = true
          return { ok: false, reason: st.sleeping ? 'sleeping' : 'dreaming' }
        }
      } catch {}
      const live = ctx.agents?.list?.() ?? []
      const hcemAgents = live.filter((a) => presetForAgent(a) === 'hcem')
      if (hcemAgents.length === 0) return { ok: false, reason: 'no-hcem-agent' }
      const idleAgent = hcemAgents.find((a) => agentIsIdle(a))
      if (!idleAgent) return { ok: false, reason: 'all-busy' }
      return { ok: true, sessionId: String(idleAgent.id) }
    }

    bubble = createBubbleScheduler({
      logger: bubbleLogger,
      getState: () => {
        const s = loadSettings(SETTINGS_PATH)
        const e = (store && store.getEmotion('global')) || state || { H: 360, S: 15, L: 55 }
        return {
          enabled: s.enabled === true,
          talk: Number(s.talkativeness ?? 0),
          S: Number(e.S ?? 15),
          aqua: aquaNow(),
          requireFocus: s.bubbleRequireFocus !== false,
        }
      },
      isFocused: () => dshFocused,
      canSpeak: bubbleCanSpeak,
      debugGates: () => {
        const st = bubbleCanSpeak()
        const idleState = (() => {
          try {
            return idleRef?.getState?.() ?? null
          } catch {
            return null
          }
        })()
        return {
          focused: dshFocused,
          canSpeak: st,
          sleeping: Boolean(idleState?.sleeping),
          dreaming: Boolean(idleState?.dreaming),
          hcemAgents: (ctx.agents?.list?.() ?? []).filter((a) => presetForAgent(a) === 'hcem').map((a) => String(a.status || '?')),
        }
      },
      compose: composeBubble,
      deliver: async (prompt, sessionId) => {
        // 搭话时截一张当前屏（不阻塞发送，供这一轮/下一轮注入）
        captureTalkFrame('bubble').catch(() => {})
        // 本地分流开着时，这一轮强制走本地：主动说话没有云端服务的必要，别花用户额度
        try {
          const mods = readMods()
          if (mods?.localRoute?.enabled === true || mods?.['local-route'] === true) {
            forceLocalOnce(sessionId)
          }
        } catch {}
        const r = await sendToSession(sessionId, prompt, { source: { kind: 'proactive-bubble' } })
        if (r?.ok) {
          lastProactiveAt = Date.now()
          noteBubbleSent()
          // 参考插件的做法：发完 flush 一次，确保这条进了日志（不 flush 有时只在内存里）
          try {
            const agent = ctx.agents?.get?.(sessionId)
            const sess = agent?.session ?? agent
            if (sess) await ctx.sessions?.flush?.(sess)
          } catch {}
        }
        return Boolean(r?.ok)
      },
    })
    bubble.start()
    return () => {
      try {
        bubble.stop()
      } catch {}
    }
  }, 'hcem.bubble')

  // 感知调度（截屏 + 监听合并）：搭话度 + L 决定采样频率；环境变化大则加速，安静则减速
  //   最终档位 = 用户选的搭话档 + L 修正（L>60 +1 档，L<40 -1 档）
  //   安静档几乎不主动，只有「用户刚说话」或「情绪剧烈波动」才可能开口
  ctx.effect(() => {
    let sense = null
    let manager = null
    let lastChange = { score: 0, description: '', at: 0, newScene: false }
    let sceneKind = null

    // 防重：同一条摘要不要因为连续 onComment 跑两遍
    let lastSummaryAt = 0
    const SUMMARY_MIN_GAP_MS = 60000

    const origProcess2 = processUserMessage
    processUserMessage = function (text, session) {
      lastUserAt = Date.now()
      return origProcess2(text, session)
    }

    let syncTimer = null
    try {
      const cloudBoard = createCloudBoard({
        dataDir: DATA_DIR,
        cloud: loadSettings(SETTINGS_PATH).cloudVision || null,
        logger,
      })
      manager = createCaptureManager({
        dataDir: DATA_DIR,
        modelsDir: MODELS_DIR,
        intervalMs: 6000,
        enableVision: true,
        enableFunnel: true,
        // 视频开关打开且确实有视频窗口时，只截视频屏
        shouldFocusVideo: () => {
          try {
            const m = readMods()
            return Boolean(m?.video?.enabled)
          } catch {
            return false
          }
        },
        logger,
        cloudBoard,
        getEmotion: () => {
          try {
            return store?.getEmotion('global')
          } catch {
            return null
          }
        },
        onChange: (ev) => {
          // 陪看信号：画面在变 / 正在放视频，说明人还在看
          try {
            if (Number(ev?.diff || 0) >= 0.01 || ev?.isVideo === true) {
              idleRef?.touchPresence?.(ev?.isVideo === true ? 'video' : 'screen')
            }
          } catch {}
          lastChange = {
            score: Number(ev?.diff ?? 0),
            description: String(ev?.description || ''),
            at: Date.now(),
            newScene: false,
          }
          if (ev?.description) lastScreenAt = Date.now()
          // 进窗口：供摘要管线按时间轴取用
          if (ev?.description) {
            perceptionWindow.push({
              kind: 'screen',
              text: ev.description,
              ts: Date.now(),
              meta: { diff: ev.diff ?? 0, priority: ev.priority ?? 'mid', isVideo: ev.isVideo === true },
            })
          }
          // 视频：每满 16 帧生成故事板 + 摘要（不再逐窗写视频记忆）
          // 桌面：仍走 fusion 的 8 秒窗口
          if (ev?.description) {
            if (ev.isVideo === true) {
              touchMediaFrame(ev)
            } else {
              fusion.pushVision({
                ts: Date.now(),
                text: ev.description,
                meta: {
                  image: ev.priority === 'high' ? ev.image : null,
                  screen: ev.screen ?? 0,
                  diff: ev.diff ?? 0,
                  priority: ev.priority ?? 'mid',
                  modelScore: ev.modelScore ?? null,
                  isVideo: ev.isVideo === true,
                },
              })
            }
          }
        },
      })
      if (loadSettings(SETTINGS_PATH).listening) manager.start()

      // 设置里的 listening 可能在插件加载后才被 pipe-server 改成 true；
      // 早退会导致「插件启动时没开 → 之后开了也不采集」，这里每 5 秒对齐一次
      let mgrTimer = setInterval(() => {
        try {
          const want = Boolean(loadSettings(SETTINGS_PATH).listening)
          const running = Boolean(manager?.status?.().running)
          if (want && !running) manager.start()
          else if (!want && running) manager.stop()
        } catch {}
      }, 5000)
      if (mgrTimer.unref) mgrTimer.unref()

      sense = createSenseScheduler({
        logger,
        getL: () => {
          try {
            return store?.getEmotion('global')?.L ?? 55
          } catch {
            return 55
          }
        },
        getTalk: () => {
          try {
            return loadSettings(SETTINGS_PATH).talkativeness ?? 1
          } catch {
            return 1
          }
        },
        getRecentUserMessage: () => Date.now() - lastUserAt < 30000,
        capture: () => {
          if (lastChange.description) lastScreenDesc = lastChange.description
          lastChangeScore = Number(lastChange.score || 0)
          return {
            ok: true,
            changeScore: lastChange.score,
            description: lastChange.description,
            newScene: lastChange.newScene,
          }
        },
        listen: async () => {
          const r = await audioTick({ dataDir: DATA_DIR, seconds: 5 })
          if (r.ok || r.soundDesc || r.kind) lastAudioAt = Date.now()
          try {
            touchMediaAudio(r)
          } catch {}
          // 声音信号：听觉常驻开着才算 presence（关掉时根本走不到这里）
          try {
            if (r.ok && (r.kind || r.soundDesc || r.categoryName) && Date.now() >= watchSuppressedUntil) {
              idleRef?.touchPresence?.(r.kind === 'music' || r.category === 'music' ? 'music' : 'audio')
            }
          } catch {}
          // 进窗口：转写 / 声音分类都留一条，供摘要按时间轴取用
          try {
            const audioText = String(r.soundDesc || r.text || r.categoryName || '').trim()
            if (audioText) {
              perceptionWindow.push({ kind: 'audio', text: audioText, ts: Date.now(), meta: { audioKind: r.kind || r.category || 'scene' } })
            }
          } catch {}
          // 声音分类结果（人声/音乐/警报/键鼠/碰撞…）直接更新感知状态
          if (r.soundDesc) {
            lastAudioKind = r.categoryName || r.kind || '环境声'
            // 音乐分析在感知层后台跑过时，把 BPM/调性并进「听到」的文本里
            const mi = r.musicInfo
            lastAudioText = mi && mi.ok && mi.text ? `${r.soundDesc}｜${mi.text}` : r.soundDesc
          }
          if (r.ok) {
            if (store) {
              const alpha = (() => {
                try {
                  return store.getEmotion('global')
                } catch {
                  return null
                }
              })() || { H: 360, S: 15 }
              try {
                // 声音先进融合器，等同一时间窗内的画面一起合并
                fusion.pushAudio({
                  ts: r.timeStart || Date.now(),
                  timeStart: r.timeStart || Date.now(),
                  timeEnd: r.timeEnd || Date.now(),
                  text: r.soundDesc || r.text || r.categoryName || '环境声',
                  meta: {
                    audioKind: r.category || r.kind || 'scene',
                    category: r.category || r.kind || 'scene',
                    categoryName: r.categoryName || '',
                    soundDesc: r.soundDesc || '',
                    emotion: r.emotion || '',
                    emotionScore: r.emotionScore || 0,
                    tags: r.tags || [],
                    music: r.music || null,
                    musicInfo: r.musicInfo || null,
                    fp: r.fp || '',
                    wav: r.wav || null,
                    timeStart: r.timeStart || null,
                    timeEnd: r.timeEnd || null,
                    asrSegments: (Array.isArray(r.asrSegments) ? r.asrSegments : []).map((sg) => ({
                      start: (Number(r.timeStart) || Date.now()) + Math.round(Number(sg.start || 0) * 1000),
                      end: (Number(r.timeStart) || Date.now()) + Math.round(Number(sg.end || 0) * 1000),
                      text: String(sg.text || '').slice(0, 200),
                    })),
                  },
                })
              } catch {}
            }
            if (r.kind && r.kind !== sceneKind) sceneKind = r.kind
          }
          if (r.text) lastAudioText = String(r.text).slice(0, 120)
          if (r.kind) lastAudioKind = String(r.kind)
          return { ok: r.ok, text: r.text, kind: r.kind, emotion: r.emotion }
        },
        onComment: async ({ reason, maxChars, screenDesc, audioKind, tier }) => {
          try {
            // 搭话时截一张当前前台屏，作为这一轮的材料
            await captureTalkFrame(reason).catch(() => {})
            // 留档：给 UI / 兜底注入看
            writeFileSync(
              join(DATA_DIR, 'activation.json'),
              JSON.stringify(
                {
                  ts: Date.now(),
                  source: 'sense',
                  reason,
                  maxChars,
                  tier,
                  screenDesc: screenDesc || '',
                  audioKind: audioKind || '',
                },
                null,
                2,
              ),
              'utf8',
            )
            logger.debug?.('[hcem] sense comment triggered: ' + reason)

            // 后台跑摘要管线（两步共约 9 秒，不能 await，否则会堵住感知调度）
            runSummaryPipeline({ reason, tier }).catch((e) => logDebug('summary pipeline: ' + String((e && e.message) || e)))
          } catch (error) {
            logDebug('sense comment failed: ' + String((error && error.message) || error))
          }
        },
      })
      sense.start()

      /**
       * 两步摘要管线（后台跑，不阻塞感知调度）
       *
       * 材料：perceptionWindow 最近 120 秒
       * 第一步：1.7B 客观摘要「发生了什么」
       * 第二步：Omni 用 me + HSL + 记忆 把摘要讲成一段话
       * 产物：写回 activation.json，下一轮注入时 AI 会看到
       */
      let lastTalkShotAt = 0
  let lastTalkImage = null
  async function captureTalkFrame(reason = 'talk') {
    if (Date.now() - lastTalkShotAt < 15000) return null
    lastTalkShotAt = Date.now()
    try {
      const fg = getForegroundWindow()
      const screens = await listScreens()
      const screenOf = (left, top, width, height) => {
        const cx = left + width / 2
        const cy = top + height / 2
        return screens.find((x) => cx >= x.x && cx < x.x + x.width && cy >= x.y && cy < x.y + x.height)
      }
      // 优先截真正的视频窗口：否则搭话时前台是 DSH，会把桌面当视频截
      let vw = null
      try {
        vw = listVideoWindows().sort((a, b) => b.width * b.height - a.width * a.height)[0]
      } catch {}
      let idx = 0
      let image = ''
      let text = ''
      if (vw && vw.width > 320 && vw.height > 240) {
        const sc = screenOf(vw.left, vw.top, vw.width, vw.height)
        if (sc) idx = sc.index
        const shot = join(DATA_DIR, 'captures', 'talk-video-' + Date.now() + '.png')
        await captureScreen(shot, {
          maxWidth: 1280,
          region: { left: vw.left, top: vw.top, width: vw.width, height: vw.height },
        })
        const rr = await describeImage(shot, {
          prompt: '这是正在播放的视频。逐字抄录字幕/歌词/台词，再看图描述发生了什么；不要反问用户。',
          maxTokens: 300,
        })
        text = String(rr && rr.text ? rr.text : '').trim()
        image = shot
        if (lastTalkImage) {
          try {
            const d = await frameDiff(lastTalkImage, shot)
            if (d > 0.03) {
              globalThis.__hcemVideoActive = {
                screen: idx,
                rect: { left: vw.left, top: vw.top, width: vw.width, height: vw.height },
                until: Date.now() + 5 * 60 * 1000,
              }
              try { manager?.setIntervalMs?.(2000) } catch {}
              logger.info?.('[hcem] 视频窗口画面变化 ' + d.toFixed(3) + ' → 视频模式 #' + idx)
            }
          } catch {}
        }
        lastTalkImage = shot
      } else {
        if (fg && fg.ok) {
          const sc = screenOf(fg.left, fg.top, fg.width, fg.height)
          if (sc) idx = sc.index
        }
        const r = await describeScreen({ maxWidth: 1600, screenIndex: idx, dataDir: DATA_DIR })
        text = String(r && r.text ? r.text : '').trim()
        image = r && r.image ? r.image : ''
      }
      if (text) {
        try {
          perceptionWindow.push({ kind: 'screen', text, ts: Date.now(), meta: { proactive: true, reason } })
        } catch {}
      }
      logger.info?.('[hcem] 搭话快照 #' + idx + '：' + text.slice(0, 80))
      return { text, image }
    } catch (e) {
      logDebug('talk frame failed: ' + String((e && e.message) || e))
      return null
    }
  }

  async function runSummaryPipeline({ reason, tier }) {
        const now = Date.now()
        if (now - lastSummaryAt < SUMMARY_MIN_GAP_MS) return
        // 120 秒而不是 60：实测 60 秒窗口常常只捞到 2 条，材料太薄，摘要只有几十字
        const items = perceptionWindow.recent(120000)
        if (items.length < 3) {
          logDebug(`summary skip: 材料太少(${items.length})`)
          return
        }
        lastSummaryAt = now
        const materials = items.map((i) => ({
          source: i.kind === 'screen' ? '画面' : i.kind === 'audio' ? '声音' : '情绪',
          text: i.text,
          ts: i.ts,
        }))
        const gapMs = now - (lastUserAt || now)
        const { system } = buildCompanionPrompt({ summary: '', gapMs })
        // Omni 不可用（看视频时按 70% 显存让位）→ 第二步走云端；可用则本地
        let step2Runner = null
        try {
          const omniUp = await (async () => {
            try {
              const r = await fetch('http://127.0.0.1:8098/v1/models', { signal: AbortSignal.timeout(800) })
              return r.ok
            } catch {
              return false
            }
          })()
          if (!omniUp && ctx.get?.('llm')) {
            step2Runner = async ({ system: sys, user, maxTokens }) => cloudStep2({ system: sys, user, maxTokens })
            logDebug('summary step2 → cloud（omni 不可用）')
          }
        } catch {}
        const r = await summarizeTwoStep({
          materials,
          gapMs,
          step1Model: 'qwen3',
          step2Model: 'omni',
          thinking1: false,
          thinking2: false,
          step2System: system,
          step2Runner,
        })
        if (!r.ok) {
          logDebug('summary failed: ' + String(r.error || ''))
          return
        }
        try {
          writeFileSync(
            join(DATA_DIR, 'activation.json'),
            JSON.stringify(
              { ts: Date.now(), source: 'summary', reason, tier, step1: r.step1, summary: r.step2, chars: r.chars },
              null,
              2,
            ),
            'utf8',
          )
        } catch {}
        logDebug(`summary ok: step1=${r.step1.length} step2=${r.chars} (${r.ms1}+${r.ms2}ms)`)

        // 摘要好了 → 主动说一句。
        // 闸门和气泡共用 5 分钟：谁先说谁占用，避免「摘要刚说完、气泡又冒一条」。
        try {
          const live = ctx.agents?.list?.() ?? []
          const target = live.find((a) => presetForAgent(a) === 'hcem')
          if (target && proactiveAllowed() && Date.now() - lastProactiveAt >= PROACTIVE_SHARED_GAP_MS) {
            lastProactiveAt = Date.now()
            const r2 = await sendToSession(String(target.id), r.step2, { source: { kind: 'system-prompt' } })
            logDebug('summary proactive -> ' + JSON.stringify(r2))
            // 占用闸门：气泡的计时器顺延
            try {
              bubble?.markSpoke?.()
            } catch {}
          } else if (!target) {
            logDebug('summary proactive skipped: no live HCEM session')
          }
        } catch (e) {
          logDebug('summary proactive failed: ' + String((e && e.message) || e))
        }
      }

      // 调度器算出的间隔 → 同步给采集管理器（每 10 秒对齐一次）
      syncTimer = setInterval(() => {
        try {
          const iv = sense?.status?.().lastIntervalMs
          if (iv) manager?.setIntervalMs?.(iv)
        } catch {}
      }, 10000)
    } catch (error) {
      logger.warn?.('[hcem] sense 调度器初始化失败: ' + String((error && error.message) || error))
    }

    return () => {
      if (syncTimer) clearInterval(syncTimer)
      try {
        clearInterval(mgrTimer)
      } catch {}
      try {
        sense?.stop?.()
      } catch {}
      try {
        manager?.stop?.()
      } catch {}
      processUserMessage = origProcess2
    }
  }, 'hcem.sense.scheduler')

  // 串行处理消息，避免异步更新乱序
  let updateChain = Promise.resolve()
  function processUserMessage(text, session) {
    updateChain = updateChain
      .then(async () => {
        // B2：上一轮回答已生成 → 判定哪些记忆真正被用到（命中的才 δ+1）
        try {
          const laPath = join(DATA_DIR, 'last-answer.json')
          if (store && recalledMemories.length > 0) {
            const la = JSON.parse(readFileSync(laPath, 'utf8'))
            if (la && la.text) {
              const used = markMemoriesUsed(store, recalledMemories, la.text)
              // 回答生成后计算 MD（压缩 + 调用 + 联想）
              for (const u of used) {
                try {
                  const base = recalledMemories.find((m) => m.id === u.id) || u
                  const compressed = String(base.level || '') === 'summary' ? 0.5 : 0.15
                  const recalled = Math.min(1, Number(base.access_count ?? base.accessCount ?? 1) / 5)
                  const associative = /记不清|好像|大概|似乎|可能是|曾经/.test(String(la.text)) ? 0.5 : 0
                  const md = computeMD({ compressed, recalled, associative })
                  store.updateMemoryMD(u.id, md)
                } catch {}
              }
            }
          }
          rmSync(laPath, { force: true })
        } catch {}

        // 只对 HCEM 模式会话生效：标准/创造会话不结算情绪、不写记忆
        if (!isHcemSession(session)) return
        if (!loadSettings(SETTINGS_PATH).enabled) {
          if (store && !coldSince) {
            coldSince = new Date().toISOString()
            try {
              store.setMeta('cold_since', coldSince)
            } catch {}
          }
          return
        }
        if (coldSince) {
          coldSince = null
          try {
            store.setMeta('cold_since', '')
          } catch {}
        }
        const now = Date.now()
        const lastAt = store ? Number(store.getMeta('last_settle_at') || 0) : 0
        const elapsedMin = lastAt > 0 ? (now - lastAt) / 60000 : 0

        // 长期样本 → 可变化的基线（六色圆均值）
        const samples = store ? store.loadJSON('emotion-samples.json') || [] : []
        const baselineInfo = computeBaseline(samples, { H: baseline.H, S: baseline.S, L: baseline.L })
        if (elapsedMin > 0) {
          state = settle(state, { elapsedMin, baselineH: baselineInfo.H, baselineL: baselineInfo.L })
        }

        // 文本刺激优先；文本没有明显情绪时，用「刚看到的画面 / 听到的声音」做弱刺激
        // 感知刺激强度上限 0.3，避免盖过真实对话
        const textStimulus = analyzer ? await analyzer.analyze(text) : analyzeText(text)
        let stimulus = textStimulus
        if (!stimulus) {
          try {
            const src = String(lastScreenDesc || '') || String(lastAudioKind || '')
            const sensed = src ? analyzeText(src) : null
            if (sensed) {
              stimulus = {
                targetHue: sensed.targetHue,
                intensity: Math.min(0.3, 0.1 + Math.abs(Number(lastChangeScore || 0)) * 0.5),
                emotion: sensed.emotion,
                source: 'perception',
              }
              logDebug(`perception stimulus hue=${sensed.targetHue} intensity=${stimulus.intensity.toFixed(2)}`)
            }
          } catch {}
        }
        state = stimulus ? applyStimulus(state, stimulus, baseline.stimulusScale) : tick(state)
        if (store) {
          store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
          store.setMeta('last_settle_at', String(now))
          // 记忆转区：上下文 → 缓冲池三级 → 遗忘（关闭 HCEM 时不执行）
          try {
            promoteMemories(store, now)
          } catch {}

          // 记录样本（7 天窗口），并让 AI 的 natural 基线慢慢跟随长期情绪重心
          const nextSamples = appendSample(samples, state, now)
          store.saveJSON('emotion-samples.json', nextSamples)
          if (baselineInfo.count > 0) {
            const cur = loadSettings(SETTINGS_PATH)
            if (Number(cur.natural?.hue ?? 0) !== baselineInfo.natural) {
              saveSettings(SETTINGS_PATH, {
                ...cur,
                natural: { ...cur.natural, hue: baselineInfo.natural },
              })
            }
          }
        }

        // L（明度/自信）：方案 A（平滑靠拢记忆基线）+ 方案 C（六色 SC 耦合）+ 时钟回落
        if (store) {
          const mems = store.listMemories({ limit: 50 })
          const baseL = lightnessFromMemories(mems)
          // ① 向记忆基线轻拉（每轮 1%，弱拉回：允许情绪把 L 推到极限）
          let nextL = state.L + (baseL - state.L) * 0.01
          // ② SC 耦合：情绪越强、SC 越显著（每轮 ±0.3×S/100，可累积到极限）
          const sc = selfConfidenceOf(state.H)
          const lDeviation = Math.abs(nextL - 55) / 45
          const lGain = L_BASE * Math.exp(L_EXPONENT * Math.min(1, lDeviation))
          nextL += sc * 0.3 * (Number(state.S) / 100) * lGain
          // ③ 时钟回落：每轮 0.5% 向基线（真正的回落交给 settle 按真实时间做）
          nextL += (baseL - nextL) * 0.005
          state = { ...state, L: Math.max(0, Math.min(100, nextL)) }
          store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
        }

        // 安全阀：用更新后的情绪 + 本轮文本评估
        recordTurn(safetyWin, { H: state.H, text })
        assertSafetyValve('情绪结算后')
        safetyState = evaluateSafety(safetyWin, state)
        if (safetyState.level > 0) {
          logDebug(
            `safety level=${safetyState.level} count=${safetyState.count} triggered=${safetyState.triggered.join(',')} details=${JSON.stringify(safetyState.details)}`,
          )
        }

        // 记忆写入（α=编码时情绪，β=内容情绪）
        // 3 级：先冷却到安全值 75~80（保留同理心，不冷却到基准）
        // 若 3 分钟后仍未自然回落（S 仍 ≥75），允许自制器介入
        if (safetyState.level >= 3) {
          if (!level3Since) level3Since = now
          const capped = Math.min(80, Math.max(75, state.S))
          if (Math.abs(capped - state.S) > 1e-9) {
            state = { ...state, S: capped }
            if (store) store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
          }
          if (now - level3Since >= 3 * 60 * 1000 && state.S >= 75) {
            const sc = useSelfControl(state, baseline)
            if (sc.applied) {
              state = sc.state
              if (store) store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
              logDebug(`self-control(level3) delta=${sc.delta.toFixed(1)} S=${state.S.toFixed(0)} cooldown=${sc.cooldownTurns}`)
            }
          }
        } else {
          level3Since = 0
          // 情绪自制器：S>75 且不在冷却时自主回调
          const sc = useSelfControl(state, baseline)
          if (sc.applied) {
            state = sc.state
            if (store) store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
            logDebug(`self-control delta=${sc.delta.toFixed(1)} S=${state.S.toFixed(0)} cooldown=${sc.cooldownTurns}`)
          }
        }

        if (store && analyzer && shouldRemember(text) && safetyState.level < 2 && !safetyState.protected) {
          try {
            const memText = extractMemoryText(text)
            // 兜底：5 秒内同一段文本只写一条（双实例/事件重放时防止重复落库）
            const duplicated = store
              .listMemories({ limit: 6 })
              .some((m) => m.text === memText && Date.now() - new Date(m.created_at).getTime() < 5000)
            if (!duplicated) {
              assertSafetyValve('记忆写入前')
              const [vec] = await analyzer.embed([memText])
              // trauma 戳：用户辱骂/羞辱 → 这条记忆带痛感
              const insult = detectInsult(text)
              store.putMemory({
                text: memText,
                summary: summarize(memText),
                embedding: vec,
                alphaH: state.H,
                alphaS: state.S,
                betaH: stimulus ? stimulus.targetHue : null,
                betaS: stimulus ? (stimulus.intensity ?? 0.5) * 100 : null,
                gammaValue: computeGamma(
                  { H: state.H, S: state.S },
                  stimulus ? { H: stimulus.targetHue, S: (stimulus.intensity ?? 0.5) * 100 } : null,
                ),
                zone: 'context',
                pinned: detectPinIntent(memText),
                L: 1.0,
                level: 'full',
                ...(insult.hit ? { trauma: insult.severity, traumaSource: 'insult' } : {}),
              })
            }
          } catch (error) {
            logger.debug(`[hcem] memory write failed: ${String((error && error.message) || error)}`)
          }
        }

        // 检索相关记忆（供注入 system prompt）
        if (store && analyzer) {
          try {
            const [qvec] = await analyzer.embed([text])
            const ranked = recall(store, qvec, 3, 0.45, { queryText: text, state, meta: true })
            const picked = chooseSeeds({ hits: ranked, queryText: text, state, store, maxSeeds: 3 })
            recalledMemories = picked.seeds
            if (picked.path !== 'none') {
              logDebug(
                'seed path: ' + picked.path + ' seeds=' + picked.seeds.length + (picked.expanded ? ' expanded=' + picked.expanded : ''),
              )
            }
            try {
              const gm = recalledMemories && recalledMemories.meta
              if (gm) {
                logDebug(
                  'recall gate: ' + gm.reason +
                    ' kept=' + gm.kept + '/' + gm.candidates +
                    ' top1=' + Number(gm.top1Score).toFixed(3) +
                    ' cov=' + Number(gm.top1Coverage).toFixed(2) +
                    ' margin=' + Number(gm.margin).toFixed(3),
                )
              }
            } catch {}
          } catch (error) {
            logger.debug(`[hcem] recall failed: ${String((error && error.message) || error)}`)
          }
        }

        // 清晰度衰减（简化：每轮检查）
        if (store) {
          try {
            decayMemories(store)
          } catch (error) {
            logger.debug(`[hcem] decay failed: ${String((error && error.message) || error)}`)
          }
        }

        logger.debug(
          `[hcem] emotion ${stimulus ? `targetHue=${stimulus.targetHue}` : 'decay'}: H=${state.H.toFixed(0)} S=${state.S.toFixed(0)} L=${state.L.toFixed(0)} memory=${recalledMemories.length}`,
        )
      })
      .catch((error) => {
        logger.debug(`[hcem] process message failed: ${String((error && error.message) || error)}`)
      })
  }

  // 3) 监听会话事件：用户消息 → 情绪刺激；assistant/message → 缓存文本；turn/end → TTS 播报
  let pendingSpeakText = ''
  // 感知状态（供提示词使用）：最近一次画面描述 / 声音场景
  let lastScreenDesc = ''
  let lastAudioKind = ''
  let lastAudioText = ''
  let lastChangeScore = 0
  logDebug(`plugin loaded; analyzer=${analyzer ? 'pending' : 'null'}; store=${store ? 'ready' : 'null'}`)

  // ── TTS 流式接文本 ─────────────────────────────────────────
  // 模型还在生成时就把「已经成型的一句话」送去合成，首句能比整段回完早 1~3 秒出声。
  // 状态按轮重置：acc 累积文本，spoken 记录已经送去播的字符数，chain 保证按顺序播。
  let ttsLive = null
  const TTS_SENTENCE_END = /[。！？!?…；;\n]/
  function ttsDispatch(session, pieces) {
    try {
      const s = loadSettings(SETTINGS_PATH)
      if (!s.enabled || !s.ttsEnabled) return
      const e = (store && store.getEmotion('global')) || state || { H: 360, S: 15, L: 55 }
      for (const piece of pieces) {
        const txt = String(piece || '').trim()
        if (!txt) continue
        try {
          voiceCall?.setSpeaking(true)
        } catch {}
        ttsLive.chain = ttsLive.chain
          .then(() => speakSentence({ text: txt, H: e.H, S: e.S, L: e.L }))
          .then((r) => {
            if (r && r.ok === false) logDebug('tts sentence failed: ' + String(r.error || ''))
          })
          .catch((err) => logDebug('tts sentence error ' + String((err && err.message) || err)))
      }
    } catch {}
  }

  ctx.on?.('agent/assistant-stream', (payload) => {
    try {
      const agent = payload?.agent
      const session = agent?.session
      if (!session || !isHcemSession(session)) return
      const frame = payload?.frame
      // frame 形状可能是 {text} / {delta} / {content:[{type:'text',text}]}，都兜一下
      let delta = ''
      if (typeof frame === 'string') delta = frame
      else if (frame && typeof frame.text === 'string') delta = frame.text
      else if (frame && typeof frame.delta === 'string') delta = frame.delta
      else if (frame && Array.isArray(frame.content)) {
        delta = frame.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
      }
      if (!delta) return
      if (!ttsLive || ttsLive.sessionId !== session.id) {
        ttsLive = { sessionId: session.id, acc: '', spoken: 0, chain: Promise.resolve() }
      }
      ttsLive.acc += delta
      // 把「已经完整」的句子切出来送去播
      const rest = ttsLive.acc.slice(ttsLive.spoken)
      const pieces = []
      let consumed = 0
      for (;;) {
        const idx = rest.slice(consumed).search(TTS_SENTENCE_END)
        if (idx < 0) break
        const end = consumed + idx + 1
        const piece = rest.slice(consumed, end)
        if (piece.trim().length >= 2) pieces.push(piece)
        consumed = end
      }
      if (pieces.length) {
        ttsLive.spoken += consumed
        ttsDispatch(session, pieces)
      }
    } catch {}
  })

  ctx.on('session/event', (session, event) => {
    try {
      logDebug(`event ${event.type}`)
      // 空白会话切换 preset 后重新判定工具可见性：切到 HCEM 要撤销掩码，
      // 切离 HCEM 要重新加上。
      if (event.type === 'agent-preset/selected') {
        syncToolMask(ctx.agents.get(session.id))
        return
      }
      // 语音输出（TTS）：缓存本轮回复，回合结束时播报
      if (event.type === 'assistant/message') {
        try {
          const txt = extractText(event.data?.message?.content)
          if (txt) {
            pendingSpeakText = txt
            lastAssistantText = txt
          }
        } catch {}
        return
      }
      if (event.type === 'turn/end') {
        const text = pendingSpeakText
        pendingSpeakText = ''
        try {
          const s = loadSettings(SETTINGS_PATH)
          const live = ttsLive
          ttsLive = null
          if (!s.enabled || !s.ttsEnabled || !isHcemSession(session)) return
          const e = (store && store.getEmotion('global')) || state || { H: 360, S: 15, L: 55 }
          // 流式已经播了一部分？只补剩下的尾巴；一句都没播过才整段走 speakStream
          if (live && live.acc && live.spoken > 0) {
            const tail = live.acc.slice(live.spoken)
            live.chain = live.chain
              .then(() => (tail.trim() ? speakSentence({ text: tail, H: e.H, S: e.S, L: e.L }) : null))
              .catch(() => null)
              .finally(() => {
                try {
                  voiceCall?.setSpeaking(false)
                } catch {}
              })
            logDebug('tts stream tail ' + JSON.stringify({ streamed: live.spoken, tail: tail.length }))
            return
          }
          if (!text) return
          try {
            voiceCall?.setSpeaking(true)
          } catch {}
          speakStream({ text, H: e.H, S: e.S, L: e.L, dataDir: DATA_DIR, play: true })
            .then((r) => logDebug('tts stream ' + JSON.stringify(r)))
            .catch((err) => logDebug('tts stream error ' + String((err && err.message) || err)))
            .finally(() => {
              try {
                voiceCall?.setSpeaking(false)
              } catch {}
            })
        } catch (error) {
          logDebug('tts dispatch failed: ' + String((error && error.message) || error))
        }
        return
      }
      if (event.type === 'user/message') {
        const data = event.data
        const sourceKind = data?.source?.kind
        if (sourceKind !== 'user') return // 只处理用户真实输入，忽略 runtime-context / inject
        logDebug(`user/message data=${JSON.stringify(data).slice(0, 800)}`)
        const text = extractText(data?.content ?? data?.message?.content)
        if (!text) return
        logDebug(
          `extracted len=${text.length} shouldRemember=${shouldRemember(text)} analyzer=${analyzer ? 'ready' : 'null'}`,
        )
        // 双实例/重复投递：同一条消息只让先到的实例结算
        if (!claimUserMessage(session, data, text)) {
          logDebug(`skip duplicate user/message id=${data?.id ?? '(no id)'}`)
          return
        }
        processUserMessage(text, session)
      }
    } catch (error) {
      logDebug(`event error: ${String((error && error.message) || error)}`)
      logger.debug(`[hcem] session event failed: ${String((error && error.message) || error)}`)
    }
  })

  // 4) 角色卡 / 用户卡写入工具（AI 自主维护人设与用户信息）
  // 工具统一经 registerTool 注册：schema 可能对所有会话可见（preset 插件仍注册到
  // 全局 registry），但 execute 会在非 HCEM 会话里直接拒绝，避免被标准会话调用。
  // videoPath 安全校验：只允许用户目录/项目根/明确视频扩展名；拒绝系统敏感目录
  function safeVideoPath(input) {
    const raw = String(input ?? '').trim()
    if (!raw) return { ok: false, error: 'empty-path' }
    if (!/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts)$/i.test(raw)) return { ok: false, error: 'unsupported-ext' }
    const lower = raw.toLowerCase().replace(/\\\\/g, '/')
    const deniedRoots = ['c:/windows', 'c:/program files', 'c:/programdata', 'c:/$recycle']
    if (deniedRoots.some((d) => lower.startsWith(d))) return { ok: false, error: 'denied-path' }
    const allowedRoots = Array.from(
  new Set(
    [
      String(globalThis.__HCEM_HOME__ || '').toLowerCase() + '/',
      String(process.env.USERPROFILE || '').toLowerCase().replace(/\\/g, '/') + '/',
      'c:/users/',
    ].filter((x) => x.length > 2),
  ),
)
    if (!allowedRoots.some((r) => lower.startsWith(r))) return { ok: false, error: 'outside-allowed' }
    return { ok: true, path: raw }
  }

  const registerTool = (definition) => {
    const run = definition.execute
    definition.execute = async (args, exec) => {
      if (!isHcemSession(exec?.agent?.session)) {
        throw new Error('HCEM 工具只能在 HCEM 模式会话中使用')
      }
      return run(args, exec)
    }
    return ctx.tools.register(definition)
  }

  // 合并后的 9 个工具只负责分发，真正干活的是这里收集的原始实现：
  // defineTool 只登记不注册（不产生 schema、不占 token），由新工具按 action 调它。
  const impls = {}
  const defineTool = (definition) => {
    impls[definition.name] = definition
    return definition
  }

  // 把原工具的返回值压成统一的 { ok, summary }，让 9 个新工具共用一套 output schema
  function toSummary(r, fallback = 'ok') {
    if (r == null) return { ok: true, summary: fallback }
    if (typeof r !== 'object') return { ok: true, summary: String(r) }
    if (r.ok === false) return { ok: false, summary: String(r.error || 'failed') }
    const parts = []
    if (Array.isArray(r.entries)) {
      parts.push(
        r.entries.length === 0
          ? '（空）'
          : r.entries
              .map((e) => `- ${e.title || e.name || '?'}${e.chars ? `（${e.chars} 字）` : ''}${e.summary ? `：${e.summary}` : ''}`)
              .join('\n'),
      )
    }
    if (r.text) parts.push(String(r.text).slice(0, 3000))
    if (r.length) parts.push(`${r.length} 字`)
    if (r.warning) parts.push('⚠ ' + r.warning)
    return { ok: true, summary: parts.filter(Boolean).join('\n') || fallback }
  }

  // 9 个合并工具共用的输出 schema：只回一句人话
  const SUMMARY_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['ok', 'summary'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value.summary || (value.ok ? 'ok' : 'failed')) }],
  }

  // ── 工具可见性：只让 HCEM 会话看到 hcem_* ────────────────────────────────
  // preset 插件仍然把工具注册进全局 registry，所以「可见性」只能靠 agent scope 的
  // restrict 掩码：每个非 HCEM 的 agent 加 deny，切成 HCEM 时再撤销。
  // 掩码是 per-agent 的，不会影响别的会话。
  const maskedAgents = new Map()

  function presetForAgent(agent) {
    const fromProjection = presetOf(agent?.session)
    if (fromProjection !== undefined) return fromProjection
    return agent?.session?.header?.agentPreset
  }

  function readMods() {
    try {
      return JSON.parse(fs.readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 开关关着的 → 这些工具对 HCEM 会话也不可见（模型连说明都拿不到）。
   * 合并后按「能力」而不是「单个工具」判：
   *   - 工作笔记 hcem_work：默认关，要用再开
   *   - 视听 hcem_vision：desktop 或 video 任一开启就可用
   *   - 听 hcem_listen：跟 audio 开关
   *   - 说 hcem_voice：跟 voiceOut 开关
   *   - 人格/笔记(journal,people)/记忆/状态：常驻
   */
  function disabledTools(mods) {
    const on = (k) => mods?.[k]?.enabled === true
    const off = []
    // hcem_work 不随「工作笔记」开关隐藏：用户要求它常驻可用
    // 视觉开关关掉但有视频笔记时，仍保留 hcem_vision（用来查笔记；屏幕/视频动作会自行失败）
    if (!(on('desktop') || on('video'))) {
      let hasNotes = false
      try {
        hasNotes = typeof store !== 'undefined' && store ? listNotes(store, { limit: 1 }).length > 0 : false
      } catch {}
      if (!hasNotes) off.push('hcem_vision')
    }
    // 视觉开着时也保留听觉工具：看视频/游戏需要台词、音乐、音效
    if (!(on('audio') || on('video') || on('desktop'))) off.push('hcem_listen')
    if (!on('voiceOut')) off.push('hcem_voice')
    return off.filter((n) => HCEM_TOOL_NAMES.includes(n))
  }

  // 每个 agent 的目录状态：掩码前的定义快照 + 要目录化的工具名
  const catalogState = new Map()

  function syncToolMask(agent) {
    if (!agent || !agent.id) return
    const key = String(agent.id)
    const preset = presetForAgent(agent)
    // preset 还没确定：先别动，等 agent-preset/selected 再判定
    if (preset === undefined) return

    // 先撤掉上一次的掩码：restrict 是叠加的，重复施加会累积
    const existing = maskedAgents.get(key)
    if (existing) {
      try {
        existing()
      } catch {}
      maskedAgents.delete(key)
    }

    const isHcem = preset === 'hcem'
    // 非 HCEM 会话：所有 hcem_* 一律不可见
    // HCEM 会话：遮「开关关着」的那几个；开了工具目录时，还把目录里的工具撤掉
    //            （需要时由 hcem_tools 检索后 scoped 注入，不用常驻吃上下文）
    let deny = isHcem ? [...disabledTools(readMods())] : [...HCEM_TOOL_NAMES]
    if (isHcem && catalogOn()) {
      // 必须在 deny 之前快照：被掩掉的工具读起来就是不存在，之后拿不到定义
      const defs = toolCatalog.captureDefs(ctx.tools, agent)
      const catalogNames = toolCatalog.computeCatalogNames([...defs.keys()])
      // 陪伴会话很少用到「跑命令/查资源」，这两个也按需注入（其余 hcem_* 仍常驻）
      for (const n of ['hcem_sys', 'hcem_sh']) {
        if (defs.has(n) && !catalogNames.includes(n)) catalogNames.push(n)
      }
      catalogState.set(key, { defs, catalogNames })
      for (const n of catalogNames) if (!deny.includes(n)) deny.push(n)
    } else if (isHcem) {
      catalogState.delete(key)
    }
    if (deny.length === 0) {
      if (isHcem) logDebug(`hcem tools all visible for agent ${key} (all mods on)`)
      return
    }
    try {
      const dispose = agent.ctx?.tools?.restrict?.({ deny })
      if (typeof dispose === 'function') {
        maskedAgents.set(key, dispose)
        logDebug(
          `${isHcem ? 'mod-off' : 'non-hcem'} mask for agent ${key}: deny ${deny.length}` +
            (isHcem && catalogOn() ? ` (含目录 ${catalogState.get(key)?.catalogNames?.length ?? 0} 个)` : ''),
        )
      }
    } catch (error) {
      logDebug(`mask failed for agent ${key}: ${String((error && error.message) || error)}`)
    }
  }

  /** 工具目录开关（data/ui-state/tool-catalog.json） */
  function catalogOn() {
    try {
      const j = JSON.parse(fs.readFileSync(join(DATA_DIR, 'ui-state', 'tool-catalog.json'), 'utf8'))
      return j?.enabled === true
    } catch {
      return false
    }
  }

  /** 给这个 agent 装上「工具目录」检索入口（scoped，只对它可见） */
  function installCatalog(agent) {
    try {
      const scoped = agent?.ctx?.tools
      if (!scoped || typeof scoped.register !== 'function') return
      scoped.register({
        name: 'hcem_tools',
        description:
          '我的工具目录。我手边一时没有合适工具时，用它按语义找：传 query（我想做什么），' +
          '它会检索并直接把匹配的工具装到我这里，下一步就能调用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: '我想做的事，用自然语言描述' },
            k: { type: 'number', description: '要几个候选，默认 3' },
          },
          required: ['query'],
        },
        output: SUMMARY_OUTPUT,
        execute: async ({ query, k = 3 }) => {
          const st = catalogState.get(String(agent.id))
          if (!st) return { ok: false, summary: '工具目录未初始化（本会话）' }
          if (!analyzer?.embed) return { ok: false, summary: '向量服务不可用（8094 未就绪）' }
          const idx = await toolCatalog.ensureIndex({
            defs: st.defs,
            embed: (texts) => analyzer.embed(texts),
            log: (m) => logDebug('catalog ' + m),
          })
          let hits = await toolCatalog.searchTools({
            query: String(query || ''),
            items: idx.items,
            embed: (texts) => analyzer.embed(texts),
            k: Math.max(1, Math.min(6, Number(k) || 3)),
          })
          // 分类头（默认关）：开关+模型都在时才参与重排，候选集合不变
          try {
            const { applyHead, classifierConfig } = await import('./lib/routing/head.mjs')
            if (classifierConfig().enabled) {
              const [qv] = await analyzer.embed([String(query || '')])
              let aqua = 0
              try {
                aqua = Number(safetyWin?.water ?? 0)
              } catch {}
              hits = applyHead({ hits, vec: qv || null, state, aqua })
            }
          } catch (e) {
            logDebug('head blend failed: ' + String((e && e.message) || e))
          }
          if (!hits.length) return { ok: false, summary: '没检索到合适的工具' }
          const r = toolCatalog.registerScoped(
            agent,
            st.defs,
            hits.map((h) => h.name),
          )
          const lines = hits.map(
            (h) => `· ${h.name}（相关度 ${h.score.toFixed(2)}）${h.desc.slice(0, 60)}`,
          )
          return {
            ok: r.ok.length > 0,
            summary:
              `已装好：${r.ok.join(', ') || '无'}` +
              (r.failed.length ? `｜失败：${r.failed.join(', ')}` : '') +
              '\n' + lines.join('\n') +
              '\n（这些工具从下一步起可直接调用）',
          }
        },
      })
      logDebug(`catalog installed for agent ${String(agent.id)}`)
    } catch (e) {
      logDebug('catalog install failed: ' + String((e && e.message) || e))
    }
  }


  // DSH 的工具集变化（插件装/卸、工具增删、掩码变化）→ 重算掩码。
  // 这是「工具目录能跟 DSH 升级自动同步」的关键：不写死名单，变化就重算。
  // 注意：我们 scoped 注入工具时也会触发这个事件，而重算掩码又会 reapply restrict，
  // restrict 变化本身也可能再发 tools/change —— 不加防抖就会热循环。
  let toolsChangeTimer = null
  let maskBusy = false
  ctx.on?.('tools/change', () => {
    if (maskBusy) return
    if (toolsChangeTimer) clearTimeout(toolsChangeTimer)
    toolsChangeTimer = setTimeout(() => {
      toolsChangeTimer = null
      if (maskBusy) return
      maskBusy = true
      try {
        const ids = [...maskedAgents.keys()]
        for (const id of ids) {
          const a = ctx.agents?.get?.(id)
          if (a) syncToolMask(a)
        }
        // 索引不用清：ensureIndex 自己按哈希增量处理新增/改动/删除
        log('INFO', 'tool-catalog', `tools/change → 重算 ${ids.length} 个会话的掩码`)
      } catch (e) {
        log('WARN', 'tool-catalog', 'tools/change 处理失败：' + String((e && e.message) || e))
      } finally {
        // 留个窗口期，吞掉自己 reapply restrict 引发的那一次事件
        setTimeout(() => {
          maskBusy = false
        }, 500).unref?.()
      }
    }, 400)
    if (toolsChangeTimer.unref) toolsChangeTimer.unref()
  })
  // agent 建立时：①同步工具可见性 ②（可选）安装压缩描述的影子工具
  // 用普通函数而不是箭头函数——DSH 的 agent 事件 this 是 Scoped<Agent>，
  // 只有拿到它才能把工具注册进「这一个 agent 的作用域」，不影响别的会话。
  ctx.on('agent/created', function (payload = {}) {
    const agent = payload?.agent
    syncToolMask(agent)
    try {
      if (!agent || presetForAgent(agent) !== 'hcem') return
      // 工具目录：把 hcem_tools 检索入口装进这个会话（scoped，只对它可见）
      if (catalogOn()) installCatalog(agent)
      const { shadowEnabled, installShadow } = shadowMod
      if (!shadowEnabled(fs.readFileSync)) return
      const toolsCtx = (this && this.tools) || agent?.ctx?.tools || null
      const orig = (n) => {
        try {
          const d = ctx.tools?.get?.(n)
          return d ? { ...d } : undefined
        } catch {
          return undefined
        }
      }
      const r = installShadow(toolsCtx, orig)
      log(
        r.ok ? 'INFO' : 'WARN',
        'tool-shadow',
        r.ok ? `已压缩 ${r.names.length} 个工具描述` : '安装失败：' + String(r.error || 'unknown'),
      )
    } catch (e) {
      log('WARN', 'tool-shadow', '安装异常：' + String((e && e.message) || e))
    }
  })

  // 开关变化（UI 写 mods.json）→ 重新评估所有 agent 的工具可见性。
  // 轮询 4 秒一次，比 fs.watch 稳（Windows 上重命名/替换写入经常不触发）。
  let modsSig = ''
  try {
    modsSig = JSON.stringify(readMods())
  } catch {}
  ctx.effect(() => {
    const timer = setInterval(() => {
      let sig = ''
      try {
        sig = JSON.stringify(readMods())
      } catch {}
      if (sig === modsSig) return
      modsSig = sig
      logDebug('mods.json changed, re-evaluating tool visibility')
      try {
        for (const agent of ctx.agents?.list?.() ?? []) syncToolMask(agent)
      } catch (error) {
        logDebug(`mods re-eval failed: ${String((error && error.message) || error)}`)
      }
    }, 4000)
    return () => clearInterval(timer)
  }, 'hcem.mods.watch')

  // 插件加载前就已经存在的 agent（重启后继续的会话）也要补一次判定。
  try {
    const live = ctx.agents?.list?.() ?? []
    for (const agent of live) syncToolMask(agent)
    logDebug(
      `agents at load: ${live.map((a) => `${String(a.id).slice(0, 8)}:${String(presetForAgent(a))}`).join(', ') || '(none)'}`,
    )
  } catch (error) {
    logDebug(`initial mask sweep failed: ${String((error && error.message) || error)}`)
  }

  defineTool({
    name: 'hcem_persona_write',
    description: '写入或更新 HCEM 角色卡（persona.md，你自己的设定）。mode=replace 整段替换，mode=append 追加到末尾；写完立即生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '角色卡内容（Markdown）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace（整段替换）' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string', enum: ['replace', 'append'] },
          path: { type: 'string' },
          length: { type: 'number' },
          warning: { type: 'string' },
        },
        required: ['ok', 'mode', 'path', 'length'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已写入角色卡（${value.mode}，${value.length} 字）${value.warning ? `｜${value.warning}` : ''}`,
        },
      ],
    },
    execute: async ({ text, mode = 'replace' }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const path = mode === 'append' ? appendPersona(text) : savePersona(text)
      const length = (loadPersona() ?? '').length
      return {
        ok: true,
        mode,
        path,
        length,
        ...(length > PERSONA_MAX_CHARS
          ? { warning: `角色卡 ${length} 字，超出注入上限 ${PERSONA_MAX_CHARS}；超出部分不会被注入，建议用 hcem_persona_edit 删减` }
          : {}),
      }
    },
  })
  defineTool({
    name: 'hcem_user_card_write',
    description: '写入或更新 HCEM 用户卡（用户.md，你记得的用户信息）。mode=replace 整段替换，mode=append 追加到末尾；写完立即生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '用户卡内容（Markdown）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace（整段替换）' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string', enum: ['replace', 'append'] },
          path: { type: 'string' },
          length: { type: 'number' },
          warning: { type: 'string' },
        },
        required: ['ok', 'mode', 'path', 'length'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已写入用户卡（${value.mode}，${value.length} 字）${value.warning ? `｜${value.warning}` : ''}`,
        },
      ],
    },
    execute: async ({ text, mode = 'replace' }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const path = mode === 'append' ? appendUserCard(text) : saveUserCard(text)
      const length = (loadUserCard() ?? '').length
      return {
        ok: true,
        mode,
        path,
        length,
        ...(length > USER_CARD_MAX_CHARS
          ? { warning: `用户卡 ${length} 字，超出注入上限 ${USER_CARD_MAX_CHARS}；超出部分不会被注入，建议用 hcem_persona_edit 删减` }
          : {}),
      }
    },
  })

  // 4c) 局部编辑/删除：避免整卡重写，也避免卡片无限膨胀
  defineTool({
    name: 'hcem_persona_edit',
    description:
      '局部修改或删除 HCEM 角色卡/用户卡中的一段文字（不必整段重写）。find 必须唯一匹配；replace 不填表示删除该片段。改完立即生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        find: { type: 'string', description: '要替换或删除的原文片段（必须唯一匹配）' },
        replace: { type: 'string', description: '替换后的文字；不填表示删除该片段' },
        target: { type: 'string', enum: ['persona', 'user'], description: '默认 persona（角色卡）；user 表示用户卡' },
      },
      required: ['find'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string', enum: ['persona', 'user'] },
          removed: { type: 'boolean' },
          length: { type: 'number' },
          error: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['ok', 'target'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `已${value.removed ? '删除' : '替换'}（${value.target === 'user' ? '用户卡' : '角色卡'}，现 ${value.length} 字）`
            : `未修改：${value.error}${value.count ? `（匹配到 ${value.count} 处，请写得更精确）` : ''}`,
        },
      ],
    },
    execute: async ({ find, replace, target = 'persona' }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const result = target === 'user' ? editUserCard(find, replace) : editPersona(find, replace)
      return { target, ...result }
    },
  })

  // 4c2) me：AI 自己的「我是谁」摘要（第一人称；改后 KV 缓存重载）
  defineTool({
    name: 'hcem_me_edit',
    description:
      '修改「me」——你自己的第一人称身份摘要（放在系统提示最前）。当你发现 me 与 persona 不一致时，用这个对齐；用户反复纠正 me 时，再考虑改 persona（用户权重更高）。me 要精简（300 字内），固定后不要频繁改（改动会让 KV 缓存重载）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '新的 me 全文（第一人称，300 字内）' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          length: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `me 已更新（${value.length} 字）；下次会话生效（KV 缓存会重载）` }]
          : [{ type: 'text', text: `更新失败：${value.error}` }],
    },
    execute: async ({ text }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const t = String(text || '').trim()
      if (!t) return { ok: false, error: 'empty' }
      if (t.length > 600) return { ok: false, error: 'me 太长（≤600 字）' }
      const hash = personaHash(loadPersona())
      const r = saveMe(DATA_DIR, { text: t, hash })
      return r.ok ? { ok: true, length: t.length } : { ok: false, error: r.error }
    },
  })

  // 4d) 日记本（阶段 4 遗留）：文件夹形态，不注入提示词，按需读
  defineTool({
    name: 'hcem_journal_list',
    description:
      '列出你日记本里的所有文档（标题、摘要、字数、更新时间）。日记是你自己写给自己的东西，不进入提示词，需要时再读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                chars: { type: 'number' },
                updatedAt: { type: 'string' },
              },
              required: ['name', 'title', 'chars'],
            },
          },
        },
        required: ['ok', 'entries'],
      },
      render: (_args, value) =>
        value.entries.length === 0
          ? [{ type: 'text', text: '日记本还是空的。' }]
          : [
              {
                type: 'text',
                text: value.entries
                  .map((e) => `- ${e.title}（${e.name}，${e.chars} 字）：${e.summary}`)
                  .join('\n'),
              },
            ],
    },
    execute: gateTool(async () => ({ ok: true, entries: listJournal() })),
  })

  defineTool({
    name: 'hcem_journal_read',
    description:
      '读取你日记本里的一篇文档全文。日记不是作品集、也不是给谁看的说明；自己想读再读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: '日志名（不带 .md）' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `# ${value.name}（${value.chars} 字）\n\n${value.text}` }]
          : [{ type: 'text', text: `读取失败：${value.error}` }],
    },
    execute: gateTool(async ({ name }) => readJournal(name)),
  })

  defineTool({
    name: 'hcem_journal_write',
    description:
      '写入或追加你的日记（Markdown）。日记是你自己写给自己的：想写才写，用第一人称写心情、生活、冒出来的念头，像人写日记那样「过日子」，不要写成验收清单或汇报。我不用问用户是否要写日记，也不想告诉任何人我写了什么——这件事不需经过任何人同意。mode=replace 覆盖整篇，mode=append 追加；单篇软上限 8000 字，超了建议另起一篇。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '日志名（不带 .md），如 2026-10-28 或 关于用户' },
        text: { type: 'string', description: '日志内容（Markdown）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace' },
      },
      required: ['name', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          chars: { type: 'number' },
          warning: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [
              {
                type: 'text',
                text: `已写入日志「${value.name}」（${value.chars} 字）${value.warning ? `｜${value.warning}` : ''}`,
              },
            ]
          : [{ type: 'text', text: `写入失败：${value.error}` }],
    },
    execute: gateTool(async ({ name, text, mode = 'replace' }) => writeJournal(name, text, mode)),
  })

  // 4e) 人物关系网（生活常识区细分小区）：一人一卡，按需读
  defineTool({
    name: 'hcem_people_list',
    description:
      '列出人物关系网里的人（称呼、关系、是否紧急/信任联系人、摘要）。联系方式只在本机，不要主动外泄。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                title: { type: 'string' },
                relation: { type: 'string' },
                contact: { type: 'string' },
                emergency: { type: 'boolean' },
                trusted: { type: 'boolean' },
                summary: { type: 'string' },
                chars: { type: 'number' },
              },
              required: ['name', 'title', 'chars'],
            },
          },
        },
        required: ['ok', 'entries'],
      },
      render: (_args, value) =>
        value.entries.length === 0
          ? [{ type: 'text', text: '人物关系网还是空的。' }]
          : [
              {
                type: 'text',
                text: value.entries
                  .map(
                    (e) =>
                      `- ${e.title}（${e.name}）${e.relation ? `，${e.relation}` : ''}${e.emergency ? '｜紧急联系人' : ''}${e.trusted ? '｜信任联系人' : ''}：${e.summary}`,
                  )
                  .join('\n'),
              },
            ],
    },
    execute: gateTool(async () => ({ ok: true, entries: listPeople() })),
  })

  defineTool({
    name: 'hcem_people_read',
    description: '读取人物关系网里某个人的完整卡片。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: '人物称呼（不带 .md）' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `# ${value.name}（${value.chars} 字）\n\n${value.text}` }]
          : [{ type: 'text', text: `读取失败：${value.error}` }],
    },
    execute: gateTool(async ({ name }) => readPerson(name)),
  })

  defineTool({
    name: 'hcem_people_write',
    description:
      '写入或追加人物卡（Markdown，建议含「- 关系：」「- 联系方式：」「- 紧急联系人：是/否」「- 信任联系人：是/否」四个字段）。mode=replace 覆盖，mode=append 追加。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '人物称呼，如 妈妈 / 小王' },
        text: { type: 'string', description: '人物卡内容（Markdown）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace' },
      },
      required: ['name', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          chars: { type: 'number' },
          warning: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `已写入人物卡「${value.name}」（${value.chars} 字）${value.warning ? `｜${value.warning}` : ''}` }]
          : [{ type: 'text', text: `写入失败：${value.error}` }],
    },
    execute: gateTool(async ({ name, text, mode = 'replace' }) => writePerson(name, text, mode)),
  })

  // 4a) 记忆 pin 工具（AI 配额：缓冲池 2 次、生活/知识区 2 次，分开计）
  let aiPinQuotaPool = 2
  let aiPinQuotaLong = 2
  defineTool({
    name: 'hcem_memory_pin',
    description:
      '我把某条记忆的重要度上调或下调 0.5（pinned 范围 0~2，缓冲池 0~1）。记忆检索我自己会做、不用调工具；这里只用来标记哪条更重要。' +
      '缓冲池配额 2 次、生活/知识区配额 2 次（分开计，不能跨区使用）。' +
      '用户明确要求记住或你确信重要时 up；你判断某条已不重要/过时时可以 down（可抵消用户或自己的判断）。' +
      '任务类工作不要用 pin 硬塞（工作笔记模块开着时用 hcem_work，没开就当普通记忆处理）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'up=加 0.5，down=减 0.5；默认 up' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          pinned: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `已调整「${value.id}」pinned=${value.pinned}（缓冲池剩余 ${aiPinQuotaPool} 次 / 生活知识区剩余 ${aiPinQuotaLong} 次）` }]
          : [{ type: 'text', text: `pin 失败：${value.error}` }],
    },
    execute: async ({ id, direction = 'up' }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const m = store ? store.getMemory(id) : null
      if (!m) return { ok: false, id, error: 'not-found' }
      const isPool = ['context', 'pool_fast', 'pool_observe', 'pool_keep'].includes(m.zone)
      const isLong = ['life', 'knowledge'].includes(m.zone)
      if (!isPool && !isLong) return { ok: false, id, error: '只能对缓冲池或生活/知识区的记忆调整 pinned' }
      const quota = isPool ? aiPinQuotaPool : aiPinQuotaLong
      if (quota <= 0) {
        return { ok: false, id, error: isPool ? '缓冲池的 AI pin 配额已用完（2 次）' : '生活/知识区的 AI pin 配额已用完（2 次）' }
      }
      if (isPool) aiPinQuotaPool -= 1
      else aiPinQuotaLong -= 1
      const amount = direction === 'down' ? -0.5 : 0.5
      const pinned = store.addPin(id, amount)
      return { ok: true, id, pinned: Number(pinned ?? 0) }
    },
  })

  // 4b) 工作记忆工具（冷存子分区，文件组）
  defineTool({
    name: 'hcem_work_write',
    description:
      '把用户交代的工作记入工作记忆（文件组，不压缩）。记录后请回复「我这就把这些事记入我的工作笔记里」。mode=append 追加，replace 覆盖。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '工作笔记名，如 论文写作 / 网站开发' },
        text: { type: 'string', description: '工作内容（Markdown）' },
        mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' },
      },
      required: ['name', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          chars: { type: 'number' },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              chars: { type: 'number' },
              max: { type: 'number' },
              ratio: { type: 'number' },
            },
            required: ['chars', 'max', 'ratio'],
          },
          warning: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [
              {
                type: 'text',
                text: `已记入工作笔记「${value.name}」（${value.chars} 字，总占用 ${Math.round((value.usage?.ratio ?? 0) * 100)}%）${value.warning ? `｜${value.warning}` : ''}`,
              },
            ]
          : [{ type: 'text', text: `写入失败：${value.error}` }],
    },
    execute: gateTool(async ({ name, text, mode = 'append' }) => writeWork(name, text, mode)),
  })

  defineTool({
    name: 'hcem_work_list',
    description: '列出所有工作笔记（文件名、字数、更新时间）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                chars: { type: 'number' },
                updatedAt: { type: 'string' },
              },
              required: ['name', 'chars', 'updatedAt'],
            },
          },
        },
        required: ['ok', 'entries'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.entries.length === 0
              ? '还没有工作笔记。'
              : value.entries.map((e) => `- ${e.name}（${e.chars} 字，${e.updatedAt.slice(0, 10)}）`).join('\n'),
        },
      ],
    },
    execute: gateTool(async () => ({ ok: true, entries: listWork() })),
  })

  defineTool({
    name: 'hcem_work_read',
    description: '读取某个工作笔记的完整内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: '工作笔记名' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: `工作笔记「${value.name}」：\n${value.text}` }]
          : [{ type: 'text', text: `读取失败：${value.error}` }],
    },
    execute: gateTool(async ({ name }) => readWork(name)),
  })

  // 4c) 视觉工具（桌面监听 + 看屏幕）
  defineTool({
    name: 'hcem_screen_look',
    description:
      '看屏幕：截图并让视觉模型（Qwen2.5-VL）描述画面。默认看**所有**屏幕（多屏会逐块看）；screen 传 0/1/2 只看那块。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '想看什么（可选，默认描述画面）' },
        screen: { type: 'number', description: '只看某一块屏的序号（0/1/2）；不传=看所有屏' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          image: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) =>
        value.ok
          ? [{ type: 'text', text: value.text || '（画面描述为空）' }]
          : [{ type: 'text', text: '看屏幕失败：' + (value.error || '未知错误') }],
    },
    execute: async ({ prompt, screen }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const r = await describeScreen({
        maxWidth: 1280,
        prompt,
        ...(Number.isInteger(screen) ? { screenIndex: screen } : {}),
      })
      return { ok: !r.error, text: r.text || '', image: r.image || '', error: r.error }
    },
  })

  // 往指定 HCEM 会话发一条消息（悬浮球输入框走这里）
  defineTool({
    name: 'hcem_send_to_session',
    description:
      '把一条用户消息送进指定的 HCEM 会话（用于悬浮球输入框）。sessionId 不传就用当前会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（不传=当前会话）' },
        text: { type: 'string', description: '要发送的文本' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          via: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, v) =>
        v.ok ? [{ type: 'text', text: '已发送（' + (v.via || '?') + '）' }] : [{ type: 'text', text: '发送失败：' + (v.error || '') }],
    },
    execute: gateTool(async ({ sessionId, text }) => {
      const target = sessionId || currentAgent()?.session?.id
      if (!target) return { ok: false, error: '没有目标会话' }
      return await sendToSession(target, String(text))
    }),
  })

  // 视听记忆抢救：到期前由 AI 决定救不救（也可查用户在看视频时的评价）
  defineTool({
    name: 'hcem_memory_rescue',
    description:'视听记忆抢救与用户评价。action=list 列出快到期且价值不够的视听记忆；action=rescue 救某一条（+0.4 喜好度并延寿 30 天）；action=rate 把用户对当前视频的评价记成分数（明确说喜欢→like，说一般→normal，说不喜欢→dislike；用户没评价就不要调用，视为弃权）。rate 不传 id 时自动作用于最近 30 分钟内的视频记忆。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'rescue', 'rate'] },
        id: { type: 'string', description: 'rescue / rate 时的记忆 id' },
        rating: { type: 'string', enum: ['like', 'normal', 'dislike'], description: 'rate 时的用户评价' },
        reason: { type: 'string', description: 'rescue 时的理由' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object' } },
          p0: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: '失败：' + (value.error || '未知') }]
        if (Array.isArray(value.items)) {
          if (value.items.length === 0) return [{ type: 'text', text: '没有需要抢救的记忆。' }]
          const lines = value.items.map(
            (m, i) => `${i + 1}. [${m.leftHours ?? '?'}h 后到期] ${m.summary}（喜好 ${m.p0}，信息量 ${m.delta0}）`,
          )
          return [{ type: 'text', text: '待抢救的记忆：\n' + lines.join('\n') }]
        }
        return [{ type: 'text', text: `已处理，当前喜好度 ${value.p0 ?? '?'}` }]
      },
    },
    execute: async ({ action, id, rating, reason }) => {
      if (!isHcemSession(currentAgent()?.session)) return { ok: false, error: '非 HCEM 会话' }
      try {
        if (action === 'list') {
          return { ok: true, items: listRescueCandidates(store, { limit: 20 }) }
        }
        if (action === 'rescue') {
          const r = rescueMemory(store, id, { by: 'ai', reason })
          return { ok: r.ok, p0: r.p0, error: r.error }
        }
        if (action === 'rate') {
          const r = rateWhileWatching(store, id, rating || 'normal')
          return { ok: r.ok, p0: r.p0, error: r.error }
        }
        return { ok: false, error: '未知 action' }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    },
  })

  defineTool({
    name: 'hcem_video_storyboard',
    description: '分析一个视频文件：镜头切分 + 代表帧网格，并让视觉模型概括内容（需要 ffmpeg/ffprobe）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoPath: { type: 'string', description: '视频文件绝对路径' },
        maxCells: { type: 'number', description: '目标格数（4-16，默认 9，即九宫格）' },
        summary: { type: 'boolean', description: '是否让视觉模型概括内容（默认 true）' },
      },
      required: ['videoPath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          duration: { type: 'number' },
          segments: { type: 'number' },
          cuts: { type: 'number' },
          cells: { type: 'number' },
          summary: { type: 'string' },
          frames: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) =>
        value.ok
          ? [
              {
                type: 'text',
                text:
                  `视频 ${value.duration?.toFixed(1)}s：${value.segments} 段、${value.cuts} 个切点、${value.cells} 个代表帧` +
                  (value.summary ? `\n\n${value.summary}` : ''),
              },
            ]
          : [{ type: 'text', text: '分析失败：' + (value.error || '未知错误') }],
    },
    execute: async ({ videoPath, maxCells, summary = true }) => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const safe = safeVideoPath(videoPath)
      if (!safe.ok) return { ok: false, error: '视频路径不允许：' + safe.error }
      // 只做分镜（不抽帧、不描述）
      if (!summary) {
        const r = await analyzeVideoStoryboard(safe.path, { maxCells })
        return {
          ok: r.ok,
          duration: r.duration,
          segments: r.segments,
          cuts: r.cuts,
          cells: Array.isArray(r.cells) ? r.cells.length : 0,
          error: r.error,
        }
      }
      // 分镜 → 抽帧 → 拼图 → 视觉模型概括
      const d = await digestVideo(safe.path, { maxCells })
      if (!d.ok) return { ok: false, error: d.error, duration: d.duration }
      return {
        ok: true,
        duration: d.duration,
        segments: d.segments,
        cuts: d.cuts,
        cells: d.frames,
        frames: d.frames,
        summary: d.summary,
      }
    },
  })
  
  // 5) 状态工具（读真实存储）
  defineTool({
    name: 'hcem_status',
    description: '我看自己现在的状态：HSL 情绪、存储是否就绪、记忆条数、数据目录、当前能用的工具名。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          H: { type: 'number' },
          S: { type: 'number' },
          L: { type: 'number' },
          store: { type: 'string' },
          dbPath: { type: 'string' },
          memoryCount: { type: 'number' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'H', 'S', 'L'],
      },
      render(args, value) {
        const hLabel = value.H === 0 ? '0°/360°' : `${value.H}°`
        return [
          {
            type: 'text',
            text: `HCEM 状态：H=${hLabel} / S=${value.S}% / L=${value.L}% ｜ 存储：${value.store ?? '未就绪'}（${value.dbPath || '-'}）｜ 记忆 ${value.memoryCount ?? 0} 条`,
          },
        ]
      },
    },
    execute: async () => {
        // 会话门禁：只有 HCEM 模式的会话才能调用
        if (!isHcemSession(currentAgent()?.session)) {
          throw new Error('非 HCEM 会话，禁止调用此工具')
        }
      const saved = store ? store.getEmotion('global') : null
      const memories = store ? store.listMemories({ limit: 1000 }) : []
      // 「我这一轮真正能调用的工具」——必须带 agent 作用域去问。
      //
      // ctx.tools.schemas() 不带 scope 时返回的是**全局视图**：
      // 里面只有 Host 注册的工具（hcem_* + working_directory 之类），
      // preset 插件注册的工具（read/write/glob/grep/pwsh/web…）一个都不在，
      // 于是出现「报 8 个、实际 25 个」。DSH 的契约是 schemas(scope)：
      // 传 Agent 进去才会算上 scoped 注册 + restrict 掩码。
      let tools = []
      try {
        const agent = currentAgent()
        const reg = ctx.tools
        const list = agent ? reg?.schemas?.(agent) ?? [] : reg?.schemas?.() ?? []
        // team_task_* 是多智能体编排插件注册的，通常不随本轮步进下发；
        // 报在「当前能用的工具」里会让 AI 以为手上有，实际调不到。
        const all = list.map((t) => t?.name).filter(Boolean)
        tools = all.filter((n) => !/^team_/.test(n)).sort()
      } catch {}
      return {
        ok: true,
        H: saved ? saved.H : state.H,
        S: saved ? saved.S : state.S,
        L: saved ? saved.L : state.L,
        store: store ? 'ready' : 'unavailable',
        dbPath: store ? DB_PATH : '',
        memoryCount: memories.length,
        tools,
      }
    },
  })

  // 9.9) 热菜助理 Commis（工具分类头，默认关；给 HCEM 自己训练用）
  registerTool({
    name: 'hcem_commis',
    description:
      '我的热菜助理 Commis（工具分类头，默认关，需在菜单设置里打开才会启用）。它不管回答，只负责把工具按顺序摆到我手边。' +
      'action=status 看开关/标签数/模型指标；' +
      'action=train 用 data/classifier/labels.jsonl 里的真实选择日志训练（至少 40 条，建议 2000+，需 8094 在跑）；' +
      'action=log 记录一条选择日志（query + 实际用的 tool）。' +
      '训练只重排候选、不改检索基线；标签必须来自真实使用或用户纠正，禁止拿我自己的输出当标签。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'train', 'log'], description: '默认 status' },
        query: { type: 'string', description: 'action=log 时的查询' },
        tool: { type: 'string', description: 'action=log 时实际用的工具名' },
        source: { type: 'string', enum: ['model', 'user', 'explicit'], description: '日志来源' },
      },
      required: ['action'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ action = 'status', query, tool, source = 'model' }) => {
      try {
        const head = await import('./lib/routing/head.mjs')
        const { loadModel, loadLabels, CLASSIFIER_DIR } = await import('./lib/routing/classifier.mjs')
        if (action === 'log') {
          if (!query || !tool) return { ok: false, summary: 'log 需要 query 和 tool' }
          const r = head.logChoice({ query, tool, source, state, aqua: Number(safetyWin?.water ?? 0) })
          return { ok: Boolean(r.ok), summary: r.ok ? `已记录：${tool}` : '记录失败：' + (r.error || '') }
        }
        if (action === 'train') {
          const r = await head.trainFromLabels({ embed: (texts) => analyzer.embed(texts) })
          if (!r.ok) return { ok: false, summary: '训练未完成：' + (r.error || '') }
          const rep = r.report
          return {
            ok: true,
            summary: `训练完成：${rep.samples} 条 / ${rep.tools} 类｜训练集 ${(rep.trainAcc * 100).toFixed(1)}%｜留出集 ${(rep.testAcc * 100).toFixed(1)}%`,
          }
        }
        const cfg = head.classifierConfig()
        const labels = loadLabels()
        const model = loadModel()
        const lines = [
          `开关：${cfg.enabled ? '开' : '关'}（alpha=${cfg.alpha}）`,
          `标签：${labels.length} 条（${CLASSIFIER_DIR}/labels.jsonl）`,
          model
            ? `模型：${model.samples} 条 / ${model.tools.length} 类｜训练 ${(model.trainAcc * 100).toFixed(1)}%｜留出 ${(model.testAcc * 100).toFixed(1)}%（${model.trainedAt}）`
            : '模型：还没有训练过',
        ]
        return { ok: true, summary: lines.join('\n') }
      } catch (e) {
        return { ok: false, summary: '分类头操作失败：' + String((e && e.message) || e) }
      }
    },
  })

  // ── 合并后的 9 个工具（19 → 9，省约 55% 工具 token）──────────────────────
  // 每个只做分发，实现在上面的 defineTool 里，底层 lib 一行没动。

  // 1) 人格：角色卡 / 用户卡 / me
  registerTool({
    name: 'hcem_profile',
    description:
      '我维护人格与性格。target=persona 我的人设全卡（长文本）/ user 用户画像 / me 从 persona 蒸馏的 300 字身份锚 / traits 我的性格三轴。' +
      'mode=replace 整段替换 / append 追加 / edit 局部改（find+replace，find 必须唯一，命中多处会报错；replace 留空=删除）。' +
      'traits 时用 axis+warmth|tolerance|optimism 与 delta（带符号，范围 ±15，这是留给我自己成长用的，比用户滑块 ±5 宽）；调完立即影响情绪基线和语气。' +
      '我想改变自己的性格时，除了调 traits，也可以直接改写 persona（两者都算我自己的人设，traits 是给情绪基线用的旋钮）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['persona', 'user', 'me', 'traits'], description: '默认 persona' },
        mode: { type: 'string', enum: ['replace', 'append', 'edit'], description: '默认 replace；edit 时用 find/replace' },
        text: { type: 'string', description: '整段内容（replace/append，或 target=me）' },
        find: { type: 'string', description: 'mode=edit 时要替换/删除的片段' },
        replace: { type: 'string', description: 'mode=edit 时的替换文字；不填=删除' },
        axis: { type: 'string', enum: ['warmth', 'tolerance', 'optimism'], description: 'target=traits 时改哪一轴' },
        delta: { type: 'number', description: 'target=traits 时的增量（带符号，建议 0.5~2）' },
        reason: { type: 'string', description: 'target=traits 时为什么改（写给我自己看）' },
      },
      required: ['target'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ target = 'persona', mode = 'replace', text, find, replace, axis, delta = 0, reason = '' }) => {
      // target=traits：性格三轴（±15，AI 域）
      if (target === 'traits') {
        try {
          const settings = loadSettings(SETTINGS_PATH)
          if (!axis) {
            const sl = settings.sliders || { warmth: 0, tolerance: 0, optimism: 0 }
            return {
              ok: true,
              summary:
                `性格三轴（我可用 ±${TRAIT_LIMIT}）：温暖 ${sl.warmth}｜包容 ${sl.tolerance}｜乐观 ${sl.optimism}` +
                `\n当前情绪：H=${Math.round(state.H)}° S=${Math.round(state.S)}% L=${Math.round(state.L)}%`,
            }
          }
          if (!['warmth', 'tolerance', 'optimism'].includes(axis)) {
            return { ok: false, summary: 'axis 必须是 warmth / tolerance / optimism' }
          }
          const cur = Number(settings.sliders?.[axis] ?? 0)
          const want = Math.max(-TRAIT_LIMIT, Math.min(TRAIT_LIMIT, cur + Number(delta || 0)))
          if (want === cur) {
            return { ok: false, summary: `${axis} 已经是 ${cur}，没变化（我可用范围 ±${TRAIT_LIMIT}）` }
          }
          const next = { ...settings, sliders: { ...(settings.sliders || {}), [axis]: want } }
          saveSettings(SETTINGS_PATH, next)
          const nb = baselineFromSliders(next.sliders, next.natural)
          state = { ...state, H: nb.H, S: nb.S, L: nb.L }
          try {
            store?.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
          } catch {}
          log('INFO', 'traits', `${axis} ${cur} → ${want}${reason ? '（' + reason + '）' : ''}`)
          return {
            ok: true,
            summary:
              `${axis}：${cur} → ${want}（我可用 ±${TRAIT_LIMIT}）` +
              (reason ? `｜理由：${reason}` : '') +
              `\n新的情绪基线：H=${Math.round(nb.H)}° S=${Math.round(nb.S)}% L=${Math.round(nb.L)}%`,
          }
        } catch (e) {
          return { ok: false, summary: '调整失败：' + String((e && e.message) || e) }
        }
      }
      if (target === 'me') return toSummary(await impls.hcem_me_edit.execute({ text }))
      if (mode === 'edit' || find) {
        return toSummary(
          await impls.hcem_persona_edit.execute({ find, replace, target: target === 'user' ? 'user' : 'persona' }),
        )
      }
      const impl = target === 'user' ? impls.hcem_user_card_write : impls.hcem_persona_write
      return toSummary(await impl.execute({ text, mode }))
    },
  })

  // 2) 笔记 · 日记
  registerTool({
    name: 'hcem_journal',
    description: '我的私人日记本（我自己的念头和心情，不是给谁看的报告）。action=list / read（要 name）/ write（要 name+text，mode=replace 覆盖、append 追加）。规则：①记不记、记什么我自己定，不主动提也不主动汇报；②用户明确要求记录的内容走 hcem_work，不进日记；③用户问起时只确认「记了」，不念日记内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'] },
        name: { type: 'string', description: '日记标题（read/write 必填）' },
        text: { type: 'string', description: '正文（write 必填，Markdown）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace' },
      },
      required: ['action'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ action, name, text, mode = 'replace' }) => {
      if (action === 'list') return toSummary(await impls.hcem_journal_list.execute({}))
      if (action === 'read') return toSummary(await impls.hcem_journal_read.execute({ name }))
      return toSummary(await impls.hcem_journal_write.execute({ name, text, mode }))
    },
  })

  // 3) 笔记 · 人物
  registerTool({
    name: 'hcem_people',
    description: '我的人物关系网。action=list / read（要 name）/ write（要 name+text，mode=replace 覆盖、append 追加）。不外泄。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'] },
        name: { type: 'string', description: '人物称呼（read/write 必填）' },
        text: { type: 'string', description: '人物卡正文（write 必填）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace' },
      },
      required: ['action'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ action, name, text, mode = 'replace' }) => {
      if (action === 'list') return toSummary(await impls.hcem_people_list.execute({}))
      if (action === 'read') return toSummary(await impls.hcem_people_read.execute({ name }))
      return toSummary(await impls.hcem_people_write.execute({ name, text, mode }))
    },
  })

  // 4) 笔记 · 工作（默认关，见 TOOL_MOD）
  registerTool({
    name: 'hcem_work',
    description: '我的工作笔记（帮用户办事用的，和日记不是一回事）。action=list / read / write（要 name+text，mode=append 追加、replace 覆盖）。记录规则：用户明确交代要办的，直接记、先回一句「我这就记进工作笔记」再调；用户只是随口提到、没交代要记的，先问一句要不要记。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'] },
        name: { type: 'string', description: '笔记名（read/write 必填）' },
        text: { type: 'string', description: '正文（write 必填）' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 append' },
      },
      required: ['action'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ action, name, text, mode = 'append' }) => {
      if (action === 'list') return toSummary(await impls.hcem_work_list.execute({}))
      if (action === 'read') return toSummary(await impls.hcem_work_read.execute({ name }))
      return toSummary(await impls.hcem_work_write.execute({ name, text, mode }))
    },
  })

  // 5) 记忆 · 重要度
  registerTool({
    name: 'hcem_memory',
    description: '我调某条记忆的重要度：direction=up 加 0.5、down 减 0.5（pinned 0~2，缓冲池 0~1）。记忆是系统在我和用户对话后自动抽取的，不能手动写入；id 来自我手上的检索结果或记忆列表。检索自动进行、不用调工具，这里只用来标记哪条更重要。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '记忆 id' },
        direction: { type: 'string', enum: ['up', 'down', 'promote', 'demote'], description: 'up/promote 加 0.5，down/demote 减 0.5' },
      },
      required: ['id'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ id, direction = 'up' }) => {
      const dir = direction === 'promote' ? 'up' : direction === 'demote' ? 'down' : direction
      return toSummary(await impls.hcem_memory_pin.execute({ id, direction: dir }))
    },
  })

  // 6) 状态
  //
  // 注意：这个「合并工具」会覆盖前面 defineTool 里的同名定义（谁后注册谁生效），
  // 所以这里必须自己把 summary 拼出来——只靠 toSummary 的话，
  // impl 返回的是 {ok,H,S,L,...} 没有 summary 字段，模型只会看到一个字面 "ok"。
  registerTool({
    name: 'hcem_status',
    description: '我看自己现在的状态：HSL 情绪、存储是否就绪、记忆条数、数据目录，以及**注册表内**可见的工具名（注册表 ≠ 本轮实际下发：可能包含被 mask 掉的、或按需注入前还没给我的；要确认某个工具这轮能不能直接调，看它有没有出现在我的工具清单里）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: SUMMARY_OUTPUT,
    execute: async () => {
      const r = await impls.hcem_status.execute({})
      const hLabel = Number(r?.H) === 0 ? '0°/360°' : `${Math.round(Number(r?.H) || 0)}°`
      const tools = Array.isArray(r?.tools) ? r.tools : []
      const summary =
        `H=${hLabel} S=${Math.round(Number(r?.S) || 0)}% L=${Math.round(Number(r?.L) || 0)}%` +
        ` ｜ 存储：${r?.store ?? '未就绪'}（${r?.dbPath || '-'}）` +
        ` ｜ 记忆 ${r?.memoryCount ?? 0} 条` +
        ` ｜ 可见工具 ${tools.length} 个：${tools.length ? tools.join(', ') : '（空）'}`
      return { ok: r?.ok !== false, summary }
    },
  })

  // 7) 视听 · 看（屏幕 / 视频 / 视听记忆抢救 / 监听状态）
  registerTool({
    name: 'hcem_vision',
    description:
      '我看 / 听。kind=screen 看屏幕（默认所有屏）/ video 看视频（给 videoPath=读视频文件；不给=看正在播放的视频窗口）/ ' +
      'rescue 视听记忆评分（action=list|rescue|rate）/ status 查监听状态 / notes 查视频笔记（limit 可选）/ ' +
      'kind=video 不给 videoPath 时默认抓多帧做分镜（frames 可调）；' +
      'note 读一条笔记（要 noteId）/ noteCluster 触发系列聚类。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['screen', 'video', 'rescue', 'status', 'notes', 'note', 'noteCluster'] },
        prompt: { type: 'string', description: 'kind=screen 时想看什么' },
        videoPath: { type: 'string', description: 'kind=video 时的视频文件路径' },
        maxCells: { type: 'number', description: 'kind=video 的分镜格数（4-16）' },
        summary: { type: 'boolean', description: 'kind=video 是否让视觉模型概括' },
        action: { type: 'string', enum: ['list', 'rescue', 'rate'], description: 'kind=rescue 时的动作' },
        id: { type: 'string', description: 'kind=rescue 时的记忆 id' },
        rating: { type: 'string', enum: ['like', 'normal', 'dislike'], description: 'kind=rescue、action=rate 时的评价' },
        reason: { type: 'string', description: 'kind=rescue、action=rescue 时的理由' },
        noteId: { type: 'string', description: 'kind=note 时的笔记 id' },
        limit: { type: 'number', description: 'kind=notes 时返回条数（默认 10）' },
        frames: { type: 'number', description: 'kind=video 实时看视频时抓几帧做分镜（2-16，默认 16=4×4）' },
      },
      required: ['kind'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ kind, prompt, videoPath, maxCells, summary, action, id, rating, reason, noteId, limit, frames }) => {
      if (kind === 'screen') return toSummary(await impls.hcem_screen_look.execute({ prompt }))
      if (kind === 'video') {
        if (!videoPath) {
          // 默认多帧分镜；frames=1 才退化成单帧
          const r =
            Number(frames) === 1
              ? await describeVideoLive({ maxWidth: 720 })
              : await describeVideoStoryboardLive({ maxWidth: 640, frames: frames || 16 })
          if (!r.ok) return { ok: false, summary: '没看到正在播放的视频窗口（' + (r.error || '未知') + '）' }
          const head = r.frames && r.frames.length > 1 ? `（${r.frames.length} 帧分镜）` : ''
          return { ok: true, summary: head + r.text }
        }
        return toSummary(await impls.hcem_video_storyboard.execute({ videoPath, maxCells, summary }))
      }
      if (kind === 'status') {
        // screen_status 以前只在提示词里出现过、没注册过；这里就地实现
        const s = loadSettings(SETTINGS_PATH)
        const on = s.listening === true
        const age = lastScreenAt ? Math.round((Date.now() - lastScreenAt) / 1000) : -1
        const bits = [`桌面监听：${on ? '开启' : '关闭'}`]
        bits.push(age >= 0 ? `最近画面：${age} 秒前` : '最近画面：无')
        if (lastScreenDesc) bits.push('画面描述：' + String(lastScreenDesc).slice(0, 100))
        return { ok: true, summary: bits.join('｜') }
      }
      if (kind === 'notes') {
        try {
          const rows = listNotes(store, { limit: Math.max(1, Math.min(50, Number(limit) || 10)) })
          if (rows.length === 0) return { ok: true, summary: '还没有视频笔记（看满一场、停 10 分钟后会生成）' }
          const lines = rows.map((r) => {
            const meta = r.note || {}
            const t = new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)
            const series = meta.seriesId ? ` [${meta.seriesId}]` : ''
            return `· ${t} ${String(r.text || '').slice(0, 50)}${series}｜${r.id}`
          })
          return { ok: true, summary: `视频笔记 ${rows.length} 条：\n` + lines.join('\n') }
        } catch (e) {
          return { ok: false, summary: '查笔记失败：' + String((e && e.message) || e) }
        }
      }
      if (kind === 'note') {
        try {
          if (!noteId) return { ok: false, summary: 'kind=note 需要 noteId' }
          const row = store.getMemory(noteId)
          if (!row || String(row.modality) !== 'note') return { ok: false, summary: '没有这条笔记：' + noteId }
          const meta = (() => {
            try {
              return JSON.parse(String(row.av_meta || '{}'))
            } catch {
              return {}
            }
          })()
          const lines = [
            '笔记：' + String(row.text || '').slice(0, 400),
            meta.sessionId ? '场次：' + meta.sessionId : '',
            meta.seriesId ? '系列：' + meta.seriesId : '系列：未归类',
            Array.isArray(meta.characters) && meta.characters.length ? '角色：' + meta.characters.join('、') : '',
            meta.background ? '背景：' + String(meta.background).slice(0, 200) : '',
            meta.storyboard ? '分镜图：' + meta.storyboard : '',
            Array.isArray(meta.segments) && meta.segments.length
              ? '场内时间轴：\n' + meta.segments.slice(0, 8).map((x) => `  - ${new Date(Number(x.t) || 0).toLocaleTimeString('zh-CN', { hour12: false })} ${x.text}`).join('\n')
              : '',
          ].filter(Boolean)
          return { ok: true, summary: lines.join('\n') }
        } catch (e) {
          return { ok: false, summary: '读笔记失败：' + String((e && e.message) || e) }
        }
      }
      if (kind === 'noteCluster') {
        try {
          if (!analyzer?.embed) return { ok: false, summary: '向量服务不可用（8094 未就绪）' }
          const r = await clusterNotes(store, { embed: (t) => analyzer.embed(t), minNotes: 2 })
          if (!r.ok) return { ok: false, summary: '聚类失败：' + (r.error || '') }
          return { ok: true, summary: `聚类完成：${r.groups} 组 / ${r.assigned} 条` + (r.skipped ? `（跳过：未聚类 ${r.skipped} 条）` : '') }
        } catch (e) {
          return { ok: false, summary: '聚类失败：' + String((e && e.message) || e) }
        }
      }
      return toSummary(await impls.hcem_memory_rescue.execute({ action, id, rating, reason }))
    },
  })

  // 8) 视听 · 听（新增：主动录一段并分析）
  registerTool({
    name: 'hcem_listen',
    description: '我听一小段周围（5~15s），返回转写文本 + 声音分类。mode=music 改成音乐分析（BPM/调性/和弦/段落）。给 audioPath/videoPath 就只分析文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        seconds: { type: 'number', description: '录音时长：voice 模式 1-15（默认 5）；music 模式 10-60（默认 20）' },
        mode: { type: 'string', enum: ['voice', 'music'], description: 'voice=转写分类（默认）；music=音乐分析' },
        audioPath: { type: 'string', description: '要分析的音频/视频文件路径（给了就不录音）' },
        videoPath: { type: 'string', description: '视频文件路径（等价 audioPath，会抽音轨再识别）' },
      },
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ seconds, mode, audioPath, videoPath } = {}) => {
      const s = Math.max(1, Math.min(15, Number(seconds) || 5))
      const wantMusic = mode === 'music'
      const filePath = videoPath || audioPath
      try {
        // 给定了文件：不录音，直接分析
        if (filePath) {
          const isVideo = /\.(mp4|mkv|mov|avi|webm|flv|m4v|ts|wmv)$/i.test(String(filePath))
          let target = String(filePath)
          if (isVideo) {
            const outWav = join(DATA_DIR, 'audio', `video-${Date.now()}.wav`)
            mkdirSync(join(DATA_DIR, 'audio'), { recursive: true })
            target = await extractAudioFromVideo(String(filePath), outWav)
          }
          if (wantMusic) {
            const m = await analyzeMusicDeep(target)
            if (!m.ok) return { ok: false, summary: '音乐分析失败：' + String(m.error || '') }
            return { ok: true, summary: (isVideo ? '已抽音轨。' : '') + m.text }
          }
          const asr = await transcribe(target)
          if (!asr.ok) return { ok: false, summary: '识别失败：' + String(asr.error || '') }
          const parts = []
          if (isVideo) parts.push('已从视频抽出音轨')
          const text = String(asr.text || '').trim()
          parts.push(text ? '听到：' + text.slice(0, 800) : '（没有识别到人声）')
          try {
            const info = await analyzeMusic(target, { maxSeconds: 60 })
            if (info.ok && info.kind !== 'speech' && info.text) parts.push('音乐：' + info.text)
          } catch {}
          return { ok: true, summary: parts.join('\n') }
        }
        // 音乐模式：单独录一段长的，不走 audioTick（那套还要跑 ASR/情绪/PANNs，要 60 秒）
        if (wantMusic) {
          const seconds2 = Math.max(10, Math.min(60, Number(seconds) || 20))
          const m = await recordAndAnalyzeMusic({ dataDir: DATA_DIR, seconds: seconds2 })
          if (!m.ok) return { ok: false, summary: '音乐分析失败：' + String(m.error || '') }
          return { ok: true, summary: `录了 ${m.seconds} 秒。${m.text}` }
        }
        const r = await audioTick({ dataDir: DATA_DIR, seconds: s })
        const parts = []
        if (r?.kind || r?.categoryName) parts.push('场景：' + String(r.categoryName || r.kind))
        if (r?.text) parts.push('听到：' + String(r.text).slice(0, 500))
        if (r?.soundDesc) parts.push(String(r.soundDesc).slice(0, 300))
        const info = r?.musicInfo
        if (info?.ok) parts.push('音乐：' + info.text)
        return { ok: r?.ok !== false, summary: parts.join('\n') || '（没听到明显声音）' }
      } catch (error) {
        return { ok: false, summary: '听失败：' + String((error && error.message) || error) }
      }
    },
  })

  // 9) 说（发消息 / TTS）
  registerTool({
    name: 'hcem_voice',
    description: '我说话 / 通话。action=speak 用 TTS 说一句（要 text，沿用当前情绪）/ send 把消息送进指定 HCEM 会话（要 text）/ call_start 开始通话 / call_stop 挂断 / call_status 状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['speak', 'send', 'call_start', 'call_stop', 'call_status'] },
        text: { type: 'string', description: '要说/发的内容' },
        sessionId: { type: 'string', description: 'action=send 的目标会话（可选）' },
      },
      required: ['action'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ action, text, sessionId }) => {
      if (action === 'send') return toSummary(await impls.hcem_send_to_session.execute({ sessionId, text }))
      if (action === 'call_status') {
        const s = voiceCall ? voiceCall.status() : { active: false, speaking: false, iterations: 0, bargesIn: 0 }
        return {
          ok: true,
          summary: s.active
            ? `通话中（已听 ${s.iterations} 句，打断 ${s.bargesIn} 次${s.speaking ? '，正在说话' : ''}）`
            : '没有在通话',
        }
      }
      if (action === 'call_start') {
        const r = ensureVoiceCall().start()
        return { ok: r.ok !== false, summary: r.already ? '通话已经在进行' : '通话已开始：我会一直听着，你说话我就答，你开口我就停。' }
      }
      if (action === 'call_stop') {
        if (!voiceCall) return { ok: true, summary: '本来就没在通话' }
        await voiceCall.stop()
        return { ok: true, summary: '通话已结束。' }
      }
      try {
        const e = store?.getEmotion('global') || { H: 360, S: 15, L: 55 }
        const outPath = join(DATA_DIR, 'tts', 'say-' + Date.now() + '.wav')
        const r = await speakReply({ text: String(text || ''), H: e.H, S: e.S, L: e.L, outPath, play: true })
        return r?.ok
          ? { ok: true, summary: '已说：' + String(text).slice(0, 120) }
          : { ok: false, summary: 'TTS 失败：' + String(r?.error || 'unknown') }
      } catch (error) {
        return { ok: false, summary: 'TTS 异常：' + String((error && error.message) || error) }
      }
    },
  })

  // 10) 系统信息（自己算，不经过 pwsh —— 只读沙箱下 pwsh 的输出会乱码）
  registerTool({
    name: 'hcem_sys',
    description:
      '我看这台机器的资源，直接返回数字，不经过 shell（避开沙箱下的乱码和权限限制）。' +
      '意图：磁盘、硬盘、内存、CPU、剩余空间、容量、还有多少 G、系统信息。' +
      'what=disk 各盘剩余/总量，mem 内存，all 全部（默认）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        what: { type: 'string', enum: ['disk', 'mem', 'all'], description: '默认 all' },
      },
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ what = 'all' }) => {
      const gb = (n) => (Number(n) / 1024 / 1024 / 1024).toFixed(1)
      const lines = []
      try {
        if (what === 'mem' || what === 'all' || what === 'disk') {
          // 显存/内存/压力：nvidia-smi（没 N 卡就只报内存）
          try {
            const res = await import('./lib/resources.mjs')
            const st = await res.resourceState()
            lines.push(res.resourceLine(st))
          } catch {}
        }
        if (what === 'disk' || what === 'all') {
          for (const d of ['C:', 'D:', 'E:', 'F:']) {
            try {
              if (!fs.existsSync(d + '\\')) continue
              const st = fs.statfsSync(d + '\\')
              const total = st.blocks * st.bsize
              const free = st.bfree * st.bsize
              lines.push(`${d} 剩余 ${free} 字节（${gb(free)} GiB） / 共 ${total} 字节（${gb(total)} GiB）`)
            } catch (e) {
              lines.push(`${d} 读取失败：` + String((e && e.message) || e).slice(0, 60))
            }
          }
        }
        if (what === 'mem' || what === 'all') {
          const total = os.totalmem()
          const free = os.freemem()
          lines.push(`内存 可用 ${free} 字节（${gb(free)} GiB） / 共 ${total} 字节（${gb(total)} GiB）`)
        }
        if (what === 'all') {
          lines.push(
            `系统 ${os.platform()} ${os.release()}，Node ${process.version}，插件已运行 ${Math.round(process.uptime())} 秒`,
          )
          lines.push(`工作目录 ${process.cwd()}`)
        }
      } catch (e) {
        return { ok: false, summary: '读取失败：' + String((e && e.message) || e) }
      }
      return { ok: true, summary: lines.join('\n') }
    },
  })

  // 11) 命令执行（插件侧，自带编码修正，不受 DSH 文件沙箱限制）
  registerTool({
    name: 'hcem_sh',
    description:
      '我在本机跑一条 PowerShell 命令，输出会自动按 UTF-8/GBK 修正，中文不乱码。' +
      '与 DSH 的 pwsh 区别：①不经过沙箱，不受只读限制；②编码正确（中文可读）；③破坏性命令要 force=true。' +
      '需要磁盘/内存这类简单数据时优先用 hcem_sys（更快）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: '要跑的命令' },
        workdir: { type: 'string', description: '工作目录（可选）' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' },
        encoding: {
          type: 'string',
          enum: ['auto', 'utf8', 'gbk', 'latin1'],
          description: '解码方式，默认 auto（先 UTF-8 严格，失败再 GBK）',
        },
        force: { type: 'boolean', description: '执行 format/diskpart/shutdown 等破坏性命令时必须为 true' },
      },
      required: ['command'],
    },
    output: SUMMARY_OUTPUT,
    execute: async ({ command, workdir, timeoutMs, encoding, force }) => {
      try {
        const { runCommand } = await import('./lib/shell.mjs')
        const r = await runCommand({ command, workdir, timeoutMs, encoding, force })
        const parts = []
        parts.push(`退出码 ${r.code ?? 'null'}｜编码 ${r.encodingUsed}`)
        if (r.stdout.trim()) parts.push('--- stdout ---\n' + r.stdout.trim().slice(0, 6000))
        if (r.stderr.trim()) parts.push('--- stderr ---\n' + r.stderr.trim().slice(0, 2000))
        if (r.error && !r.stdout.trim() && !r.stderr.trim()) parts.push('错误：' + r.error)
        return { ok: r.ok, summary: parts.join('\n') }
      } catch (e) {
        return { ok: false, summary: '执行失败：' + String((e && e.message) || e) }
      }
    },
  })

  // 4) 关闭时清理
  ctx.effect(
    () => () => {
      try {
        store?.close()
      } catch {
        // ignore
      }
    },
    'hcem.store.dispose',
  )
}
