/**
 * 解析 Python 解释器路径。
 *
 * 优先用 HCEM 自己的 venv：DSH 升级运行时时会把当前目录改名成
 * `dsh-primary-runtime.previous` 再装新的，旧运行时里的第三方包（pyaudiowpatch、
 * numpy…）会一起消失。实测这次升级后录音直接挂掉：
 *   ModuleNotFoundError: No module named 'pyaudiowpatch'
 * 而且升级过程中 HCEM 的 Python 子进程还占着旧 exe，DSH 删不掉，报
 *   EPERM: operation not permitted, unlink ...dsh-primary-runtime.previous\...\python.exe
 *
 * 顺序：环境变量 > HCEM 自带 venv > dsh-runtimes 下可用运行时（跳过 .previous）> PATH 的 python
 */

import { existsSync, readdirSync } from 'node:fs'
import '../home.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** HCEM 自己的 venv（首次运行时装好依赖，不随 DSH 升级丢失） */
const HCEM_VENV = `${globalThis.__HCEM_HOME__}/python-venv/Scripts/python.exe`

let cached = null

/** @returns {string} python 可执行文件路径（可能是不存在的 'python' 兜底） */
export function resolvePython() {
  if (process.env.HCEM_PYTHON) return process.env.HCEM_PYTHON
  if (cached && existsSync(cached)) return cached

  if (existsSync(HCEM_VENV)) {
    cached = HCEM_VENV
    return cached
  }

  const root = join(homedir(), '.dsh', 'dsh-runtimes')
  const found = []
  try {
    for (const name of readdirSync(root)) {
      const exe = join(root, name, 'dependencies', 'python', 'python.exe')
      if (!existsSync(exe)) continue
      // `.previous` 是被替换下来的旧运行时：能用（兜底），但排在最后
      found.push({ exe, retired: /\.previous$/i.test(name), name })
    }
  } catch {
    // 没有 dsh-runtimes 目录就走 PATH
  }
  found.sort((a, b) => Number(a.retired) - Number(b.retired) || b.name.localeCompare(a.name))
  cached = found[0]?.exe ?? 'python'
  return cached
}

/** 清缓存（运行时装好时用） */
export function resetPythonCache() {
  cached = null
}
