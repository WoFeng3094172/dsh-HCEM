/**
 * 开关 → 采集模块的运行时桥
 *
 * ⚠️ 采集只由插件侧 index.mjs 的 manager 负责（它带 onChange，能写记忆）。
 *    这里不再创建第二个 manager（没有 onChange，只会白跑截图和视觉描述）。
 *    本文件只负责：把 UI 开关同步进 settings.json，并写日志。
 */

import '../home.mjs'
import { log } from '../log.mjs'

const DATA_DIR = `${globalThis.__HCEM_HOME__}/data`

/**
 * 把 UI 开关同步进 settings.json
 * @param {Record<string, boolean>} mods
 */
export async function applyModsToModules(mods) {
  // 采集只由插件侧 index.mjs 的 manager 负责（它带 onChange → 能写记忆）。
  // 这里原来又建了一个 manager（没有 onChange），等于白跑截图和视觉描述，已移除。
  const next = syncSettingsFromMods(mods || {})
  log('INFO', 'capture', 'mods synced（采集由插件侧负责）', {
    listening: next ? next.listening : null,
    desktop: Boolean(mods && (mods['desk-watch'] || mods.desktop?.enabled)),
    audio: Boolean(mods && (mods['audio-watch'] || mods.audio?.enabled)),
  })
  return next
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