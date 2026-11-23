/**
 * 存储管家：定期清理“用完就没用”的临时音频/图片，防止磁盘越堆越大
 *
 * 分工原则：
 *   可删（临时产物）：录音、合成语音、截屏、视频摘要中间帧、云端故事板
 *   永不删（记忆资产）：角色卡、用户卡、日记、记忆分区、人物网、工作记忆、前世记忆
 *
 * 两道闸门：
 *   ① 按目录的保留时长（到点就删）
 *   ② 总量上限（整个数据目录超过上限，从“可删目录”里按最旧开始删，直到降到上限以下）
 *
 * 调用时机：插件启动时一次 + 每小时一次。
 */

import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

/** 每个目录的保留策略（毫秒） */
// 保留时长严格对齐「记忆分区」的遗忘规则（zones.mjs）：
//   视觉：video_buffer 2h → video_1 24h → video_2 永久
//   听觉：audio_buffer 2h → audio_1 24h → audio_2 永久
// 临时文件只在「还没进永久区」前有用，进永久区时会复制到 protect 目录。
export const RETENTION = {
  captures: 30 * 60 * 1000, // 截屏：30 分钟（采集层自己还有 60 张上限）
  audio: 24 * 3600 * 1000, // 录音：24 小时（对齐 audio_1 的上限）
  tts: 2 * 3600 * 1000, // 合成语音：2 小时（播放完就没用了）
  'video-digest': 3 * 24 * 3600 * 1000, // 视频摘要中间帧：3 天
  'cloud-board': 7 * 24 * 3600 * 1000, // 云端故事板：7 天（要对账）
  'tts-compare': 7 * 24 * 3600 * 1000, // 语音对比样本：7 天
  'voice-input': 24 * 3600 * 1000, // 语音输入录音：24 小时（用户要求）
}

/** 永不清理的目录（记忆资产） */
export const PROTECTED = [
  'keep', // 保护目录：与向量记忆绑定，只有记忆被遗忘时才删
  'persona',
  'journal',
  'zones',
  'reincarnation',
  'people',
  'work',
  'voiceprints',
  'ui',
  'kv-cache', // 由推理服务自己管
]

/** 默认可删目录的清理优先级（越靠前越先删） */
const PRUNE_ORDER = ['captures', 'audio', 'tts', 'video-digest', 'tts-compare', 'cloud-board', 'voice-input']

export const DEFAULT_QUOTA_MB = 2048 // 2GB

/** 统计某目录的总大小 */
function dirSize(dir) {
  let total = 0
  let files = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          const sub = dirSize(p)
          total += sub.total
          files += sub.files
        } else {
          total += st.size
          files += 1
        }
      } catch {}
    }
  } catch {}
  return { total, files }
}

/** 按保留时长删除。onlyExt 非空时只处理该扩展名（避免误删 .mic-device.json 这类配置） */
function sweepByAge(dir, maxAgeMs, now = Date.now(), onlyExt = null) {
  let removed = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      // 隐藏文件（.mic-device.json 这类配置）永不清理
      if (name.startsWith('.')) continue
      // 指定了扩展名就只处理那种
      if (onlyExt && !name.toLowerCase().endsWith(onlyExt)) continue
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          // 视频摘要这类是一层子目录
          const sub = sweepByAge(p, maxAgeMs, now, onlyExt)
          removed += sub.removed
          bytes += sub.bytes
          // 空目录顺手删掉
          try {
            if (readdirSync(p).length === 0) rmdirSync(p)
          } catch {}
          continue
        }
        if (now - st.mtimeMs > maxAgeMs) {
          unlinkSync(p)
          removed += 1
          bytes += st.size
        }
      } catch {}
    }
  } catch {}
  return { removed, bytes }
}

/** 从最旧开始删，直到降到目标字节数以下 */
function trimToSize(dir, targetBytes, state = { bytes: 0 }) {
  let list = []
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          const sub = dirSize(p)
          list.push({ p, t: st.mtimeMs, size: sub.total, isDir: true })
        } else {
          list.push({ p, t: st.mtimeMs, size: st.size, isDir: false })
        }
      } catch {}
    }
  } catch {
    return { removed: 0, bytes: 0 }
  }
  list.sort((a, b) => a.t - b.t)
  let removed = 0
  let bytes = 0
  for (const item of list) {
    if (state.bytes - bytes <= targetBytes) break
    try {
      if (item.isDir) {
        const sub = sweepEverything(item.p)
        removed += sub.removed
        bytes += sub.bytes
      } else {
        unlinkSync(item.p)
        removed += 1
        bytes += item.size
      }
    } catch {}
  }
  return { removed, bytes }
}

/** 递归删光一个目录的内容 */
function sweepEverything(dir) {
  let removed = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          const sub = sweepEverything(p)
          removed += sub.removed
          bytes += sub.bytes
          try {
            rmdirSync(p)
          } catch {}
        } else {
          unlinkSync(p)
          removed += 1
          bytes += st.size
        }
      } catch {}
    }
  } catch {}
  return { removed, bytes }
}

/**
 * 执行一次清理
 * @param {string} dataDir
 * @param {object} opts { quotaMB?, logger? }
 * @returns {{ removed:number, freedMB:number, beforeMB:number, afterMB:number }}
 */
export function sweepStorage(dataDir, opts = {}) {
  const logger = opts.logger || console
  const quotaMB = Number(opts.quotaMB) || DEFAULT_QUOTA_MB
  const now = Date.now()

  // ① 保护目录的孤儿文件（记忆已不存在的）
  let orphan = { removed: 0, bytes: 0 }
  try {
    orphan = sweepOrphans(dataDir, opts.store)
  } catch {}

  const before = dirSize(dataDir)
  const detail = {}
  let removed = 0
  let bytes = 0

  // ① 按保留时长
  for (const [name, maxAge] of Object.entries(RETENTION)) {
    const dir = join(dataDir, name)
    if (!existsSync(dir)) continue
    // voice-input 目录里还有 .mic-device.json 这类配置，只清 wav
    const onlyExt = name === 'voice-input' ? '.wav' : null
    const r = sweepByAge(dir, maxAge, now, onlyExt)
    if (r.removed > 0) {
      detail[name] = r.removed
      removed += r.removed
      bytes += r.bytes
    }
  }

  // ② 总量闸门
  let after = dirSize(dataDir)
  const quotaBytes = quotaMB * 1024 * 1024
  if (after.total > quotaBytes) {
    logger.warn?.(
      `[存储管家] 数据目录 ${(after.total / 1048576).toFixed(0)}MB 超过上限 ${quotaMB}MB，开始按最旧清理`,
    )
    const state = { bytes: after.total }
    for (const name of PRUNE_ORDER) {
      if (state.bytes <= quotaBytes) break
      const dir = join(dataDir, name)
      if (!existsSync(dir)) continue
      const r = trimToSize(dir, quotaBytes, state)
      if (r.removed > 0) {
        detail[name] = (detail[name] || 0) + r.removed
        removed += r.removed
        bytes += r.bytes
        state.bytes -= r.bytes
      }
    }
    after = dirSize(dataDir)
  }

  removed += orphan.removed
  bytes += orphan.bytes
  if (orphan.removed > 0) detail['keep(孤儿)'] = orphan.removed
  const beforeMB = Number((before.total / 1048576).toFixed(1))
  const afterMB = Number((after.total / 1048576).toFixed(1))
  const freedMB = Number((bytes / 1048576).toFixed(1))

  if (removed > 0) {
    logger.info?.(
      `[存储管家] 清理 ${removed} 个临时文件，释放 ${freedMB}MB（${beforeMB}MB → ${afterMB}MB）`,
      detail,
    )
  }
  return { removed, freedMB, beforeMB, afterMB, detail }
}

/** 启动定时清理（每小时一次），返回停止函数 */
export function startStorageGuard(dataDir, opts = {}) {
  const hour = 3600 * 1000
  const run = () => {
    try {
      sweepStorage(dataDir, opts)
    } catch (e) {
      ;(opts.logger || console).warn?.('[存储管家] 清理失败: ' + String((e && e.message) || e))
    }
  }
  // 启动后 30 秒先跑一次（避开启动高峰）
  const first = setTimeout(run, 30000)
  const timer = setInterval(run, hour)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

/**
 * 保护目录的孤儿清理：文件对应的记忆已经不在了就删掉
 * 约定：保护目录里的文件名是 `{记忆id}.png` / `{记忆id}.wav`
 * @param {string} dataDir
 * @param {object} store 记忆库（可选，没有就跳过）
 */
export function sweepOrphans(dataDir, store) {
  if (!store) return { removed: 0, bytes: 0 }
  let removed = 0
  let bytes = 0
  for (const sub of ['video', 'audio']) {
    const dir = join(dataDir, 'keep', sub)
    if (!existsSync(dir)) continue
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const id = name.replace(/\.(png|jpg|jpeg|wav)$/i, '')
      try {
        if (store.getMemory(id)) continue
      } catch {
        continue
      }
      const full = join(dir, name)
      try {
        const st = statSync(full)
        unlinkSync(full)
        removed += 1
        bytes += st.size
      } catch {}
    }
  }
  return { removed, bytes }
}