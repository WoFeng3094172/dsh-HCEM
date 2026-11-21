// 语义缓存（S1）：本地 embedding + 余弦相似度 → 命中直接返回历史答案，绕过云端
// 存储：data/semantic-cache.jsonl（一行一条：{id, text, embedding, answer, ts, hits}）
// 规则：TTL 7 天；容量 500；用户纠正可删除；相似度阈值默认 0.88
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import './home.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = process.env.HCEM_DATA_DIR || globalThis.__HCEM_DATA__
// Qwen3-Embedding（8094，1024 维，区分度更好）
const EMBEDDING_URL = process.env.HCEM_EMBED_URL || 'http://127.0.0.1:8094/v1/embeddings'

export const CACHE_DEFAULT_THRESHOLD = 0.88
export const CACHE_TTL_DAYS = 7
export const CACHE_MAX_ENTRIES = 500

function cachePath(dataDir) {
  return join(dataDir || DEFAULT_DATA_DIR, 'semantic-cache.jsonl')
}

/** 本地 embedding（8081） */
export async function embedText(text) {
  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'hcem-embed', input: [String(text)] }),
  })
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
  const data = await res.json()
  return data.data[0].embedding
}

/** 余弦相似度 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 读取全部缓存（含过期清理） */
export function loadCache(dataDir) {
  const p = cachePath(dataDir)
  if (!existsSync(p)) return []
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400000
  const entries = []
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e.ts >= cutoff) entries.push(e)
      } catch {}
    }
  } catch {}
  return entries
}

/** 写入一条缓存 */
export function storeCache({ dataDir, text, embedding, answer }) {
  const p = cachePath(dataDir)
  mkdirSync(dirname(p), { recursive: true })
  const entry = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: String(text).slice(0, 2000),
    embedding,
    answer: String(answer).slice(0, 8000),
    ts: Date.now(),
    hits: 0,
  }
  appendFileSync(p, JSON.stringify(entry) + '\n')
  return entry
}

/** 查询：返回命中 {hit, answer, score, id} */
export async function lookupCache(text, { dataDir, threshold = CACHE_DEFAULT_THRESHOLD } = {}) {
  const entries = loadCache(dataDir)
  if (entries.length === 0) return { hit: false }
  let vec
  try {
    vec = await embedText(text)
  } catch {
    return { hit: false, error: 'embedding-unavailable' }
  }
  let best = null
  for (const e of entries) {
    const s = cosine(vec, e.embedding)
    if (!best || s > best.score) best = { entry: e, score: s }
  }
  if (best && best.score >= threshold) {
    return { hit: true, answer: best.entry.answer, score: best.score, id: best.entry.id }
  }
  return { hit: false, bestScore: best?.score ?? 0 }
}

/** 用户纠正：删除匹配文本（或 id）的缓存 */
export function removeCache({ dataDir, text, id }) {
  const p = cachePath(dataDir)
  if (!existsSync(p)) return 0
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
  const kept = []
  let removed = 0
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if ((id && e.id === id) || (text && e.text === text)) {
        removed += 1
        continue
      }
      kept.push(line)
    } catch {
      kept.push(line)
    }
  }
  if (removed > 0) writeFileSync(p, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  return removed
}

/** 清理：TTL + 容量上限 */
export function pruneCache(dataDir) {
  const entries = loadCache(dataDir)
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400000
  let alive = entries.filter((e) => e.ts >= cutoff).sort((a, b) => b.ts - a.ts)
  if (alive.length > CACHE_MAX_ENTRIES) alive = alive.slice(0, CACHE_MAX_ENTRIES)
  const p = cachePath(dataDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, alive.map((e) => JSON.stringify(e)).join('\n') + (alive.length ? '\n' : ''), 'utf8')
  return { kept: alive.length }
}
