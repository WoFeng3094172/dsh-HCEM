// 视频/音频记忆分区测试（骨架规则）
import assert from 'node:assert'
import fs from 'node:fs'

const TMP = `${globalThis.__HCEM_HOME__}/.test-data/av-zones`
fs.rmSync(TMP, { recursive: true, force: true })
process.env.HCEM_DB_PATH = TMP + '/hcem.sqlite'
const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const DAY = 24 * H
const now = Date.now()

function put(zone, meta, ageHours) {
  const id = store.putMemory({ text: 'av-' + zone + '-' + Math.random().toString(36).slice(2, 6), zone })
  if (meta) store.setAvMeta(id, meta)
  const at = new Date(now - ageHours * H).toISOString()
  store.zoneDb(zone).prepare('UPDATE memories SET created_at=?, updated_at=?, last_accessed_at=? WHERE id=?').run(at, at, at, id)
  return id
}

// 视频保留池：p₀=0 且 δ₀=0 → 遗忘
const v1 = put('video_keep', { videoP: 0, videoDelta0: 0 }, 80)
// 视频保留池：p₀=1 → 视频Ⅰ区
const v2 = put('video_keep', { videoP: 1, videoDelta0: 0.2 }, 80)
// 视频保留池：δ₀=1.3 → 视频Ⅰ区
const v3 = put('video_keep', { videoP: 0, videoDelta0: 1.3 }, 80)
// 周更池 → 视频Ⅰ区
const v4 = put('video_weekly', null, 200)
// 视频Ⅰ区：δ₀=1.1 → 视频Ⅱ区
const v5 = put('video_1', { videoP: 0.5, videoDelta0: 1.1 }, 24)
// 视频Ⅰ区：δ₀=0.5 且超过 10 天 → 遗忘
const v6 = put('video_1', { videoP: 0, videoDelta0: 0.5 }, 11 * 24)

// 音频：缓冲池 → Ⅰ区
const a1 = put('audio_buffer', { audioKind: 'voice' }, 80)
// 音频：Ⅰ区 → Ⅱ区
const a2 = put('audio_1', { audioKind: 'music', audioFp: 'fp123' }, 1)

promoteMemories(store, now)

assert.strictEqual(store.getMemory(v1), null, '视频保留池 p₀=0/δ₀=0 → 遗忘')
assert.strictEqual(store.getMemory(v2)?.zone, 'video_1', 'p₀=1 → 视频Ⅰ区')
assert.strictEqual(store.getMemory(v3)?.zone, 'video_1', 'δ₀=1.3 → 视频Ⅰ区')
assert.strictEqual(store.getMemory(v4)?.zone, 'video_1', '周更池 → 视频Ⅰ区')
assert.strictEqual(store.getMemory(v5)?.zone, 'video_2', '视频Ⅰ区 δ₀=1.1 → 视频Ⅱ区')
assert.strictEqual(store.getMemory(v6), null, '视频Ⅰ区 δ₀=0.5 且超 10 天 → 遗忘')
assert.strictEqual(store.getMemory(a1)?.zone, 'audio_1', '音频缓冲池 → 音频Ⅰ区')
assert.strictEqual(store.getMemory(a2)?.zone, 'audio_2', '音频Ⅰ区 → 音频Ⅱ区')

store.close()
fs.rmSync(`${globalThis.__HCEM_HOME__}/.test-data`, { recursive: true, force: true })
console.log('ALL AV ZONES TESTS PASSED')
