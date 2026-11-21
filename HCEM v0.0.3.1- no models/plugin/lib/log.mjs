/**
 * HCEM 统一日志（Node 侧）
 *
 * 位置：<HCEM_HOME>\logs\hcem-YYYY-MM-DD.log
 * 格式：2026-11-18 04:20:31.123 [LEVEL] [module] message
 * 保留：7 天，超过的按 mtime 删除（每次启动 + 每小时检查）
 *
 * 说明：日志只写本地文件，不发网络，不依赖 DSH。
 */

import fs from 'node:fs'
import './home.mjs'
import path from 'node:path'

export const LOG_DIR = `${globalThis.__HCEM_HOME__}/logs`
export const KEEP_DAYS = 7

const pad = (n, w = 2) => String(n).padStart(w, '0')

function stamp(d = new Date()) {
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3)
  )
}

function todayFile() {
  const d = new Date()
  const name = 'hcem-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.log'
  return path.join(LOG_DIR, name)
}

/** 删除超过 KEEP_DAYS 的日志文件，并给 events.log 做体积上限滚动 */
export function cleanupLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return 0
    const now = Date.now()
    const limit = KEEP_DAYS * 24 * 3600 * 1000
    let removed = 0
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^hcem-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue
      const full = path.join(LOG_DIR, f)
      try {
        if (now - fs.statSync(full).mtimeMs > limit) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {}
    }
    if (removed) console.log('[log] 清理过期日志', removed, '个')
    rotateEventsLog()
    return removed
  } catch {
    return 0
  }
}

/**
 * events.log（logDebug 写的）体积上限。
 *
 * cleanupLogs 原来只匹配 hcem-YYYY-MM-DD.log，events.log 不在里面，
 * 于是它无限增长（实测已经 1.2 MB 且只增不减）。
 * 这里超过 EVENTS_LOG_MAX_BYTES 就滚动成 events.log.1（只留一份，旧的直接被替换）。
 */
export const EVENTS_LOG_MAX_BYTES = 5 * 1024 * 1024

function rotateEventsLog() {
  const file = path.join(LOG_DIR, 'events.log')
  try {
    if (!fs.existsSync(file)) return false
    if (fs.statSync(file).size <= EVENTS_LOG_MAX_BYTES) return false
    fs.renameSync(file, file + '.1')
    return true
  } catch {
    return false
  }
}

/** 写一条日志 */
export function log(level, module, message, extra) {
  const line =
    stamp() + ' [' + level + '] [' + module + '] ' +
    (typeof message === 'string' ? message : JSON.stringify(message)) +
    (extra !== undefined ? ' ' + JSON.stringify(extra) : '') + '\n'
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(todayFile(), line, 'utf8')
  } catch {}
  // 控制台也留一份（调试用，生产可关）
  if (level === 'ERROR') console.error(line.trim())
  else console.log(line.trim())
}

/**
 * 开关链路日志：把一次 set_mods 完整记录下来，
 * 便于按「组合测试顺序」逐条核对。
 */
export function logMods(mods, derived) {
  const ids = Object.keys(mods || {})
  const on = ids.filter((k) => mods[k])
  const off = ids.filter((k) => !mods[k])
  log('MOD', 'switch', 'on=[' + on.join(',') + '] off=[' + off.join(',') + ']', {
    count: on.length,
    video: derived?.video?.autoWatch ? 'auto' : 'ondemand',
    audio: derived?.audio?.enabled ? derived.audio.source : 'off',
    voiceIn: derived?.voiceIn?.enabled ? derived.voiceIn.mode : 'off',
  })
}

// 启动时清一次，并每小时清一次
cleanupLogs()
setInterval(cleanupLogs, 3600 * 1000).unref?.()
