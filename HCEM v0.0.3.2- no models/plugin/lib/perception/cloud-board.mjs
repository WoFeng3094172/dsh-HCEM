/**
 * 云端故事板兜底（低预算、强限制）
 *
 * 原则（用户定）：
 *   - 桌面监视 / 监听默认 100% 本地，不上云
 *   - 只有「本地确实分析不了」时，才把**合成故事板**（不是原始截图）送云端
 *   - 次数必须压到极少，否则云端费用会爆
 *
 * 硬性限制：
 *   - 每天最多 DAILY_LIMIT 次（默认 5）
 *   - 每小时最多 HOURLY_LIMIT 次（默认 1）
 *   - 必须连续 MIN_FAILURES 次本地失败才允许升级（默认 2）
 *   - 故事板单边 ≤ MAX_SIDE（默认 1024），一次只发 1 张
 *   - 未配置云端端点 → 永不调用
 *
 * 每次升级都写日志（含估算 token、原因、预算余量），便于对账。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.mjs'

export const DAILY_LIMIT = 5
export const HOURLY_LIMIT = 1
export const MIN_FAILURES = 2
export const MAX_SIDE = 1024

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {object} [opts.cloud] { endpoint, apiKey, model } —— 不配则永不上云
 * @param {object} [opts.logger]
 */
export function createCloudBoard({ dataDir, cloud = null, logger = console } = {}) {
  const dir = join(dataDir, 'cloud-board')
  const ledgerPath = join(dir, 'ledger.json')

  let failures = 0 // 连续本地失败次数
  let lastEscalateAt = 0
  let ledger = { day: '', countToday: 0, hour: '', countThisHour: 0, history: [] }

  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(ledgerPath)) ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) || ledger
  } catch {}

  const todayKey = () => new Date().toISOString().slice(0, 10)
  const hourKey = () => new Date().toISOString().slice(0, 13)

  function roll() {
    const d = todayKey()
    const h = hourKey()
    if (ledger.day !== d) {
      ledger.day = d
      ledger.countToday = 0
    }
    if (ledger.hour !== h) {
      ledger.hour = h
      ledger.countThisHour = 0
    }
  }

  function save() {
    try {
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8')
    } catch {}
  }

  /** 本地分析成功：清零失败计数 */
  function noteLocalSuccess() {
    failures = 0
  }

  /** 本地分析失败：累计;返回是否达到升级阈值 */
  function noteLocalFailure(reason) {
    failures += 1
    log('WARN', 'cloud-board', `local failure #${failures}: ${String(reason || '').slice(0, 120)}`)
    return failures >= MIN_FAILURES
  }

  /** 当前预算是否允许升级 */
  function canEscalate() {
    roll()
    if (!cloud || !cloud.endpoint) {
      return { allow: false, reason: '未配置云端端点（默认不上云）' }
    }
    if (failures < MIN_FAILURES) {
      return { allow: false, reason: `本地连续失败 ${failures}/${MIN_FAILURES}` }
    }
    if (ledger.countToday >= DAILY_LIMIT) {
      return { allow: false, reason: `今日额度已用尽（${ledger.countToday}/${DAILY_LIMIT}）` }
    }
    if (ledger.countThisHour >= HOURLY_LIMIT) {
      return { allow: false, reason: `本小时额度已用尽（${ledger.countThisHour}/${HOURLY_LIMIT}）` }
    }
    return {
      allow: true,
      reason: 'ok',
      leftToday: DAILY_LIMIT - ledger.countToday,
      leftThisHour: HOURLY_LIMIT - ledger.countThisHour,
    }
  }

  /**
   * 生成故事板并发云端（只有 canEscalate 允许时才调用）
   * @param {object} p { frames: string[], prompt?, buildSheet, describe? }
   * @returns {Promise<{ok:boolean, text?:string, boardPath?:string, tokens?:number, error?:string, blocked?:string}>}
   */
  async function escalate(p = {}) {
    const gate = canEscalate()
    if (!gate.allow) {
      log('INFO', 'cloud-board', 'escalate blocked: ' + gate.reason)
      return { ok: false, blocked: gate.reason }
    }

    const frames = Array.isArray(p.frames) ? p.frames.filter((f) => typeof f === 'string' && existsSync(f)) : []
    if (frames.length === 0) return { ok: false, error: 'no frames' }
    if (typeof p.buildSheet !== 'function') return { ok: false, error: 'buildSheet missing' }

    let boardPath = ''
    try {
      const board = await p.buildSheet(frames, { maxSide: MAX_SIDE })
      boardPath = board?.path || board?.outPath || ''
    } catch (e) {
      return { ok: false, error: 'buildSheet failed: ' + String((e && e.message) || e) }
    }
    if (!boardPath || !existsSync(boardPath)) return { ok: false, error: 'board not created' }

    roll()
    ledger.countToday += 1
    ledger.countThisHour += 1
    lastEscalateAt = Date.now()

    const entry = {
      at: new Date().toISOString(),
      boardPath,
      frames: frames.length,
      prompt: String(p.prompt || '').slice(0, 200),
      budgetLeftToday: DAILY_LIMIT - ledger.countToday,
    }

    try {
      let text = ''
      if (typeof p.describe === 'function') {
        text = String((await p.describe({ imagePath: boardPath, prompt: p.prompt })) || '')
      }
      // 估算 token（图片按 256 + 文本按字数 / 2）
      const approxTokens = 256 + Math.ceil(text.length / 2)
      entry.tokens = approxTokens
      ledger.history.push(entry)
      if (ledger.history.length > 200) ledger.history = ledger.history.slice(-200)
      save()
      log('INFO', 'cloud-board', `escalated ok tokens≈${approxTokens} leftToday=${ledger.countToday}/${DAILY_LIMIT}`)
      failures = 0
      return { ok: true, text, boardPath, tokens: approxTokens }
    } catch (e) {
      entry.error = String((e && e.message) || e)
      ledger.history.push(entry)
      save()
      log('ERROR', 'cloud-board', 'escalate failed: ' + entry.error)
      return { ok: false, error: entry.error, boardPath }
    }
  }

  /** 清理 7 天前的故事板图片 */
  function cleanup() {
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000
      for (const f of readdirSync(dir)) {
        if (!/\.(png|jpg|jpeg)$/i.test(f)) continue
        const full = join(dir, f)
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      }
    } catch {}
  }

  return {
    noteLocalSuccess,
    noteLocalFailure,
    canEscalate,
    escalate,
    cleanup,
    status() {
      roll()
      return {
        failures,
        countToday: ledger.countToday,
        countThisHour: ledger.countThisHour,
        dailyLimit: DAILY_LIMIT,
        hourlyLimit: HOURLY_LIMIT,
        lastEscalateAt: lastEscalateAt || null,
        configured: Boolean(cloud && cloud.endpoint),
      }
    },
  }
}
