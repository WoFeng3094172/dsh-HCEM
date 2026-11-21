/**
 * 开关 → 采集模块 的运行时桥
 *
 * UI 的六个开关最终落到这里：
 *   desk-watch   → capture/manager.mjs（多屏截图 + 帧差 + 段内 top-K + 小模型描述）
 *   audio-watch  → manager 内部 AudioCapture（系统声音）
 *   video-watch  → 由 manager 的 router 判定「前台是视频」时走视频路径
 *   voice-in     → 长按悬浮球时开麦（ASR 侧，后续接）
 *   voice-out    → TTS 播放（tts/ 侧，后续接）
 *   local-route  → 本地模型分流（后续接）
 *
 * 目前先接通 desktop / audio 两条真实链路，其余保持状态位。
 * 所有动作写统一日志，便于按开关顺序核对。
 */

import { createCaptureManager } from '../capture/manager.mjs'
import '../home.mjs'
import { log } from '../log.mjs'

const DATA_DIR = `${globalThis.__HCEM_HOME__}/data`
const MODELS_DIR = `${globalThis.__HCEM_HOME__}/models`

let manager = null

const logger = {
  info: (m) => log('INFO', 'capture', String(m)),
  warn: (m) => log('WARN', 'capture', String(m)),
  error: (m) => log('ERROR', 'capture', String(m)),
}

/** 当前采集状态（供 status 查询/日志） */
export function captureStatus() {
  return manager ? manager.status() : { running: false }
}

/**
 * 根据开关状态启停采集模块
 * @param {Record<string, boolean>} mods
 */
export async function applyModsToModules(mods) {
  syncSettingsFromMods(mods || {})
  const wantDesktop = Boolean(mods && mods['desk-watch'])
  const wantAudio = Boolean(mods && mods['audio-watch'])

  // 桌面监视（包含音频采集，manager 内部一起管）
  if ((wantDesktop || wantAudio) && !manager) {
    manager = createCaptureManager({
      dataDir: DATA_DIR,
      modelsDir: MODELS_DIR,
      intervalMs: 1000,
      enableSmallVlm: true,
      enableFunnel: true,
      logger,
    })
    try {
      const r = await manager.start()
      log('INFO', 'capture', 'started desktop watch', {
        screens: r && r.screens,
        funnel: r && r.funnel,
        audio: wantAudio,
      })
    } catch (e) {
      log('ERROR', 'capture', 'start failed: ' + (e && e.message))
      manager = null
    }
  } else if (!wantDesktop && !wantAudio && manager) {
    try {
      manager.stop()
    } catch (e) {
      log('ERROR', 'capture', 'stop failed: ' + (e && e.message))
    }
    manager = null
    log('INFO', 'capture', 'stopped desktop watch')
  } else if (manager) {
    log('INFO', 'capture', 'watch state', {
      desktop: wantDesktop,
      audio: wantAudio,
      running: true,
    })
  }
}

/**
 * 把 UI 的多模态开关同步进插件 settings.json
 *   audio-watch / desk-watch 任一开 → listening = true（常驻感知开启）
 * 这样插件侧（index.mjs）的 `settings.listening` 才和 UI 一致。
 */
import { loadSettings, saveSettings } from '../settings.mjs'
import { join } from 'node:path'

const SETTINGS_PATH = join(DATA_DIR, 'settings.json')

/** 取开关状态：兼容「扁平键（desk-watch）」和「嵌套对象（desktop.enabled）」两种写法 */
function flagOf(mods, flatKey, nestKey) {
  if (!mods) return false
  // 扁平：mods['desk-watch'] = true
  if (typeof mods[flatKey] === 'boolean') return mods[flatKey]
  // 嵌套：mods.desktop = { enabled: true }
  if (nestKey && mods[nestKey] && typeof mods[nestKey] === 'object') {
    return mods[nestKey].enabled === true
  }
  return false
}

export function syncSettingsFromMods(mods) {
  try {
    const cur = loadSettings(SETTINGS_PATH)
    const deskOn = flagOf(mods, 'desk-watch', 'desktop')
    const audioOn = flagOf(mods, 'audio-watch', 'audio')
    const voiceOut = flagOf(mods, 'voice-out', 'voiceOut')
    const next = {
      ...cur,
      listening: Boolean(deskOn || audioOn),
      ttsEnabled: Boolean(voiceOut),
    }
    if (next.listening !== cur.listening || next.ttsEnabled !== cur.ttsEnabled) {
      saveSettings(SETTINGS_PATH, next)
      log('INFO', 'settings', 'listening=' + next.listening + ' ttsEnabled=' + next.ttsEnabled, {
        reason: 'mods: desk=' + deskOn + ' audio=' + audioOn + ' voiceOut=' + voiceOut,
      })
    }
    return next
  } catch (e) {
    log('ERROR', 'settings', 'sync failed: ' + (e && e.message))
    return null
  }
}