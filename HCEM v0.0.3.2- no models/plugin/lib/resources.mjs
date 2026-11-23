/**
 * 本地资源探针：显存 / 内存 / 压力地板
 *
 * 为什么要：8 GB 显存下 Omni(≈2.75G) + VL(≈2.6G) + Embedding(≈1.0G) + TTS(≈1.5G)
 * 同时在线就会顶满，llama.cpp 分配失败会直接让对应模型不可用。
 * 这里给「Aqua 水槽」提供一个下限：资源越紧，水槽越难漏下去，
 * 于是主动说话/额外本地推理会被自然压住。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const run = promisify(execFile)
const CACHE_MS = 5000
let cache = { at: 0, v: null }

/** 读显存（nvidia-smi），失败返回 null（非 N 卡/驱动缺失） */
export async function vram() {
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
    )
    const [used, total] = String(stdout)
      .trim()
      .split('\n')[0]
      .split(',')
      .map((x) => Number(x.trim()))
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
    return { used, total, ratio: used / total, free: total - used }
  } catch {
    return null
  }
}

export function memory() {
  const total = os.totalmem()
  const free = os.freemem()
  return { total, free, ratio: total > 0 ? (total - free) / total : 0 }
}

/**
 * 资源压力（0~1）与「Aqua 地板」。
 *   显存占 80% → 地板 50；90% → 65；97% → 80（>=60 时主动说话已被硬闸挡住）
 * @returns {Promise<{vram:object|null, mem:object, pressure:number, floor:number}>}
 */
export async function resourceState() {
  const now = Date.now()
  if (cache.v && now - cache.at < CACHE_MS) return cache.v
  const v = await vram()
  const m = memory()
  // 显存为主（模型都在这），内存为辅
  const vRatio = v ? v.ratio : 0
  const pressure = Math.max(0, Math.min(1, vRatio * 0.75 + m.ratio * 0.25))
  let floor = 0
  if (v && v.ratio >= 0.97) floor = 80
  else if (v && v.ratio >= 0.9) floor = 65
  else if (v && v.ratio >= 0.8) floor = 50
  const out = { vram: v, mem: m, pressure, floor }
  cache = { at: now, v: out }
  return out
}

/** 给提示词/工具用的一行文字 */
export function resourceLine(st) {
  const parts = []
  if (st.vram) parts.push(`显存 ${st.vram.used}/${st.vram.total} MiB（${Math.round(st.vram.ratio * 100)}%）`)
  const m = st.mem
  parts.push(`内存可用 ${(m.free / 1024 / 1024 / 1024).toFixed(1)}/${(m.total / 1024 / 1024 / 1024).toFixed(1)} GiB`)
  parts.push(`压力 ${(st.pressure * 100).toFixed(0)}%`)
  if (st.floor > 0) parts.push(`Aqua 地板 ${st.floor}（资源紧张，主动说话会被压住）`)
  return parts.join('｜')
}
