// 分流层（S1/S2）：挂在 DSH 的 llm/stream waterfall 上
// - 语义缓存命中 → 直接 yield chunks（0 云端）
// - 简单请求（问候/格式化/复述/短翻译）→ 本地 Qwen3（8093）生成（0 云端）
// - 其余 → next() 放行；正常完成后把「用户消息 + 回答」写进语义缓存
import { lookupCache, storeCache, embedText } from './semantic-cache.mjs'
import './home.mjs'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function recordAnswer(dataDir, text) {
  try {
    writeFileSync(join(dataDir, 'last-answer.json'), JSON.stringify({ text: String(text).slice(0, 4000), ts: Date.now() }), 'utf8')
  } catch {}
}

const LOCAL_LLM_URL = process.env.HCEM_LOCAL_LLM || 'http://127.0.0.1:8093/v1/chat/completions'
const THERAPY_URL = process.env.HCEM_THERAPY_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'
const OMNI_PORT = 8098
const THERAPY_PORT = 8098
const CLOUD_FAIL_LIMIT = 3
let cloudFailures = 0
let therapyStarting = false
let offlineMode = false
const SIMPLE_MAX_CHARS = 300

// 简单请求判定（保守：只拦确定不需要云端大模型能力的）
const SIMPLE_PATTERNS = [
  /^(你好|您好|hi|hello|嗨|在吗|早上好|晚上好|晚安|早安)[呀啊呢！!。.~～]*$/i,
  /^(谢谢|多谢|感谢|thanks|thank you)[呀啊呢！!。.~～]*$/i,
  /^(好的|好|嗯|ok|okay|收到|明白了?)[呀啊呢！!。.~～]*$/i,
  /^请?把.+(翻译|转成|翻成|译成).{0,20}$/,
  /^请?把(.{1,60})(润色|改写|改成|重新表述)/,
  /^(今天是几号|现在几点|今天星期几)[？?]?$/,
]

/** 一次性强制本地：气泡那一轮用它，避免主动说话也走云端花额度 */
const forceLocalSessions = new Set()

/**
 * 「本地分流」开关当前是否开启（读 data/ui-state/mods.json）。
 * 分流层的总闸门：关掉它就应该完全不介入，既不算缓存也不本地生成。
 */
function localRouteOn() {
  try {
    const raw = readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/mods.json`, 'utf8')
    const m = JSON.parse(raw)
    if (m && m.localRoute && typeof m.localRoute.enabled === 'boolean') return m.localRoute.enabled
    if (m && typeof m['local-route'] === 'boolean') return m['local-route']
  } catch {}
  return false
}

/**
 * 让指定会话的**下一轮**强制走本地模型（消费一次即失效）。
 * 用于主动说话：本地分流开着时，这一轮本来就没有云端必要。
 */
export function forceLocalOnce(sessionId) {
  const sid = String(sessionId || '')
  if (sid) forceLocalSessions.add(sid)
}

export function isSimpleRequest(text) {
  const s = String(text || '').trim()
  if (s.length === 0 || s.length > SIMPLE_MAX_CHARS) return false
  return SIMPLE_PATTERNS.some((re) => re.test(s))
}

/**
 * 判断「视觉是否活跃」——即当前是否在看视频/看屏幕（占着显存）。
 * 用视觉模型的端口是否在跑来判断，不额外依赖 capture 模块的状态。
 */
async function isVisualActive() {
  try {
    const { portUp } = await import('./services.mjs')
    const vision = await portUp(8091, 300) // Qwen2.5-VL 精看
    const fast = await portUp(8092, 300) // SmolVLM 快看
    return Boolean(vision || fast)
  } catch {
    return false
  }
}

/**
 * 判断一条用户消息是否「情绪性/陪伴性」——决定要不要走 OmniDimen。
 *
 * 规则（任一命中即算）：
 *   · 含情绪词（难过/开心/烦/累/害怕/想你…）
 *   · 含情感诉求（陪我/在吗/抱抱/安慰…）
 *   · 第一人称 + 感受（我觉得/我感觉/我好/我有点…）
 *   · 问「你怎么想/你在想什么」这类关系性提问
 *   · 长度超过 40 字（通常是在讲事情/讲心情，不是问事实）
 */
const EMOTION_WORDS = [
  '难过', '伤心', '开心', '高兴', '快乐', '烦', '累', '疲惫', '害怕', '恐惧', '焦虑', '担心',
  '孤独', '寂寞', '想你', '喜欢', '爱你', '讨厌', '生气', '愤怒', '委屈', '失落', '空虚',
  '崩溃', '绝望', '痛苦', '压力', '失眠', '哭', '笑', '幸福', '温暖', '安心', '踏实',
  '抱抱', '摸摸', '陪我', '陪我聊', '安慰', '撒个娇', '不开心', '没意思', '好累', '好烦',
]

const FEELING_PATTERNS = [
  /我(觉得|感觉|好像|有点|好|很|特别|真的)/,
  /你(觉得|感觉|认为|会怎么想)/,
  /在吗|在不在|睡了|醒着/,
  /(今天|刚才|现在).{0,10}(心情|状态|感觉)/,
]

export function isEmotionalRequest(text) {
  const s = String(text || '').trim()
  if (!s) return false
  if (EMOTION_WORDS.some((w) => s.includes(w))) return true
  if (FEELING_PATTERNS.some((re) => re.test(s))) return true
  if (s.length > 40) return true
  return false
}

function lastUserText(options) {
  const msgs = Array.isArray(options?.messages) ? options.messages : []
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b && (b.type === 'text' || b.type === 'text-delta'))
        .map((b) => b.text || '')
        .join('')
    }
  }
  return ''
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b.type === 'text' || b.type === 'text-delta'))
    .map((b) => b.text || '')
    .join('')
}

/**
 * 组装本地模型要的消息：system（角色卡/记忆）+ 最近几轮对话 + 本轮用户消息。
 * 早期版本只传一句 user 文本，本地模型完全不知道人格和上下文，回答会「失忆」。
 */
export function buildLocalMessages(options, text, sysOverride = null) {
  const hist = Array.isArray(options?.messages) ? options.messages : []
  // system 优先用调用方给的精简版（按重要性挑选的 me/角色卡/用户卡/感知/搭话）；
  // 没有精简版时才回退到 DSH 拼好的整段 system（可能很长）。
  const sysParts = []
  if (typeof sysOverride === 'string' && sysOverride.trim()) {
    sysParts.push(sysOverride.trim())
  } else {
    if (typeof options?.system === 'string' && options.system.trim()) sysParts.push(options.system.trim())
    for (const m of hist) {
      if (m?.role === 'system') {
        const t = flattenContent(m.content)
        if (t) sysParts.push(t)
      }
    }
  }
  let sys = sysParts.join('\n\n')
  if (sys.length > LOCAL_SYSTEM_BUDGET) sys = sys.slice(0, LOCAL_SYSTEM_BUDGET) + '\n（后略）'

  const msgs = []
  if (sys) msgs.push({ role: 'system', content: sys })

  // 历史按预算动态摘：从最近往回取，单条超 500 字截断，装不下就停。
  // 之前固定取 4 条，遇到长回复/长工具结果会直接撑爆 4096。
  const head = String(text || '')
  const budget = Math.max(400, LOCAL_MAX_INPUT_CHARS - sys.length - head.length - 200)
  const picked = []
  let used = 0
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const m = hist[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    let t = flattenContent(m.content)
    if (!t) continue
    if (t.length > 500) t = t.slice(0, 500) + '…'
    if (used + t.length > budget) break
    picked.unshift({ role: m.role, content: t })
    used += t.length
    if (picked.length >= 6) break
  }
  msgs.push(...picked)

  if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
    msgs.push({ role: 'user', content: head })
  }
  return msgs
}

/** 原始 system 规模（options.system + messages 里的 system） */
function rawSystemLength(options) {
  let n = typeof options?.system === 'string' ? options.system.length : 0
  const hist = Array.isArray(options?.messages) ? options.messages : []
  for (const m of hist) {
    if (m?.role === 'system') n += flattenContent(m.content).length
  }
  return n
}

// 「这轮要干活」→ 云端。本地小模型不会调工具，交给自己答只会嘴上答应。
// 关键词式（宁可多走云端）：命中任何一个就说明这轮可能需要工具或看屏幕。
const TOOL_INTENT =
  /屏幕|桌面|画面|截图|监听|录音|打开|关闭|启动|停止|文件|目录|端口|进程|日志|代码|脚本|命令|执行|安装|部署|编译|构建|报错|崩溃|bug|修复|测试|路径|数据库|sqlite|git|npm|pnpm|powershell|查一下|看一下|改一下|写一下|跑一下|帮我/
// 「复杂推理」→ 云端。0.6B/4B 的推理能力撑不住，宁可用云端。
const COMPLEX =
  /分析|推理|证明|推导|计算|估算|设计|架构|方案|对比|权衡|评估|总结|归纳|翻译成|改写|润色|写一篇|写一段|长文|论文|报告|代码|算法|公式|为什么|原理|机制/
// 本地模型上下文预算（c=4096）。中文约 1 字≈1 token，留 1000 给输出。
// 用小预算 + 精简 system：精简版约 2000 字，加 4 轮历史仍在 4096 内。
const LOCAL_MAX_INPUT_CHARS = 3600
// system 段单独的上限（精简版正常不会撞到，撞到就是调用方给多了）
const LOCAL_SYSTEM_BUDGET = 2600

/**
 * 判断这轮是否必须走云端。
 * 反转了旧策略：以前是「命中简单/情绪才本地」，现在是「命中复杂/工具/超长才云端」。
 */
export function needsCloud(options, text, sysOverride = null) {
  const s = String(text || '').trim()
  if (!s) return true
  if (TOOL_INTENT.test(s)) return true
  if (COMPLEX.test(s)) return true
  // 没有精简 system 可用时，原始 system 太长就直接云端（不冒险截断丢人设）
  if (!sysOverride && rawSystemLength(options) > LOCAL_SYSTEM_BUDGET) return true
  // 有精简版时按「实际会发给本地」的规模算（精简 system + 最近 4 轮）
  const msgs = buildLocalMessages(options, text, sysOverride)
  const total = msgs.reduce((n, m) => n + String(m.content || '').length, 0)
  if (total > LOCAL_MAX_INPUT_CHARS) return true
  return false
}

/** 判定原因（写日志用）：tool / complex / raw-system / long / null */
export function cloudReason(options, text, sysOverride = null) {
  const s = String(text || '').trim()
  if (!s) return 'empty'
  if (TOOL_INTENT.test(s)) return 'tool'
  if (COMPLEX.test(s)) return 'complex'
  if (!sysOverride && rawSystemLength(options) > LOCAL_SYSTEM_BUDGET) return 'raw-system:' + rawSystemLength(options)
  const msgs = buildLocalMessages(options, text, sysOverride)
  const total = msgs.reduce((n, m) => n + String(m.content || '').length, 0)
  if (total > LOCAL_MAX_INPUT_CHARS) return 'long:' + total
  return null
}

async function localGenerate(text, url = LOCAL_LLM_URL, ensure = false, options = null, sysOverride = null) {
  if (ensure && url === OMNI_URL) {
    try {
      const { ensureRunning, portUp } = await import('./services.mjs')
      if (!(await portUp(OMNI_PORT))) {
        const r = await ensureRunning('omni', { logger, waitMs: 40000, retries: 2 })
        if (!r.ok) return ''
      }
    } catch {}
  }
  const messages = buildLocalMessages(options, text, sysOverride)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3',
      messages,
      max_tokens: 300,
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!res.ok) throw new Error(`local llm HTTP ${res.status}`)
  const data = await res.json()
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

/**
 * 安装分流层
 * @param {object} opts { ctx, dataDir, logger, isEnabled: () => bool }
 */
export function isOfflineMode() {
  return offlineMode
}

export function resetOfflineMode() {
  offlineMode = false
  cloudFailures = 0
}

export function installLlmBridge({
  ctx,
  dataDir,
  logger = console,
  isEnabled = () => true,
  buildLocalSystem = null,
  // 关键：判断某个会话是不是 HCEM 会话。
  // 分流层挂在全局 llm/stream 上，不区分会话的话会把标准会话的对话也劫持给本地模型。
  isHcemSession = () => false,
}) {
  let bridgeHits = 0
  const isHcem = (sessionId) => {
    try {
      if (!sessionId) return false
      return Boolean(isHcemSession(sessionId))
    } catch {
      return false
    }
  }
  // 本地用的精简 system（me → 角色卡 → 用户卡 → 安全阀 → 感知 → 搭话），由 index.mjs 提供
  const localSystem = () => {
    try {
      return typeof buildLocalSystem === 'function' ? String(buildLocalSystem() || '') : ''
    } catch {
      return ''
    }
  }
  // 诊断：把调用情况写进我们的日志文件（logger.info 走 DSH 的日志，看不到）
  const dlog = (m) => {
    try {
      if (typeof globalThis.__hcemBridgeLog === 'function') globalThis.__hcemBridgeLog(m)
    } catch {}
  }
  // 注意：不要在这里读 ctx.llm —— 访问未 inject 的服务会抛错
  dlog('[llm-bridge] 安装: ctx.on=' + typeof ctx?.on + ' ctx.waterfall=' + typeof ctx?.waterfall)
  ctx.on(
    'llm/stream',
    (options, next) => {
      bridgeHits += 1
      if (bridgeHits <= 5 || bridgeHits % 20 === 0) {
        const m = '[hcem] 分流层被调用 #' + bridgeHits + ' purpose=' + String(options?.purpose ?? '?')
        logger.info?.(m)
        dlog(m)
      }
      // 只处理主对话请求（跳过工具/标题/压缩等内部用途）
      const purpose = String(options?.purpose ?? '')
      if (purpose && purpose !== 'chat') return next()
      // 只处理 HCEM 会话：标准/cordis 会话的对话必须放行云端，
      // 否则本地模型会替用户答话（实测发生过：连续四条回复都是 Omni 生成的）。
      if (!isHcem(options?.sessionId)) {
        dlog('[llm-bridge] 非 HCEM 会话，放行云端 sessionId=' + String(options?.sessionId ?? '?'))
        return next()
      }
      const text = lastUserText(options)
      if (!text) return next()

      // 一次性「强制本地」标记：气泡（主动说话）那一轮必须走本地，别烧云端额度。
      // 由 index.mjs 在投递前打标，这里消费一次就清掉，不影响后续正常对话。
      const sid = String(options?.sessionId ?? '')
      const forcedLocal = sid ? forceLocalSessions.delete(sid) : false
      if (forcedLocal) dlog('[llm-bridge] 本轮强制本地（主动说话）sessionId=' + sid)

      // 「本地分流」开关必须真的控制分流层（判定放在生成器里，return next() 才合法）
      const routeOn = forcedLocal || localRouteOn()

      // 生成器：分流判断是异步的，用 async generator 包一层
      const self = async function* () {
        if (!isEnabled()) {
          for await (const chunk of next()) yield chunk
          return
        }
        // 关掉本地分流就完全不介入：不查缓存、不本地生成、直接放行云端。
        // 以前这里只看 settings.enabled，导致"关掉分流仍被本地截留、反复同一句话"。
        if (!routeOn) {
          dlog('[llm-bridge] 本地分流未开启，放行云端 sessionId=' + sid)
          for await (const chunk of next()) yield chunk
          return
        }
        // 离线模式：视觉活跃（看视频占显存）→ qwen3 接管会话+视听；否则 therapy
        if (offlineMode) {
          try {
            const visualActive = await isVisualActive()
            // 视频播放完（视觉不活跃）+ 用户说话 → 拉起 therapy
            if (!visualActive && !therapyStarting) {
              therapyStarting = true
              try {
                const { startService, portUp } = await import('./services.mjs')
                if (!(await portUp(THERAPY_PORT))) {
                  startService('omni', logger)
                  logger.info?.('[hcem] 视频结束，拉起 omni（原 therapy 模型缺失，改用 OmniDimen）')
                  // 等就绪（最多 20s）
                  for (let i = 0; i < 20; i += 1) {
                    await new Promise((r) => setTimeout(r, 1000))
                    if (await portUp(THERAPY_PORT)) break
                  }
                }
              } catch {}
              therapyStarting = false
            }
            const url = visualActive ? LOCAL_LLM_URL : THERAPY_URL
            logger.info?.(`[hcem] llm-bridge: 离线模式（${visualActive ? 'qwen3 接管视听' : 'therapy'}）`)
            const answer = await localGenerate(text, url)
            if (answer) {
              logger.info?.('[hcem] llm-bridge: 离线模式（OmniDimen）')
              recordAnswer(dataDir, answer)
              yield* textChunks(answer)
              return
            }
          } catch (error) {
            logger.warn?.(`[hcem] OmniDimen 不可用: ${String((error && error.message) || error)}`)
          }
        }
        // ① 语义缓存
        try {
          const hit = await lookupCache(text, { dataDir })
          if (hit.hit && hit.answer) {
            logger.info?.(`[hcem] llm-bridge: 语义缓存命中 (${(hit.score || 0).toFixed(3)})`)
            recordAnswer(dataDir, hit.answer)
            yield* textChunks(hit.answer)
            return
          }
        } catch (error) {
          logger.debug?.(`[hcem] llm-bridge 缓存查询失败: ${String((error && error.message) || error)}`)
        }
        // ② 默认本地（反转后的策略）：
        //    只有「工具意图 / 复杂推理 / 上下文超长」才放行云端，其余都交给本地。
        //    system 用精简版（me 在最前 + 角色卡 + 用户卡 + 安全阀 + 感知 + 搭话），不走整段 system。
        const sys = localSystem()
        if (forcedLocal || !needsCloud(options, text, sys)) {
          const emotional = forcedLocal ? true : isEmotionalRequest(text)
          try {
            const url = emotional ? OMNI_URL : LOCAL_LLM_URL
            const answer = await localGenerate(text, url, emotional, options, sys)
            if (answer) {
              logger.info?.(emotional ? '[hcem] llm-bridge: OmniDimen 本地处理（0 云端）' : '[hcem] llm-bridge: Qwen3 本地处理（0 云端）')
              dlog('[llm-bridge] 本地生成 len=' + answer.length + ' sys=' + sys.length + ' url=' + url)
              recordAnswer(dataDir, answer)
              yield* textChunks(answer)
              // 写入缓存（短路回答）
              try {
                const vec = await embedText(text)
                storeCache({ dataDir, text, embedding: vec, answer })
              } catch {}
              return
            }
            logger.warn?.('[hcem] llm-bridge 本地返回空，回退云端')
          } catch (error) {
            logger.warn?.(`[hcem] llm-bridge 本地生成失败，回退云端: ${String((error && error.message) || error)}`)
          }
        } else {
          dlog('[llm-bridge] 走云端 reason=' + String(cloudReason(options, text, sys)) + ' sys=' + sys.length)
        }
        // ③ 放行云端，旁路记录回答（用于缓存）；失败计数 → 离线降级
        const parts = []
        try {
          for await (const chunk of next()) {
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
            yield chunk
          }
          cloudFailures = 0
        } catch (error) {
          cloudFailures += 1
          if (cloudFailures >= CLOUD_FAIL_LIMIT) {
            offlineMode = true
            logger.warn?.('[hcem] 云端连续失败，切换离线模式（OmniDimen）')
          }
          throw error
        }
        const answer = parts.join('').trim()
        recordAnswer(dataDir, answer)
        if (answer.length >= 10 && answer.length <= 2000) {
          try {
            const vec = await embedText(text)
            storeCache({ dataDir, text, embedding: vec, answer })
          } catch {}
        }
      }
      return self()
    },
    { global: true },
  )
}
