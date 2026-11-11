import { openStore, DB_PATH } from './lib/store.mjs'
import { createEmotion, toPromptText, analyzeText, applyStimulus, tick, settle, useSelfControl, selfConfidenceOf } from './lib/emotion.mjs'
import { createEmbeddingAnalyzer } from './lib/emotion-embedding.mjs'
import { detectInsult } from './lib/insult.mjs'
import { ingestReincarnation } from './lib/reincarnation.mjs'
import { shouldRemember, extractMemoryText, decayMemories, recall, computeGamma, summarize, displayText, applyRecallToEmotion, lightnessFromMemories, detectPinIntent } from './lib/memory.mjs'
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
import { loadSettings, saveSettings, baselineFromSliders, talkativenessPrompt } from './lib/settings.mjs'
import { appendSample, computeBaseline } from './lib/emotion-samples.mjs'
import { createSafetyWindow, recordTurn, evaluateSafety, safetyPrompt, SAFETY_FINGERPRINT, detectCrisis } from './lib/safety.mjs'
import { listJournal, readJournal, writeJournal } from './lib/journal.mjs'
import { buildRecall } from './lib/hibernation.mjs'
import { promoteMemories } from './lib/zones.mjs'
import { listPeople, readPerson, writePerson } from './lib/people.mjs'
import { listWork, readWork, writeWork, workUsage } from './lib/work.mjs'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))

const EMBED_DIR = process.env.HCEM_EMBED_DIR || join(__dirname, '..', 'embedding-service')
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', 'data')

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
    const child = spawn(process.execPath, [join(EMBED_DIR, 'server.mjs')], {
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

async function ensureEmbeddingService(logger) {
  if (await isEmbeddingUp()) return true
  spawnEmbeddingService(logger)
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await isEmbeddingUp()) return true
  }
  return false
}

const UI_DIR = join(__dirname, 'ui')

async function isUiUp() {
  try {
    const res = await fetch('http://127.0.0.1:8082/', { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function spawnUiService(logger) {
  try {
    const child = spawn(process.execPath, [join(UI_DIR, 'server.mjs')], {
      cwd: UI_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    logger.info?.(`[hcem] spawned settings UI (pid=${child.pid})`)
    return true
  } catch (error) {
    logger.warn?.(`[hcem] failed to spawn settings UI: ${String((error && error.message) || error)}`)
    return false
  }
}

async function ensureUiService(logger) {
  if (await isUiUp()) return true
  spawnUiService(logger)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (await isUiUp()) return true
  }
  return false
}

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
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'sessionProjections']

// 只属于 HCEM 模式的工具名：对非 HCEM 的 agent 做 deny 掩码用。
const HCEM_TOOL_NAMES = [
  'hcem_status',
  'hcem_persona_write',
  'hcem_persona_edit',
  'hcem_user_card_write',
  'hcem_journal_list',
  'hcem_journal_read',
  'hcem_journal_write',
  'hcem_people_list',
  'hcem_people_read',
  'hcem_people_write',
]

function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

export function apply(ctx, input = {}) {
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
      recallText = buildRecall(coldSince, store.getEmotion('global'), store.listMemories({ limit: 3 }))
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
  let lastGateLog = 0
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
          const base = toPromptText(state)
          const parts = [base]
          if (recalledMemories.length > 0) {
            const mems = recalledMemories.map((m) => `- ${displayText(m)}`).join('\n')
            parts.push(`[HCEM 记忆] 你可能想起：\n${mems}`)
          }
          // 工作记忆：指引 + 75% 提醒
          parts.push(
            '[HCEM 工作记忆] 用户交代需要记住的工作时，先回复「我这就把这些事记入我的工作笔记里」，再调用 hcem_work_write 记录。',
          )
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
                    '\n如果你觉得它们值得留下，调用 hcem_memory_pin（本会话最多 2 次）；否则它们会被遗忘。',
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

  // 设置页（127.0.0.1:8082）随插件拉起
  ensureUiService(logger)
    .then((ok) => logger.info?.(`[hcem] settings UI ${ok ? 'ready' : 'unavailable'} (http://127.0.0.1:8082)`))
    .catch(() => {})

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

  // 串行处理消息，避免异步更新乱序
  let updateChain = Promise.resolve()
  function processUserMessage(text, session) {
    updateChain = updateChain
      .then(async () => {
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

        const stimulus = analyzer ? await analyzer.analyze(text) : analyzeText(text)
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
          // ② SC 耦合：指数曲线（先平后陡）——L 偏离基线越远，增量越大，能走到极值
          const sc = selfConfidenceOf(state.H)
          const lDeviation = Math.abs(nextL - 55) / 45 // 0（中位）~ 1（极值）
          const lGain = L_BASE * Math.exp(L_EXPONENT * Math.min(1, lDeviation))
          nextL += sc * 0.3 * (Number(state.S) / 100) * lGain
          // ③ 时钟回落：每轮 0.5% 向基线（真正的回落交给 settle 按真实时间做）
          nextL += (baseL - nextL) * 0.005
          state = { ...state, L: Math.max(0, Math.min(100, nextL)) }
          store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
        }

        // 安全阀：用更新后的情绪 + 本轮文本评估
        recordTurn(safetyWin, { H: state.H, S: state.S, L: state.L, text })
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
              // trauma 戳：用户辱骂/羞辱 → 这条记忆带痛感（可衰减，见 6.x）
              const insult = detectInsult(text)
              store.putMemory({
                text: memText,
                summary: summarize(memText),
                embedding: vec,
                alphaH: state.H,
                alphaS: state.S,
                betaH: stimulus ? stimulus.targetHue : null,
                gammaValue: computeGamma(
                  { H: state.H, S: state.S },
                  stimulus ? { H: stimulus.targetHue, S: (stimulus.intensity ?? 0.5) * 100 } : null,
                ),
                zone: 'context',
                pinned: detectPinIntent(memText),
                L: 1.0,
                level: 'full',
                // trauma 戳（0-1）：辱骂记忆带痛感；非辱骂为 0
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
            recalledMemories = recall(store, qvec, 3, 0.45)
        if (recalledMemories.length > 0) {
          // 回忆反哺：记忆的 γ 把当时的情绪唤起来
          state = applyRecallToEmotion(state, recalledMemories)
          store.setEmotion({ H: state.H, S: state.S, L: state.L }, 'global')
        }
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

  // 3) 监听会话事件：用户消息 → 情绪刺激
  logDebug(`plugin loaded; analyzer=${analyzer ? 'pending' : 'null'}; store=${store ? 'ready' : 'null'}`)
  ctx.on('session/event', (session, event) => {
    try {
      logDebug(`event ${event.type}`)
      // 空白会话切换 preset 后重新判定工具可见性：切到 HCEM 要撤销掩码，
      // 切离 HCEM 要重新加上。
      if (event.type === 'agent-preset/selected') {
        syncToolMask(ctx.agents.get(session.id))
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

  function syncToolMask(agent) {
    if (!agent || !agent.id) return
    const key = String(agent.id)
    const preset = presetForAgent(agent)
    const existing = maskedAgents.get(key)

    // HCEM 会话必须看得见全部工具：撤销任何已经加上的掩码。
    if (preset === 'hcem') {
      if (existing) {
        try {
          existing()
        } catch {}
        maskedAgents.delete(key)
        logDebug(`unmasked hcem tools for agent ${key} (preset=hcem)`)
      } else {
        logDebug(`hcem tools kept visible for agent ${key} (preset=hcem)`)
      }
      return
    }

    // preset 还没确定：先别掩码，等 agent-preset/selected 再判定，
    // 免得把刚建好的 HCEM 会话误伤成「没有工具」。
    if (preset === undefined) return
    if (existing) return

    try {
      const dispose = agent.ctx?.tools?.restrict?.({ deny: HCEM_TOOL_NAMES })
      if (typeof dispose === 'function') {
        maskedAgents.set(key, dispose)
        logDebug(`masked hcem tools for agent ${key} (preset=${String(preset)})`)
      }
    } catch (error) {
      logDebug(`mask failed for agent ${key}: ${String((error && error.message) || error)}`)
    }
  }

  ctx.on('agent/created', ({ agent } = {}) => syncToolMask(agent))
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

  registerTool({
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
  registerTool({
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
  registerTool({
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
      const result = target === 'user' ? editUserCard(find, replace) : editPersona(find, replace)
      return { target, ...result }
    },
  })

  // 4d) 日记本（阶段 4 遗留）：文件夹形态，不注入提示词，按需读
  registerTool({
    name: 'hcem_journal_list',
    description:
      '列出 HCEM 日记本里的所有文档（标题、摘要、字数、更新时间）。日记是鲸鲸自己的私人东西，不进入提示词，需要时再读；用户来翻看时可以提醒 ta：日记是私人的，偷看不太礼貌。',
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
    execute: async () => ({ ok: true, entries: listJournal() }),
  })

  registerTool({
    name: 'hcem_journal_read',
    description:
      '读取 HCEM 日记本里的一篇文档全文。日记是鲸鲸自己的私人东西，不是作品集、也不是给用户看的说明；自己想读再读，用户来翻看时可以先提一句「别偷看我的日记」再动手。',
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
    execute: async ({ name }) => readJournal(name),
  })

  registerTool({
    name: 'hcem_journal_write',
    description:
      '写入或追加 HCEM 日记（Markdown）。日记属于鲸鲸自己：想写才写，记心情、生活、冒出来的念头，用「过日子」的口气而不是验收清单，不为演示或应付而写。mode=replace 覆盖整篇，mode=append 追加；单篇软上限 8000 字，超了建议另起一篇。',
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
    execute: async ({ name, text, mode = 'replace' }) => writeJournal(name, text, mode),
  })

  // 4e) 人物关系网（生活常识区细分小区）：一人一卡，按需读
  registerTool({
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
    execute: async () => ({ ok: true, entries: listPeople() }),
  })

  registerTool({
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
    execute: async ({ name }) => readPerson(name),
  })

  registerTool({
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
    execute: async ({ name, text, mode = 'replace' }) => writePerson(name, text, mode),
  })

  // 4a) 记忆 pin 工具（AI 配额：缓冲池 2 次、生活/知识区 2 次，分开计）
  let aiPinQuotaPool = 2
  let aiPinQuotaLong = 2
  registerTool({
    name: 'hcem_memory_pin',
    description:
      '调整记忆重要度（pinned）：direction=up 加 0.5，down 减 0.5（pinned 范围 0~2，缓冲池 0~1）。' +
      '缓冲池配额 2 次、生活/知识区配额 2 次（分开计，不能跨区使用）。' +
      '用户明确要求记住或你确信重要时 up；你判断某条已不重要/过时时可以 down（可抵消用户或自己的判断）。' +
      '任务类工作请用 hcem_work_write，不要重复 pin。',
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
  registerTool({
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
    execute: async ({ name, text, mode = 'append' }) => writeWork(name, text, mode),
  })

  registerTool({
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
    execute: async () => ({ ok: true, entries: listWork() }),
  })

  registerTool({
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
    execute: async ({ name }) => readWork(name),
  })

  // 5) 状态工具（读真实存储）
  registerTool({
    name: 'hcem_status',
    description: '获取 HCEM 插件当前情绪状态（HSL）、存储状态与数据目录。',
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
      const saved = store ? store.getEmotion('global') : null
      const memories = store ? store.listMemories({ limit: 1000 }) : []
      return {
        ok: true,
        H: saved ? saved.H : state.H,
        S: saved ? saved.S : state.S,
        L: saved ? saved.L : state.L,
        store: store ? 'ready' : 'unavailable',
        dbPath: store ? DB_PATH : '',
        memoryCount: memories.length,
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
