/**
 * 工具向量目录（自动更新版）
 *
 * 目的：把「低频但占上下文多」的工具从常驻里撤掉，按需检索注入。
 *
 * 已验证（2026-11-21 运行时探针）：
 *   · `agent.ctx.tools.register(def)` 只对那个 agent 生效，host 看不到
 *   · scoped 注册不受 restrict 影响（文档：restrictions intersect; scoped registrations remain visible）
 *
 * 自动更新策略（应对 DSH 升级/插件增删）：
 *   1. 目录成员不是写死的列表，而是「当时该 agent 可见的全部工具 − 常驻白名单」
 *      → DSH 新增工具自动进目录；删除自动消失
 *   2. 每个工具的「名字+描述+参数名」算哈希；变了只重算变的那几个（增量）
 *   3. `tools/change` 事件触发重新枚举 + 重建掩码 + 索引失效
 *   4. 施加掩码**之前**先快照定义——被 deny 的工具读起来就是不存在，之后拿不到
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import './home.mjs'
import { join } from 'node:path'

const DATA = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
const CACHE = join(DATA, 'ui-state', 'tool-vectors.json')

/**
 * 常驻白名单：高频、短小，留在上下文里。
 * 陪伴型会话里「搜一下」比「读写文件」常用得多，所以 web_* 常驻、write/glob 进目录。
 */
export const RESIDENT_ALLOW = ['read', 'grep', 'web_search', 'web_fetch']

/** 永远不目录化的：目录入口自己 + 运行时内部工具 */
const NEVER = new Set(['hcem_tools', 'run_code'])

/**
 * 从「该 agent 可见的工具名」算出应该目录化的一批。
 * 规则：常驻白名单 + 全部 hcem_* 保留，其余进目录。
 */
export function computeCatalogNames(visibleNames) {
  const names = (visibleNames || []).filter(Boolean)
  const keep = new Set(RESIDENT_ALLOW)
  for (const n of names) if (n.startsWith('hcem_')) keep.add(n)
  return names.filter((n) => !keep.has(n) && !NEVER.has(n))
}

/**
 * 快照某个 agent 现在能看到的工具定义（必须在施加 deny 之前调用）。
 *
 * 双来源：
 *   1. definitions(agent) 拿到名字清单（含 scoped 注册的，比如 preset 插件贡献的工具）
 *   2. 再按名字用 get(name, agent) 取**完整定义**（带 execute / output）
 * 若第 2 步拿不到可执行体，就退回清单里的那份——但会在注入时被拦下并记日志，
 * 避免"注入成功但调用就报错"的静默故障。
 */
export function captureDefs(hostTools, agent) {
  const map = new Map()
  let names = []
  try {
    const list = agent ? hostTools?.definitions?.(agent) ?? [] : hostTools?.definitions?.() ?? []
    names = list.filter((d) => d?.name).map((d) => d.name)
    for (const d of list) map.set(d.name, d)
  } catch {}
  for (const name of names) {
    try {
      const full = hostTools?.get?.(name, agent) ?? hostTools?.get?.(name)
      if (full && typeof full.execute === 'function') map.set(name, full)
    } catch {}
  }
  return map
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 中文索引词：只用于向量化，不展示给模型。
 * 原因：DSH 的工具描述是英文（pwsh 那条 2000+ 字符全是沙箱说明），
 * 中文提问检索命中很差。补一句中文「这工具干什么」能显著改善。
 */
const INDEX_GLOSS = {
  pwsh: '跑命令 执行脚本 命令行 终端 查看磁盘空间 进程 文件列表 系统信息',
  write: '新建文件 保存文本 覆盖写入',
  glob: '找文件 文件在哪 列出文件 项目里有哪些文件 按通配符找文件',
  job_list: '后台任务列表 哪些任务在跑 任务清单（不是文件）',
  job_output: '看任务跑完没有 任务结果 任务输出 任务日志',
  job_kill: '取消后台任务 终止任务',
  web_search: '上网搜索 查资料 查天气 查新闻',
  web_fetch: '抓取网页 读取网址内容',
  todo_write: '待办清单 任务规划 记录步骤',
  ask_user_question: '向用户提问 请用户选择 确认',
  schedule_create: '定时任务 每天提醒 定时器 到点提醒',
  schedule_list: '查看定时任务列表',
  schedule_view: '查看某个定时任务详情',
  schedule_edit: '修改定时任务 暂停 删除定时任务',
  working_directory: '当前工作目录 切换目录 pwd cd',
  load_workspace_dependencies: '内置 Python Node 解释器 路径 版本 预装库 numpy pandas',
  read_image: '查看图片 看图',
  read: '读文件 看文件内容',
  edit: '改文件 替换内容',
  grep: '搜索文件内容 正则 查找代码',
}

function textOf(def) {
  const params = def?.parameters?.properties || {}
  const gloss = INDEX_GLOSS[def.name] || ''
  // 描述只取前 220 字：长描述（如 pwsh 的沙箱说明）会淹没语义
  const desc = String(def.description || '').slice(0, 220)
  return `${def.name}｜${gloss}｜${desc}｜参数：${Object.keys(params).join(', ')}`
}

function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

function loadCache() {
  try {
    const j = JSON.parse(readFileSync(CACHE, 'utf8'))
    if (j && typeof j === 'object' && j.tools) return j
  } catch {}
  return { tools: {} }
}

function saveCache(c) {
  try {
    mkdirSync(join(DATA, 'ui-state'), { recursive: true })
    writeFileSync(CACHE, JSON.stringify(c), 'utf8')
  } catch {}
}

/**
 * 确保索引覆盖给定工具；只对新增/变化的做向量化（增量）。
 * @param {{defs: Map<string,object>, embed: (t:string[])=>Promise<number[][]>, log?: Function}} o
 * @returns {Promise<{items:{name:string,desc:string,vec:number[]}[], built:number, reused:number}>}
 */
export async function ensureIndex({ defs, embed, log = () => {} }) {
  const cache = loadCache()
  const targets = []
  let reused = 0
  for (const [name, def] of defs) {
    const text = textOf(def)
    const h = fnv(text)
    const hit = cache.tools[name]
    if (hit && hit.hash === h && Array.isArray(hit.vec)) {
      reused += 1
      continue
    }
    targets.push({ name, text, hash: h, desc: String(def.description || '').slice(0, 120) })
  }

  // 清掉已经不存在于 registry 的工具
  let pruned = 0
  for (const name of Object.keys(cache.tools)) {
    if (!defs.has(name)) {
      delete cache.tools[name]
      pruned += 1
    }
  }

  if (targets.length) {
    log(`embedding ${targets.length} tools (reuse ${reused})…`)
    const t0 = Date.now()
    const vecs = await embed(targets.map((t) => t.text))
    targets.forEach((t, i) => {
      cache.tools[t.name] = { hash: t.hash, desc: t.desc, vec: vecs[i] }
    })
    log(`embedded ${targets.length} in ${Date.now() - t0}ms`)
  }
  // 注意：只有「删除了工具」而没有新增时，也要落盘，否则下次还会从缓存里读到旧工具
  if (targets.length || pruned) saveCache(cache)

  const items = []
  for (const [name, def] of defs) {
    const rec = cache.tools[name]
    if (rec?.vec) items.push({ name, desc: rec.desc || String(def.description || '').slice(0, 120), vec: rec.vec })
  }
  return { items, built: targets.length, reused }
}

/** 检索 top-k */
export async function searchTools({ query, items, embed, k = 3 }) {
  const [qv] = await embed([query])
  if (!qv) return []
  return items
    .map((it) => ({ name: it.name, desc: it.desc, score: cosine(qv, it.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/**
 * 注入时替换描述（只影响 HCEM 会话）。
 *
 * 为什么需要：DSH 的 pwsh 工具会在每条命令前拼一句
 * `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`
 * 来避免 Windows 控制台按 OEM 码页输出。但**只读沙箱**里 pwsh 跑在
 * ConstrainedLanguage，.NET 静态方法被禁 → 这句必然报错（stderr 噪音），
 * 编码也没设上 → 中文输出变乱码。
 *
 * 我们改不了 DSH 的包，但可以在注入时把「沙箱下哪条路能走」写进描述。
 */
const DESCRIPTION_OVERRIDE = {
  pwsh:
    '我在 PowerShell 里跑一条命令，拿回 stdout/stderr。command、description 必填，workdir/timeoutMs 可选。\n' +
    '沙箱注意（实测）：\n' +
    '· 只读模式下 .NET 静态调用被禁，每条命令开头 DSH 会拼的 OutputEncoding 那行必然报错——' +
    '这是噪音，忽略即可；但中文输出会乱码，所以**让命令尽量只输出 ASCII**。\n' +
    '· 磁盘/卷信息：Get-PSDrive 的 Used/Free 在沙箱下是 0；Get-CimInstance / Get-Volume 报 PermissionDenied；' +
    'wmic 可能没装。可行的是 `cmd /c dir /-c`（看「可用字节」那行）或 `fsutil volume diskfree C:`。\n' +
    '· 进程/服务：Get-Process 可用；Get-CimInstance 一般被拦。\n' +
    '· 需要真正放开权限或要中文输出时：优先用 hcem_sh（插件侧执行，编码正确、不受沙箱限制），' +
    '或让用户把会话沙箱切到 workspace-write。',
}

/** 注入时按名字套用描述替换 */
export function applyDescriptionOverride(def) {
  const text = DESCRIPTION_OVERRIDE[def?.name]
  return text ? { ...def, description: text } : def
}

// ── 作用域注册 ─────────────────────────────
const registeredByAgent = new WeakMap()

/**
 * 把指定工具注册进某个 agent 的作用域（用快照里的原始定义）。
 * @param {object} agent
 * @param {Map<string,object>} defs  该 agent 的**掩码前**定义快照
 * @param {string[]} names
 */
export function registerScoped(agent, defs, names) {
  const ok = []
  const failed = []
  const scoped = agent?.ctx?.tools
  if (!scoped || typeof scoped.register !== 'function') {
    return { ok, failed: names.map((n) => n + ':no-scoped-ctx') }
  }
  let bag = registeredByAgent.get(agent)
  if (!bag) {
    bag = new Set()
    registeredByAgent.set(agent, bag)
  }
  for (const name of names) {
    if (bag.has(name)) {
      ok.push(name)
      continue
    }
    const def = defs?.get?.(name)
    if (!def) {
      failed.push(name + ':no-def')
      continue
    }
    // 没有可执行体的定义不能注入：否则模型调它必定报错，而且看不出是空的
    if (typeof def.execute !== 'function') {
      failed.push(name + ':def-without-execute')
      continue
    }
    try {
      scoped.register(applyDescriptionOverride({ ...def }))
      bag.add(name)
      ok.push(name)
    } catch (e) {
      failed.push(name + ':' + String((e && e.message) || e).slice(0, 60))
    }
  }
  return { ok, failed }
}

export function registeredNames(agent) {
  const bag = registeredByAgent.get(agent)
  return bag ? [...bag] : []
}

/** 索引缓存文件路径（tools/change 时可以整个删掉强制重建） */
export function forgetIndex() {
  try {
    if (existsSync(CACHE)) writeFileSync(CACHE, JSON.stringify({ tools: {} }), 'utf8')
  } catch {}
}
