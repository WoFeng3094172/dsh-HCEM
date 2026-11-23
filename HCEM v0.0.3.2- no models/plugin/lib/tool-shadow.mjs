import './home.mjs'
/**
 * 工具描述压缩（只在 HCEM 会话生效、可随时关掉）。
 *
 * 原理：DSH 允许在 **agent 作用域**注册同名工具，会遮住全局那个（scoped shadows global）。
 * 我们拿原始定义、只换 description（必要时精简参数说明），execute / output 全部沿用原件，
 * 所以行为不变，只省上下文。
 *
 * 回滚：把 data/ui-state/tool-shadow.json 里的 enabled 改成 false，重启 DSH 即可。
 * 原始描述永远在 DSH 包里，另外 docs/工具描述原文.md 有完整备份。
 */

/** 第一人称压缩描述。参数名保留（模型选参靠它），只砍解释性长句。 */
export const SHADOW_DESCRIPTIONS = {
  read: '我按行读一个 UTF-8 文本文件，带行号。file_path 必填，offset/limit 可选。',
  write: '我新建或整体覆盖一个文本文件。file_path + content。',
  edit: '我把文件里一段唯一原文换掉（new_string 留空=删）。file_path、old_string、new_string。',
  read_image: '我看一张图（PNG/JPEG/WebP/GIF），大图会自动缩小。file_path 必填。',
  glob: '我按通配符找文件（不返回目录），最多 100 个，按修改时间排序。pattern 必填，path 指定搜哪。',
  grep: '我在文件内容里搜正则（ripgrep 语法），返回匹配行和行号，最多 250 条。pattern 必填，path 限定范围，include 限定文件类型。',
  pwsh: '我跑一条 PowerShell 命令，拿回 stdout/stderr。command 必填、description 写 5~10 字说明；workdir 指定目录；timeoutMs 超时毫秒；run_in_background 放后台。输出太长会截尾，完整版存文件并告诉我路径。',
  job_list: '我列出自己的后台任务。',
  job_output: '我读后台任务的输出；wait=true 会等它结束。job_id 必填。',
  job_kill: '我取消一个后台任务。job_id 必填。',
  web_search: '我上网搜资料，返回摘要和来源链接。queries 是 1~10 条搜索词。',
  web_fetch: '我抓一个网页并转成文本。url 必填。',
  todo_write: '我维护一份待办清单来规划多步任务（每次传完整列表）。todos 里每项有 content 和 status。',
  ask_user_question: '我向用户提结构化问题，可给选项和多选。questions 是问题列表。',
  schedule_create: '我建一个定时任务：到点把 prompt 当作用户消息发到会话。title、prompt、rrule、target 必填。',
  schedule_list: '我列出定时任务（含历史）。',
  schedule_view: '我看一个定时任务的详情。id 必填。',
  schedule_edit: '我改、暂停或删除定时任务。id + action 必填。',
  working_directory: '我读当前工作目录，或切换过去。cd 填目录就切换，不填就只读。',
  load_workspace_dependencies: '我拿到内置 Python/Node 的路径和版本（Python 带 numpy/pandas/openpyxl 等）。',
}

/** 参数说明里保留哪些字段（其余按原名保留，只是不改） */
export function slimParameters(obj, keepDescriptions = true) {
  // 目前只做描述层压缩：参数原样保留，避免模型选参出错。
  return obj
}

/** 读取开关：data/ui-state/tool-shadow.json { enabled: true } */
export function shadowEnabled(readFileSync) {
  try {
    const j = JSON.parse(readFileSync(`${globalThis.__HCEM_HOME__}/data/ui-state/tool-shadow.json`, 'utf8'))
    return j?.enabled === true
  } catch {
    return false
  }
}

/**
 * 在某个 agent 作用域里注册同名影子工具。
 * @param {object} toolsCtx 该 agent 的 tools 服务（Scoped）
 * @param {(name:string)=>object|undefined} getOriginal
 * @returns {{ok:boolean, names:string[], error?:string}}
 */
export function installShadow(toolsCtx, getOriginal) {
  const names = []
  if (!toolsCtx || typeof toolsCtx.register !== 'function') {
    return { ok: false, names, error: 'no scoped tools ctx' }
  }
  for (const [name, desc] of Object.entries(SHADOW_DESCRIPTIONS)) {
    try {
      const orig = getOriginal(name)
      if (!orig) continue
      toolsCtx.register({ ...orig, description: desc })
      names.push(name)
    } catch {}
  }
  return { ok: names.length > 0, names }
}
