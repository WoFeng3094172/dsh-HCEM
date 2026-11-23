/**
 * TTS 常驻服务（crispasr --server）。
 *
 * 为什么需要它：CLI 每合成一句都要重新加载 0.5B 模型（冷启动 ~10s），
 * 所以「整段一次合成」要 12s 才出声。server 模式模型常驻：
 *   · 冷启动（首次用某个音色）~9~11s
 *   · 热态            ~0.7~0.95s/句
 * 于是可以「分句合成、边合成边播」，首句 1 秒内就能开口。
 *
 * 生命周期（跟其它模型一致的规则）：
 *   · 不随 HCEM.exe 启动，第一次要说话时才拉
 *   · 空闲 10 分钟自动退出，不白占显存
 *   · exe 关闭 / 用户在菜单关语音输出 → 立即停
 */
import { spawn, execFile } from 'node:child_process'
import '../home.mjs'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MODELS = process.env.HCEM_MODELS_DIR || globalThis.__HCEM_MODELS__
const CRISP = join(MODELS, 'CrispASR-v0.8.53-win-x64-cuda', 'crispasr.exe')
const LLM = join(MODELS, 'Fun-CosyVoice3-0.5B-2512', 'cosyvoice3-llm-rl-q4_k.gguf')
const DATA = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
const VOICE_DIR = join(DATA, 'voices')

export const TTS_PORT = 8099
const BASE = `http://127.0.0.1:${TTS_PORT}`
const IDLE_MS = 10 * 60 * 1000
const CONSENT = 'I have the consent of the speaker whose voice this clones, or it is my own voice.'

let child = null
let starting = null
let idleTimer = null
let lastUsedAt = 0
let logger = console

function log(msg) {
  try {
    logger.info?.(`[tts-server] ${msg}`)
  } catch {}
}

async function portUp() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) })
    return r.ok
  } catch {
    return false
  }
}

/** 确保服务在跑；并发调用合并成一次启动 */
export async function ensureServer({ log: lg } = {}) {
  if (lg) logger = lg
  touch()
  if (await portUp()) return true
  if (starting) return starting
  starting = (async () => {
    if (!existsSync(CRISP) || !existsSync(LLM)) {
      log('运行时缺失，跳过')
      return false
    }
    mkdirSync(VOICE_DIR, { recursive: true })
    // 先扫「丢进来的音频」目录，把它们注册成音色
    try {
      const { importIncomingVoices } = await import('./import-voice.mjs')
      const r = await importIncomingVoices({ log: (m) => log(m) })
      if (r.imported.length) log('新导入音色: ' + r.imported.map((x) => x.name).join(', '))
    } catch (e) {
      log('导入音色失败: ' + String((e && e.message) || e))
    }
    log('启动中…')
    child = spawn(
      CRISP,
      [
        '--backend', 'cosyvoice3-tts', '-m', LLM,
        '--server', '--host', '127.0.0.1', '--port', String(TTS_PORT),
        '--speaker-identity', 'synthetic', '--no-spoken-disclaimer', '--accept-marking-responsibility',
        '--voice-dir', VOICE_DIR,
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    child.on('exit', (code) => {
      log('退出 code=' + code)
      child = null
    })
    // 最多等 40 秒（首次要加载 LLM + flow + hift）
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      if (await portUp()) {
        log('已就绪')
        // 预热常用音色，避免第一句话吃 10 秒冷启动
        warmVoices().catch(() => {})
        return true
      }
    }
    log('启动超时')
    return false
  })().finally(() => {
    starting = null
  })
  return starting
}

/** 后台预热：常驻模式实际用的是「内置音色」（请求不带 voice）。
 *  冷启动一次 ~10s，焐热后每句 ~0.7s。 */
async function warmVoices() {
  try {
    await requestSpeech({ input: '预热。', skipIdle: true })
    log('已预热内置音色')
  } catch {}
}

function touch() {
  lastUsedAt = Date.now()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (Date.now() - lastUsedAt >= IDLE_MS - 1000) stopServer('空闲超时')
  }, IDLE_MS)
  if (idleTimer.unref) idleTimer.unref()
}

/**
 * 合成一句，返回 wav Buffer。
 * @param {{input:string, voice?:string, skipIdle?:boolean}} o
 */
export async function requestSpeech({ input, voice = null, skipIdle = false } = {}) {
  if (!skipIdle) touch()
  const body = { input: String(input || '').trim() }
  if (voice) body.voice = voice
  // 只有指定了 voice（voice-dir 里的克隆音色）才带同意声明：
  // 带了 consent 服务端就按「克隆」处理，会强制加英文 AI 声明；
  // 不带 voice + 不带 consent → 内置音色，无声明，热态 ~0.6s/句。
  if (body.voice) body.consent_attestation = CONSENT
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`speech ${res.status}: ${txt.slice(0, 160)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 100) throw new Error('empty audio')
  return buf
}

/** 列出可用的 voice-dir 音色名（不含扩展名） */
export function listVoices() {
  try {
    return readdirSync(VOICE_DIR)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => f.replace(/\.wav$/i, ''))
  } catch {
    return []
  }
}

export function stopServer(reason = '') {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!child) return
  try {
    child.kill('SIGKILL')
    log('已停止' + (reason ? `（${reason}）` : ''))
  } catch {}
  child = null
}

export function isRunning() {
  return Boolean(child)
}
