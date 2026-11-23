/**
 * hcem_sh：插件侧命令执行器（自带编码修正）
 *
 * 为什么需要：DSH 的 pwsh 工具会在每条命令前拼
 *   `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`
 * 而只读沙箱里 pwsh 是 ConstrainedLanguage，.NET 调用被禁 → 这句失败 →
 * 编码没设上，pwsh 按系统 OEM 码页（中文 Windows 是 GBK/936）写字节，
 * DSH 又按 UTF-8 解码 → 中文全变乱码，而且 chcp 65001 也救不了（管道不是控制台）。
 *
 * 这个执行器自己拿 Buffer，先按 UTF-8 严格解码，失败再按 GBK 解码，
 * 所以中文能正确还原。它也**不受 DSH 文件沙箱限制**（跑在插件进程里）。
 *
 * 安全阀：破坏性命令（format / diskpart / shutdown / mkfs 等）必须显式 force:true。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'

const run = promisify(execFile)

// 选可执行文件：本机只装了 Windows PowerShell 5.1（DSH 的 pwsh 工具也回退到它）。
// 5.1 默认按 OEM 码页输出，所以下面必须做 GBK 解码兜底。
const SHELL_EXE = (() => {
  if (process.env.HCEM_PWSH) return process.env.HCEM_PWSH
  for (const p of ['C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe', 'C:\\\\Program Files\\\\PowerShell\\\\7-preview\\\\pwsh.exe']) {
    if (existsSync(p)) return p
  }
  return 'powershell.exe'
})()

// 破坏性命令判定：只看「命令首词」，不做任意位置子串匹配
// （否则 Get-Date -Format、Export-Csv -Format 这类会被 -Format 误杀）
const DANGEROUS_HEAD = /^\s*(?:cmd\s+\/c\s+)?(format(?:\.com)?|diskpart|mkfs(?:\.[a-z]+)?|shutdown|restart-computer|stop-computer|clear-disk|initialize-disk)\b/i
// 删除类必须带强制/递归参数才算破坏性
const DANGEROUS_DELETE = /^\s*(?:cmd\s+\/c\s+)?(rd|rmdir|del|erase|remove-item)\b[^\n]*\s(\/(?:s|q)\b|-(?:recurse|force)\b)/i

function decodeBuffer(buf, encoding = 'auto') {
  if (!buf || buf.length === 0) return ''
  const tryDecode = (label, opts = {}) => {
    try {
      return new TextDecoder(label, { fatal: true, ...opts }).decode(buf)
    } catch {
      return null
    }
  }
  if (encoding === 'utf8') return tryDecode('utf-8') ?? buf.toString('utf8')
  if (encoding === 'gbk') return tryDecode('gbk') ?? buf.toString('latin1')
  if (encoding === 'latin1') return buf.toString('latin1')
  // auto：先 UTF-8 严格，失败再 GBK（中文 Windows 的 OEM 码页）
  const utf8 = tryDecode('utf-8')
  if (utf8 !== null) return utf8
  const gbk = tryDecode('gbk')
  if (gbk !== null) return gbk
  return buf.toString('utf8')
}

/**
 * 跑一条命令。
 * @param {{command:string, workdir?:string, timeoutMs?:number, encoding?:'auto'|'utf8'|'gbk'|'latin1', force?:boolean}} o
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null, encodingUsed:string, error?:string}>}
 */
export async function runCommand({ command, workdir, timeoutMs = 60000, encoding = 'auto', force = false } = {}) {
  const cmd = String(command || '').trim()
  if (!cmd) return { ok: false, stdout: '', stderr: '', code: null, encodingUsed: encoding, error: 'empty command' }
  if (!force && (DANGEROUS_HEAD.test(cmd) || DANGEROUS_DELETE.test(cmd))) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      encodingUsed: encoding,
      error: '命令看起来是破坏性的（format/diskpart/shutdown 等）。确认要执行请带 force=true。',
    }
  }
  try {
    const r = await run(SHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      cwd: workdir || undefined,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
      windowsHide: true,
    })
    return {
      ok: true,
      stdout: decodeBuffer(r.stdout, encoding),
      stderr: decodeBuffer(r.stderr, encoding),
      code: 0,
      encodingUsed: encoding,
    }
  } catch (e) {
    const stdout = e?.stdout ? decodeBuffer(e.stdout, encoding) : ''
    const stderr = e?.stderr ? decodeBuffer(e.stderr, encoding) : ''
    return {
      ok: false,
      stdout,
      stderr,
      code: typeof e?.code === 'number' ? e.code : null,
      encodingUsed: encoding,
      error: stderr || String((e && e.message) || e).slice(0, 300),
    }
  }
}

export { decodeBuffer }
