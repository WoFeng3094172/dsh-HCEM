/**
 * 记忆系统端到端校验（模拟时间推进，不碰真实数据）
 *
 * 走一遍完整生命周期：
 *   视觉：上下文 → 快池 → 观察池 → 保留池 → Ⅰ区 → Ⅱ区
 *   听觉：上下文 → 缓冲池 → Ⅰ区 → Ⅱ区
 *   延寿：只能延一次
 *   遗忘：连带删文件
 *   冷存：保住
 */

import fs from 'node:fs'
import { join } from 'node:path'

const TMP = `${globalThis.__HCEM_HOME__}/.test-e2e`
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
process.env.HCEM_DB_PATH = join(TMP, 'hcem.sqlite')

const { openStore } = await import('../lib/store.mjs')
const { promoteMemories } = await import('../lib/zones.mjs')
const { putVideoMemory } = await import('../lib/memory-video.mjs')
const { rescueMemory } = await import('../lib/memory-rescue.mjs')

const store = openStore({ info() {}, warn() {} })
const H = 3600 * 1000
const DAY = 24 * H
let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
  }
}

/** 逐段推进：把记忆在各区里老到指定小时数，然后跑一次转区 */
function promoteAt(id, zones, hoursList) {
  for (let i = 0; i < zones.length; i++) {
    const cur = store.getMemory(id)
    if (!cur) return
    ageMemory(id, cur.zone, hoursList[i])
    promoteMemories(store, Date.now())
  }
}
/** 把记忆的时间戳往前推（模拟时间流逝） */
function ageMemory(id, zone, hours) {
  const at = new Date(Date.now() - hours * H).toISOString()
  const db = store.zoneDb(zone)
  db.prepare('UPDATE memories SET created_at=?, updated_at=?, last_accessed_at=?, zone_since=? WHERE id=?').run(at, at, at, at, id)
}

console.log('\n=== 一、视觉记忆完整流转 ===')

// ① 低价值：应该被遗忘
const lowVal = putVideoMemory({
  store,
  description: '一个无聊的静态画面',
  dataDir: TMP,
  diff: 0.01, // 几乎没变化 → δ₀ 很低
  priority: 'low',
  alpha: { H: 30, S: 10 },
  modelScore: 0,
})
check('低价值记忆写入', lowVal.ok, JSON.stringify(lowVal))
// 逐段推进：context 2h → fast 2h → observe 24h → keep 72h
promoteAt(lowVal.id, ['video_context', 'video_fast', 'video_observe', 'video_keep'], [3, 3, 25, 73])
promoteMemories(store, Date.now())
check('低价值记忆已被遗忘', store.getMemory(lowVal.id) === null)

// ② 高价值：p₀ 够 → 进Ⅰ区
const highVal = putVideoMemory({
  store,
  description: '一段很精彩的画面，海边日落，人群欢呼',
  dataDir: TMP,
  diff: 0.5,
  priority: 'high',
  alpha: { H: 30, S: 80 },
  modelScore: 0.9,
  p0: 1.2, // 已经有足够喜好度
})
check('高价值记忆写入', highVal.ok)
promoteAt(highVal.id, ['video_context', 'video_fast', 'video_observe'], [3, 3, 25])
check('推进到观察池或更后', ['video_observe', 'video_keep'].includes(store.getMemory(highVal.id)?.zone), store.getMemory(highVal.id)?.zone)
ageMemory(highVal.id, 'video_keep', 73)
promoteMemories(store, Date.now())
check('高价值记忆进入Ⅰ区', store.getMemory(highVal.id)?.zone === 'video_1', store.getMemory(highVal.id)?.zone)

// ③ Ⅰ区 → Ⅱ区（δ₀ 达标）
const m1 = store.getMemory(highVal.id)
store.setAvMeta(highVal.id, { videoDelta0: 1.1 })
ageMemory(highVal.id, 'video_1', 1)
promoteMemories(store, Date.now())
check('δ₀ 达标进入Ⅱ区', store.getMemory(highVal.id)?.zone === 'video_2', store.getMemory(highVal.id)?.zone)

console.log('\n=== 二、延寿只能一次 ===')
const rescue1 = putVideoMemory({
  store,
  description: '待抢救的画面',
  dataDir: TMP,
  diff: 0.3,
  priority: 'high',
  alpha: { H: 30, S: 60 },
  modelScore: 0.6,
  p0: 0.4,
})
check('待抢救记忆写入', rescue1.ok)
const r1 = rescueMemory(store, rescue1.id, { by: 'ai', reason: '第一次救' })
check('第一次抢救成功', r1.ok, JSON.stringify(r1))
const r2 = rescueMemory(store, rescue1.id, { by: 'ai', reason: '想再救一次' })
check('第二次抢救被拒绝', r2.ok === false, JSON.stringify(r2))

console.log('\n=== 三、遗忘时连带删文件 ===')
const tmpShot = join(TMP, 'shot.png')
fs.writeFileSync(tmpShot, Buffer.from('89504e470d0a1a0a', 'hex'))
const withImg = putVideoMemory({
  store,
  description: '带关键帧的记忆',
  image: tmpShot,
  dataDir: TMP,
  diff: 0.4,
  priority: 'high',
  alpha: { H: 30, S: 70 },
  modelScore: 0.8,
  p0: 0.1,
})
const imgPath = join(TMP, 'keep', 'video', withImg.id + '.png')
check('关键帧文件存在', fs.existsSync(imgPath))
promoteAt(withImg.id, ['video_context', 'video_fast', 'video_observe', 'video_keep'], [3, 3, 25, 73])
promoteMemories(store, Date.now())
check('低 p₀/δ₀ 记忆被遗忘', store.getMemory(withImg.id) === null)
check('关键帧文件被连带删除', !fs.existsSync(imgPath))

console.log('\n=== 四、音频记忆流转 ===')
const { putAudioMemory } = await import('../lib/audio/memory.mjs')
const a1 = putAudioMemory({
  store,
  tick: { ok: true, text: '一段测试语音', emotion: 'happy', emotionScore: 0.8, kind: 'voice', tags: [], wav: null },
  alpha: { H: 30, S: 60 },
  dataDir: TMP,
})
check('音频记忆写入（音频缓冲池）', a1.ok)
const audioRow = store.getMemory(a1.id)
check('音频区正确（听觉上下文）', audioRow?.zone === 'audio_context', audioRow?.zone)
check('音频 γ₀ 已写', Number(audioRow?.video_gamma0) > 0, String(audioRow?.video_gamma0))
check('音频 δ₀ 已写', Number(audioRow?.video_delta0) > 0, String(audioRow?.video_delta0))

console.log('\n=== 五、冷存不被误删 ===')
const coldId = store.putMemory({ text: '一条冷存记忆', zone: 'cold' })
promoteMemories(store, Date.now())
check('冷存记忆仍在', store.getMemory(coldId) !== null)

console.log('\n=== 六、三大区分文件 ===')
const zoneFiles = fs.readdirSync(join(TMP, 'zones')).filter((f) => f.endsWith('.sqlite'))
check('视觉区有独立文件', zoneFiles.some((f) => f.startsWith('video_')), zoneFiles.join(','))
check('听觉区有独立文件', zoneFiles.some((f) => f.startsWith('audio_')), zoneFiles.join(','))
check('文本区有独立文件', zoneFiles.includes('context.sqlite'), zoneFiles.join(','))

console.log('\n=== 结果 ===')
console.log(`  通过 ${pass} / 失败 ${fail}`)
if (fail === 0) console.log('  ✅ 全流程通过')
else console.log('  ❌ 有失败项')

store.close?.()
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
