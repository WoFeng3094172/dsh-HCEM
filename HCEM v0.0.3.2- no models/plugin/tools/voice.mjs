/**
 * 音色管理：查看 / 切换 TTS 音色
 *
 * 用法：
 *   node plugin/tools/voice.mjs                       # 看当前音色
 *   node plugin/tools/voice.mjs preset                # 回到「按情绪选参考音」
 *   node plugin/tools/voice.mjs clone <wav> [refText] # 用某个 wav 做克隆音色
 *
 * 说明：CosyVoice3 是 zero-shot 克隆——给一段参考音频 + 它的台词，
 * 就能用那个音色说任何语言。参考音频最好 5~15 秒、干净、单人。
 * 没有 refText 时会自动识别（较慢，但省事）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import '../lib/home.mjs'
import { join } from 'node:path'

const DATA = `${globalThis.__HCEM_HOME__}/data`
const CFG = join(DATA, 'ui', 'voice.json')
const VOICES = join(DATA, 'voices')

const mode = (process.argv[2] || '').toLowerCase()

function readCfg() {
  try {
    return JSON.parse(readFileSync(CFG, 'utf8'))
  } catch {
    return { mode: 'preset' }
  }
}
function writeCfg(o) {
  mkdirSync(join(DATA, 'ui'), { recursive: true })
  writeFileSync(CFG, JSON.stringify(o, null, 2), 'utf8')
}

const cur = readCfg()
console.log('当前音色:', JSON.stringify(cur, null, 2))

if (mode === 'preset') {
  writeCfg({ mode: 'preset', savedAt: Date.now() })
  console.log('已切回：按情绪选参考音（中文）/ fleurs-en（英文）')
} else if (mode === 'clone') {
  const src = process.argv[3]
  if (!src || !existsSync(src)) {
    console.error('需要给一个存在的 wav 路径')
    process.exit(1)
  }
  mkdirSync(VOICES, { recursive: true })
  const name = String(process.argv[4] ? 'voice' : 'clone') + '-' + Date.now() + '.wav'
  const dest = join(VOICES, name)
  copyFileSync(src, dest)
  const refText = process.argv[4] || ''
  writeCfg({ mode: 'clone', wav: dest, refText, savedAt: Date.now() })
  console.log('已登记克隆音色:', dest)
  if (!refText) console.log('注意：没给参考文本，CLI 会自动识别（更慢）。想更稳就补第四个参数。')
  console.log('改完重启 DSH 生效。')
} else if (mode && mode !== 'status') {
  console.log('用法：node plugin/tools/voice.mjs [preset | clone <wav> [refText]]')
}
