/**
 * 语音识别（ASR）：CrispASR 运行时 + Qwen3-ASR-0.6B 后端。
 *
 * 为什么换掉 SenseVoice：
 *   同一段 78 秒中文音频实测
 *     SenseVoice  26.4s（3x 实时），「六刀拳中」「可能是90」「う。The.」
 *     Qwen3-ASR    5.1s（15.3x 实时），「六刀全中」「可能是九十」，标点齐全
 *   而且 Qwen3-ASR 支持 --context 上下文偏置（热词），能治同音字：
 *     基线「先看人生」 → 加热词后「先看人声」
 *
 * 运行时：models 下的 CrispASR 目录里那个 crispasr.exe（多后端，qwen3/paraformer/sensevoice/whisper 都能跑）
 * 模型：  models/qwen3-asr-crisp/qwen3-asr-0.6b-q8_0.gguf（融合版，mel 滤波器在主模型里）
 *
 * 注意：必须是「融合版」gguf。FunAudioLLM 那种主模型 + mmproj 分离的转换，
 * CrispASR 读不了（会报 missing audio.mel_filters），要 cstr/qwen3-asr-0.6b-GGUF 那一版。
 */

import { execFile } from 'node:child_process'
import '../home.mjs'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 低于这个峰值就不送识别：热词会在近乎静音时被念出来 */
const SILENT_PEAK = 0.01

const MODELS = `${globalThis.__HCEM_HOME__}/models`
const CRISPASR_DIR = join(MODELS, 'CrispASR-v0.8.53-win-x64-cuda')
const CRISPASR_EXE = join(CRISPASR_DIR, 'crispasr.exe')
const ASR_MODEL = join(MODELS, 'qwen3-asr-crisp', 'qwen3-asr-0.6b-q8_0.gguf')

export const ASR_AVAILABLE = existsSync(CRISPASR_EXE) && existsSync(ASR_MODEL)

/**
 * 基础热词表。
 *
 * 热词是「识别时」的上下文偏置，不是事后猜——所以它能治同音字，
 * 而本地小模型事后校对不行（实测：只在 JSON 约束下全返回 changed:false）。
 * 这里放 HCEM 自己的术语；人名等动态词由 index.mjs 通过 setAsrTerms() 注入。
 */
const BASE_TERMS = [
  '人声',
  '静音',
  '时间戳',
  '字幕',
  '切点',
  '剪辑',
  '口播',
  '卡点',
  '调性',
  '和弦',
  '段落结构',
  'Better Ears',
  'HCEM',
  'DSH',
]

let extraTerms = []

/** 注入动态热词（人名、工作术语等）。重复调用会整体替换。 */
export function setAsrTerms(terms) {
  const list = Array.isArray(terms) ? terms : []
  extraTerms = list.map((t) => String(t || '').trim()).filter((t) => t && t.length <= 20)
}

/** 组装 --context 参数；去重、限量（太长会挤占解码上下文） */
export function buildAsrContext() {
  const seen = new Set()
  const out = []
  for (const t of [...BASE_TERMS, ...extraTerms]) {
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= 40) break
  }
  return out.join(',')
}

/** 读 wav 的峰值（0~1）。用于「太轻就别送识别」——见下面 leak 的说明。 */
export function wavPeak(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
    // 找 data chunk（fmt 后面，不一定紧跟）
    let pos = 12
    let dataStart = -1
    let dataLen = 0
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4)
      const size = buf.readUInt32LE(pos + 4)
      if (id === 'data') {
        dataStart = pos + 8
        dataLen = Math.min(size, buf.length - dataStart)
        break
      }
      pos += 8 + size + (size % 2)
    }
    if (dataStart < 0 || dataLen <= 0) return null
    const n = Math.floor(dataLen / 2)
    let peak = 0
    // 大文件抽样即可，不必全扫
    const step = n > 200000 ? Math.floor(n / 200000) : 1
    for (let i = 0; i < n; i += step) {
      const v = Math.abs(buf.readInt16LE(dataStart + i * 2)) / 32768
      if (v > peak) peak = v
    }
    return peak
  } catch {
    return null
  }
}

/** 判定「这句其实是烧录/幻听」：输出跟热词表高度重合，或整段就是逗号列表 */
function looksLikeHotwordDump(text, context) {
  const t = String(text || '').trim()
  if (!t) return false
  const terms = String(context || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return false
  const parts = t
    .split(/[,，、\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 3) return false
  const hit = parts.filter((p) => terms.includes(p)).length
  // 一半以上的片段都命中热词表 → 这不是说出来的话，是把提示词念回来了
  return hit / parts.length >= 0.5
}

/**
 * 识别一段 wav（单声道 16k 最好；其它采样率 CrispASR 也能吃，走它内部的 ffmpeg）。
 *
 * @param {string} wavPath
 * @param {object} [opts]
 * @param {string} [opts.context] 覆盖默认热词（不传则用 buildAsrContext()）
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function transcribe(wavPath, { context = null, timeoutMs = 180000, withTimestamps = true } = {}) {
  if (!ASR_AVAILABLE) {
    return { ok: false, error: 'ASR 运行时或模型缺失（crispasr.exe / qwen3-asr-0.6b-q8_0.gguf）' }
  }
  // 太轻的音频直接判无人声。热词会让模型在近乎静音时把提示词念出来
  // （实测峰值 0.0062 的录音，输出就是整张热词表），必须在源头拦掉。
  const peak = wavPeak(wavPath)
  if (peak !== null && peak < SILENT_PEAK) {
    return { ok: true, text: '', skipped: 'silent' }
  }
  const args = [
    '--backend',
    'qwen3',
    '-m',
    ASR_MODEL,
    '-f',
    wavPath,
    '-l',
    'zh',
  ]
  const srtBase = wavPath.replace(/\.wav$/i, '') + '-asr'
  const srtPath = srtBase + '.srt'
  if (withTimestamps) args.push('-osrt', '-of', srtBase)
  else args.push('-nt')
  const ctx = context === null ? buildAsrContext() : String(context || '')
  if (ctx) args.push('--context', ctx)

  let text = ''
  try {
    const { stdout } = await run(CRISPASR_EXE, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      cwd: CRISPASR_DIR,
    })
    // CrispASR 的结果在 stdout，日志在 stderr，这里只取 stdout 并压成一行
    text = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .trim()
    // SRT 里有句级 start/end；qwen3 后端目前通常只给一整句，但时间窗是对的
    if (withTimestamps && existsSync(srtPath)) {
      const srt = readFileSync(srtPath, 'utf8')
      const segs = []
      const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\s*$)/g
      let m
      while ((m = re.exec(srt))) {
        const from = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
        const to = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
        const t = String(m[9] || '').replace(/^\d+\s*$/m, '').trim()
        if (t) segs.push({ start: +from.toFixed(3), end: +to.toFixed(3), text: t })
      }
      try { unlinkSync(srtPath) } catch {}
      if (segs.length > 0) {
        return { ok: true, text: segs.map((x) => x.text).join(' '), segments: segs }
      }
    }
  } catch (error) {
    const msg = String((error && error.message) || error)
    if (/no text produced/i.test(msg)) return { ok: true, text: '' }
    return { ok: false, error: msg.slice(0, 200) }
  }
  // 第二道闸：输出把热词表念回来了，当作没听见
  if (looksLikeHotwordDump(text, ctx)) {
    return { ok: true, text: '', skipped: 'hotword-leak' }
  }
  return { ok: true, text }
}
