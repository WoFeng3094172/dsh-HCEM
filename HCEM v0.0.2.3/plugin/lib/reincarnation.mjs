// 前世记忆区（reincarnation）：把旧 AI 的记忆包迁移进 HCEM
// 流程：
//   1. 用户把旧 AI 打包的 persona / journal / 人际网 / 一般记忆（.md/.txt）放进 data/reincarnation/
//   2. 插件启动时扫描 → 切段 → 预打戳（β 用本地情绪分析；α 打基准值）→ 存入 reincarnation 区
//   3. 会话检索时「唤回」→ 命中后更新戳（α/β/摘要）→ 转入生活/知识区 → 逐步清空
import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeText } from './emotion.mjs'
import { computeGamma } from './memory.mjs'
import { parsePeople, writePerson } from './people.mjs'
import { appendPersona, appendUserCard } from './persona.mjs'

export const REINCARNATION_ZONE = 'reincarnation'
const ALPHA_BASE = { H: 360, S: 15 } // α 基准值（旧 AI 当时的情绪已不可考）

export function reincarnationDir(dataDir) {
  const dir = join(dataDir, 'reincarnation')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function listReincarnationFiles(dataDir) {
  try {
    return readdirSync(reincarnationDir(dataDir)).filter((f) => /\.(md|txt)$/i.test(f))
  } catch {
    return []
  }
}

// 切段：按空行/标题切，10~2000 字
export function splitChunks(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.replace(/^#+\s*/gm, '').trim())
    .filter((s) => s.length >= 10 && s.length <= 2000)
}

// 预打戳：β = 内容情绪分析；α = 基准；γ = 三重合
// 因果抽取（本地 Qwen3）：从记忆文本提取「因为什么 / 导致了什么」
// 返回 { cause, effect }（可能为空字符串）
export async function extractCausal(text, opts = {}) {
  const port = opts.port || Number(process.env.HCEM_LOCAL_LLM_PORT || 8093)
  const prompt = '从这句话里提取因果关系，只输出 JSON：{"cause":"原因","effect":"结果"}。'
    + '没有明确因果就返回 {"cause":"","effect":""}。句子：' + String(text).slice(0, 500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    if (!res.ok) return { cause: '', effect: '' }
    const data = await res.json()
    const raw = String(data?.choices?.[0]?.message?.content ?? '')
    const m = raw.match(/{[sS]*}/)
    if (!m) return { cause: '', effect: '' }
    const obj = JSON.parse(m[0])
    return { cause: String(obj.cause ?? '').slice(0, 100), effect: String(obj.effect ?? '').slice(0, 100) }
  } catch {
    return { cause: '', effect: '' }
  }
}

export function stampChunk(text, alpha = ALPHA_BASE) {
  const a = analyzeText(text)
  const betaH = a ? a.targetHue : 360
  const betaS = a ? Math.round(Math.min(100, a.intensity * 100)) : 15
  const gamma = computeGamma(alpha, { H: betaH, S: betaS }, 1, 0)
  return { alpha, beta: { H: betaH, S: betaS }, gamma }
}

/**
 * 导入 reincarnation 文件（幂等：处理过的文件移到 done/）
 * @returns {{ ok: boolean, files: number, chunks: number }}
 */
export async function ingestReincarnation({ dataDir, store, logger = console, analyzer = null }) {
  const dir = reincarnationDir(dataDir)
  const files = listReincarnationFiles(dataDir)
  if (files.length === 0) return { ok: true, files: 0, chunks: 0 }
  const doneDir = join(dir, 'done')
  let chunks = 0
  for (const f of files) {
    try {
      const src = join(dir, f)
      const text = readFileSync(src, 'utf8')
      const lower = f.toLowerCase()

      // 分流 1：人物关系网（people.md → 人物卡）
      if (/people|人物|人际|关系网/.test(lower)) {
        const cards = parsePeople(text)
        if (cards.length > 0) {
          let written = 0
          for (const card of cards) {
            try {
              writePerson(card.name, card.body, 'replace')
              written += 1
            } catch {}
          }
          mkdirSync(doneDir, { recursive: true })
          renameSync(src, join(doneDir, f))
          logger.info?.('[hcem] reincarnation: ' + f + ' -> 人物卡 ' + written + ' 张')
          continue
        }
      }

      // 分流 1.5：AI 日志（journal.md → data/journal/<名字>.md）
      if (/journal|日志|日记/.test(lower)) {
        try {
          const journalDir = join(dataDir, 'journal')
          mkdirSync(journalDir, { recursive: true })
          const name = f.replace(/\.(md|txt)$/i, '')
          writeFileSync(join(journalDir, name + '.md'), text, 'utf8')
          mkdirSync(doneDir, { recursive: true })
          renameSync(src, join(doneDir, f))
          logger.info?.('[hcem] reincarnation: ' + f + ' -> AI 日志')
          continue
        } catch {}
      }

      // 分流 2：人设（persona.md → persona 卡）
      if (/persona|人设|人格|性格/.test(lower)) {
        try {
          appendPersona(text)
          mkdirSync(doneDir, { recursive: true })
          renameSync(src, join(doneDir, f))
          logger.info?.('[hcem] reincarnation: ' + f + ' -> 人设卡')
          continue
        } catch {}
      }

      // 分流 3：用户卡（用户.md / user.md）
      if (/用户|user/.test(lower)) {
        try {
          appendUserCard(text)
          mkdirSync(doneDir, { recursive: true })
          renameSync(src, join(doneDir, f))
          logger.info?.('[hcem] reincarnation: ' + f + ' -> 用户卡')
          continue
        } catch {}
      }

      // 分流 4：普通记忆 → reincarnation 区
      const parts = splitChunks(text)
      for (const part of parts) {
        const { alpha, beta, gamma } = stampChunk(part)
        let embedding = null
        try {
          if (analyzer && typeof analyzer.embed === 'function') {
            const [vec] = await analyzer.embed([part])
            embedding = vec
          }
        } catch {}
        let causal = { cause: '', effect: '' }
        try {
          causal = await extractCausal(part)
        } catch {}
        store.putMemory({
          cause: causal.cause || null,
          effect: causal.effect || null,
          embedding,
          text: part,
          summary: part.slice(0, 80),
          zone: REINCARNATION_ZONE,
          alphaH: alpha.H,
          alphaS: alpha.S,
          betaH: beta.H,
          gamma: gamma,
          gammaValue: gamma,
          L: 0.6,
          sensory: 1,
          deltaPool: 1.0,
          deltaLong: 0,
        })
        chunks += 1
      }
      // 处理完移入 done/（保留原始备份，防重复导入）
      mkdirSync(doneDir, { recursive: true })
      renameSync(src, join(doneDir, f))
      logger.info?.(`[hcem] reincarnation: ${f} -> ${parts.length} 段`)
    } catch (error) {
      logger.warn?.(`[hcem] reincarnation 导入失败 ${f}: ${String((error && error.message) || error)}`)
    }
  }
  return { ok: true, files: files.length, chunks }
}

/**
 * 把一条 reincarnation 记忆转入生活/知识区（更新戳 + 改区）
 * @param {object} store
 * @param {string} id 记忆 id
 * @param {object} opts { betaH, betaS, alphaH, alphaS, summary, targetZone }
 */
export function promoteReincarnation(store, id, opts = {}) {
  const mem = store.getMemory(id)
  if (!mem) return { ok: false, error: 'not-found' }
  const targetZone = opts.targetZone || (Number(mem.gamma_value ?? 0) >= 0.6 ? 'life' : 'knowledge')
  try {
    // 1) 更新清晰度（γ 高的给更高 L，便于保留细节）
    const gammaValue = Number(opts.gamma ?? mem.gamma_value ?? 0)
    store.updateMemoryL?.(id, Math.max(0.5, Math.min(1, 0.5 + gammaValue * 0.5)), gammaValue >= 0.75 ? 'full' : gammaValue >= 0.5 ? 'summary' : 'short')
    // 2) 改区（reincarnation → 生活/知识）
    store.updateZone?.(id, targetZone)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  return { ok: true, zone: targetZone }
}
