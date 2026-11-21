/**
 * 回填记忆向量
 *
 * 背景：视觉/听觉记忆的写入器（putVideoMemory / putAudioMemory）
 * 以前完全不写 embedding 字段，所以那些记忆在语义检索里查不到
 * （实测 47 条 video_observe 一条向量都没有）。写入器已修，
 * 这个脚本负责把历史数据补上。
 *
 * 用法：
 *   node plugin/tools/backfill-embeddings.mjs            # 只报告
 *   node plugin/tools/backfill-embeddings.mjs --apply    # 真的写
 *   node plugin/tools/backfill-embeddings.mjs --apply --zone video_observe
 *
 * 需要 Qwen3-Embedding 在 8094 上跑着。
 */
import { openStore } from '../lib/store.mjs'

const EMBEDDING_URL = process.env.HCEM_EMBED_URL || 'http://127.0.0.1:8094/v1/embeddings'
const BATCH = 8

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const zoneArg = (() => {
  const i = args.indexOf('--zone')
  return i >= 0 ? args[i + 1] : null
})()

async function embed(texts) {
  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: texts }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error('embedding HTTP ' + res.status)
  const data = await res.json()
  return data.data.map((d) => d.embedding)
}

const store = openStore({ info() {}, warn() {}, debug() {}, error() {} })
const zones = zoneArg
  ? [zoneArg]
  : [
      'context', 'life', 'knowledge',
      'video_context', 'video_fast', 'video_observe', 'video_keep', 'video_weekly', 'video_1', 'video_2',
      'audio_context', 'audio_buffer', 'audio_1', 'audio_2',
      'reincarnation',
    ]

let totalMissing = 0
let totalFixed = 0
let totalFailed = 0

for (const zone of zones) {
  let rows = []
  try {
    rows = store.listMemories({ zone, limit: 5000 })
  } catch {
    continue
  }
  const missing = rows.filter((m) => !m.embedding || m.embedding.length === 0)
  if (rows.length === 0) continue
  console.log(`${zone}: 共 ${rows.length} 条，缺向量 ${missing.length}`)
  if (missing.length === 0) continue
  totalMissing += missing.length
  if (!apply) continue

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const texts = batch.map((m) => String(m.text || m.summary || '').slice(0, 500) || '(空)')
    let vecs = null
    try {
      vecs = await embed(texts)
    } catch (e) {
      totalFailed += batch.length
      console.log(`  批次 ${i / BATCH + 1} 失败: ${String((e && e.message) || e)}`)
      continue
    }
    for (let k = 0; k < batch.length; k += 1) {
      const ok = store.setMemoryEmbedding(batch[k].id, vecs[k])
      if (ok) totalFixed += 1
      else totalFailed += 1
    }
    process.stdout.write(`  已回填 ${Math.min(i + BATCH, missing.length)}/${missing.length}\r`)
  }
  console.log('')
}

console.log(`\n合计缺向量 ${totalMissing} 条；本次回填 ${totalFixed} 条，失败 ${totalFailed} 条`)
if (!apply && totalMissing > 0) console.log('（这是预演，加 --apply 才会真的写）')
store.close?.()
