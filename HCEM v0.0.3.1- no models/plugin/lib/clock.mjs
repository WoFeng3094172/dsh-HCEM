// 本地时钟：与设备系统时钟对齐（跨平台：Windows / Linux / macOS）
// 用途：HCEM 运行时的时间感知（梦境/日志/记忆时间戳）统一用本地时钟
// 说明：不自行维护时钟（避免漂移），每次读系统时间；时区用 Intl 自动检测

/** 平台标识 */
export function platform() {
  if (typeof process === 'undefined') return 'unknown'
  return process.platform // 'win32' | 'linux' | 'darwin' | ...
}

/** 当前时间戳（毫秒）——直接读系统时钟（NTP 已对齐） */
export function nowMs() {
  return Date.now()
}

/** 当前时间（Date 对象） */
export function now() {
  return new Date()
}

/** 本地时区（IANA，如 Asia/Shanghai） */
export function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 本地时区偏移（分钟，东八区 = +480） */
export function tzOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset()
}

/** 本地时区偏移（字符串，如 +08:00） */
export function tzOffsetString(date = new Date()) {
  const m = tzOffsetMinutes(date)
  const sign = m >= 0 ? '+' : '-'
  const abs = Math.abs(m)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** 本地时间字符串（YYYY-MM-DD HH:mm:ss） */
export function formatLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 本地日期（YYYY-MM-DD） */
export function localDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时间 HH:mm */
export function localClock(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地问候语（按本地小时） */
export function greeting(date = new Date()) {
  const h = date.getHours()
  if (h < 5) return '夜深了'
  if (h < 9) return '早上好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  if (h < 22) return '晚上好'
  return '夜深了'
}

/** 时钟快照（供 AI 感知） */
export function clockSnapshot(date = new Date()) {
  return {
    iso: date.toISOString(),
    local: formatLocal(date),
    date: localDate(date),
    clock: localClock(date),
    tz: timeZone(),
    tzOffset: tzOffsetString(date),
    epochMs: date.getTime(),
    platform: platform(),
    greeting: greeting(date),
  }
}

/**
 * 与系统时钟对齐校验（检测系统时间是否异常漂移）
 * 返回：{ ok, driftMs, note }
 * 说明：本模块不维护独立时钟；此函数用于「发现系统时间被改」的提醒（如时区切换/手动改时间）
 */
export function checkSystemClock(prevMs = null) {
  const cur = Date.now()
  if (prevMs == null) return { ok: true, driftMs: 0, note: 'first' }
  const drift = cur - prevMs
  // 正常 < 5s；> 1h 视为异常（时区/手动调整/休眠唤醒）
  if (Math.abs(drift) > 3600 * 1000) {
    return { ok: false, driftMs: drift, note: 'clock-changed' }
  }
  return { ok: true, driftMs: drift, note: 'ok' }
}
