/**
 * 音色导入：把一段音频丢进目录，就自动变成可选音色。
 *
 * 用法（给用户）：
 *   1. 把 wav/mp3/m4a 丢进  <HCEM_HOME>\data\voices\incoming\
 *   2. 重启 DSH（或等下自动扫描）
 *   3. 想让它当默认音色：设置 voice.json 的 mode=clone，name=<文件名>
 *
 * 原理：CosyVoice3 是 zero-shot 克隆，只需要「一段干净音频 + 它说的内容」。
 * 内容文本优先用同名 .txt；没有就用 ASR 自动转写（较慢，但省事）。
 */
import { execFile } from 'node:child_process'
import '../home.mjs'
import { promisify } from 'node:util'
import { readdirSync, existsSync, mkdirSync, renameSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const run = promisify(execFile)
const DATA = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
const VOICES = join(DATA, 'voices')
const INCOMING = join(VOICES, 'incoming')
const DONE = join(INCOMING, 'done')
const MODELS = process.env.HCEM_MODELS_DIR || globalThis.__HCEM_MODELS__
const FFMPEG = join(MODELS, '..', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe')

export const AUDIO_EXT = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus']

function ensureDirs() {
  mkdirSync(VOICES, { recursive: true })
  mkdirSync(INCOMING, { recursive: true })
  mkdirSync(DONE, { recursive: true })
}

/** 转成 24k 单声道 wav（CosyVoice 参考音要求） */
async function toWav(src, dst) {
  await run(
    FFMPEG,
    ['-y', '-loglevel', 'error', '-i', src, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', dst],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  )
}

/** 用 ASR 自动识别参考文本 */
async function transcribe(wavPath) {
  const { transcribe: asr } = await import('../audio/asr.mjs')
  const r = await asr(wavPath, { context: '' })
  const text = String(r?.text || '').trim()
  return text.length >= 2 ? text : ''
}

/**
 * 扫描 incoming 目录，把音频注册成音色。
 * @param {{log?: (m:string)=>void}} opts
 * @returns {Promise<{imported: {name:string, refText:string}[], skipped: string[], error?: string}>}
 */
export async function importIncomingVoices({ log = () => {} } = {}) {
  ensureDirs()
  const imported = []
  const skipped = []
  let files = []
  try {
    files = readdirSync(INCOMING).filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()))
  } catch {
    return { imported, skipped }
  }
  for (const f of files) {
    const src = join(INCOMING, f)
    const name = basename(f, extname(f)).replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 32) || 'voice'
    const dst = join(VOICES, name + '.wav')
    try {
      log(`导入 ${f} → ${name}`)
      await toWav(src, dst)
      // 参考文本：同名 .txt 优先，否则 ASR
      let refText = ''
      const txtPath = join(INCOMING, name + '.txt')
      const altTxt = join(INCOMING, basename(f, extname(f)) + '.txt')
      if (existsSync(txtPath)) refText = readFileSync(txtPath, 'utf8').trim()
      else if (existsSync(altTxt)) refText = readFileSync(altTxt, 'utf8').trim()
      if (!refText) {
        log(`  没有 .txt，自动识别中…`)
        refText = await transcribe(dst)
      }
      if (!refText) {
        skipped.push(f + '（识别不出文本）')
        continue
      }
      writeFileSync(join(VOICES, name + '.txt'), refText, 'utf8')
      // 原文件归档，避免重复导入
      renameSync(src, join(DONE, f))
      // .txt 也一起归档，免得下次重复导入
      try {
        const t1 = join(INCOMING, name + '.txt')
        const t2 = join(INCOMING, basename(f, extname(f)) + '.txt')
        for (const tp of [t1, t2]) if (existsSync(tp)) renameSync(tp, join(DONE, basename(tp)))
      } catch {}
      imported.push({ name, refText })
      log(`  完成：${name}（${refText.slice(0, 20)}…）`)
    } catch (e) {
      skipped.push(f + '（' + String((e && e.message) || e).slice(0, 60) + '）')
    }
  }
  return { imported, skipped }
}

/** 命令行入口：node plugin/tools/import-voice.mjs */
if (process.argv[1] && process.argv[1].endsWith('import-voice.mjs')) {
  const r = await importIncomingVoices({ log: (m) => console.log(m) })
  console.log(`\n导入 ${r.imported.length} 个，跳过 ${r.skipped.length} 个`)
  for (const a of r.imported) console.log('  ✅', a.name)
  for (const s of r.skipped) console.log('  ⚠️ ', s)
  if (r.imported.length) {
    console.log('\n想让它当默认音色：把 data/ui-state/voice.json 改成')
    console.log(JSON.stringify({ mode: 'clone', wav: `${globalThis.__HCEM_HOME__}/data/voices/${r.imported[0].name}.wav` }, null, 2))
  }
}
