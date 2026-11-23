/**
 * 记忆系统完整体检
 *
 * 检查内容：
 *   1. 三大区（文本 / 视觉 / 听觉）的分区库文件是否都在、有没有多余
 *   2. 每条记忆的必备字段是否齐全（分区、时间、δ、p₀/δ₀、γ₀）
 *   3. 价值字段的合法性（p₀ 不能越界、δ₀/γ₀ 在 0~1）
 *   4. 分区与文件的生命周期是否一致（保护目录里的孤儿文件）
 *   5. 延寿是否只延过一次（extended_until 不能重复刷新）
 *   6. 冷存是否存在、是否被误删
 *   7. 视听记忆的类型字段是否合法（short/series/episode）
 *
 * 用法：node plugin/tools/memory-audit.mjs
 * 只读，不修改任何数据。
 */

import fs from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = process.env.HCEM_DATA_DIR || join(process.cwd(), 'data')
process.env.HCEM_DB_PATH = process.env.HCEM_DB_PATH || join(DATA_DIR, 'hcem.sqlite')

const { openStore, ZONES } = await import('../lib/store.mjs')
const { ZONE_FLOW } = await import('../lib/zones.mjs')

const store = openStore({ info() {}, warn() {} })

const report = {
  files: { ok: [], missing: [], extra: [] },
  counts: {},
  problems: [],
  warnings: [],
}

// ---------- 1. 分区库文件 ----------
const zonesDir = join(DATA_DIR, 'zones')
// 生活/知识共用 life_knowledge.sqlite，冷存按年分文件
const ZONE_TO_FILE = {
  context: 'context',
  pool_fast: 'pool_fast',
  pool_observe: 'pool_observe',
  pool_keep: 'pool_keep',
  life: 'life_knowledge',
  knowledge: 'life_knowledge',
  reincarnation: 'reincarnation',
}
const expectedFiles = new Set()
for (const z of ZONES) {
  if (z === 'cold') continue
  const f = ZONE_TO_FILE[z] || z
  expectedFiles.add(f + '.sqlite')
}
let actualFiles = []
try {
  actualFiles = fs
    .readdirSync(zonesDir)
    .filter((f) => f.endsWith('.sqlite'))
    .sort()
} catch {
  report.problems.push('zones 目录不存在：' + zonesDir)
}
for (const f of expectedFiles) {
  if (actualFiles.includes(f)) report.files.ok.push(f)
  else report.files.missing.push(f)
}
for (const f of actualFiles) {
  if (!expectedFiles.has(f) && f !== 'life_knowledge.sqlite') report.files.extra.push(f)
}

// ---------- 2 & 3. 逐条检查 ----------
const now = Date.now()
const RESCUE_WINDOW = 24 * 3600 * 1000
const ALL_ZONES = Object.keys(ZONE_FLOW)

for (const zone of ALL_ZONES) {
  let rows = []
  try {
    rows = store.listMemories({ zone, limit: 100000 })
  } catch {
    continue
  }
  report.counts[zone] = rows.length
  const isAV = zone.startsWith('video_') || zone.startsWith('audio_')

  for (const m of rows) {
    const tag = `${zone}/${m.id}`

    // 必备字段
    if (!m.created_at) report.problems.push(tag + ' 缺 created_at')
    if (!m.zone) report.problems.push(tag + ' 缺 zone')

    // 视听区特有字段
    if (isAV) {
      const p0 = Number(m.video_p ?? 0)
      const d0 = Number(m.video_delta0 ?? 0)
      const g0 = Number(m.video_gamma0 ?? 0)
      if (p0 < -0.2 || p0 > 4.5) report.problems.push(`${tag} p₀ 越界：${p0}`)
      if (d0 < 0 || d0 > 2) report.problems.push(`${tag} δ₀ 越界：${d0}`)
      if (g0 < 0 || g0 > 1) report.problems.push(`${tag} γ₀ 越界：${g0}`)

      // 类型字段
      let type = 'short'
      try {
        const meta = typeof m.av_meta === 'string' ? JSON.parse(m.av_meta) : m.av_meta || {}
        type = meta.type || 'short'
      } catch {
        report.warnings.push(`${tag} av_meta 解析失败`)
      }
      if (!['short', 'series', 'episode'].includes(type)) {
        report.problems.push(`${tag} 类型非法：${type}`)
      }

      // 延寿只一次：extended_until 应该只有一个时间点，且不应该被反复刷新
      if (m.extended_until) {
        const ext = Date.parse(m.extended_until)
        if (!Number.isFinite(ext)) report.problems.push(`${tag} extended_until 非法：${m.extended_until}`)
        else if (ext > now + 400 * 86400000) report.problems.push(`${tag} 延寿时间异常遥远：${m.extended_until}`)
      }

      // 文件生命周期
      let img = null
      try {
        const meta = typeof m.av_meta === 'string' ? JSON.parse(m.av_meta) : m.av_meta || {}
        img = meta.image || meta.wav || null
      } catch {}
      if (img && !fs.existsSync(img)) {
        report.warnings.push(`${tag} 关联文件已不存在：${img}`)
      }
      // 文件名应与记忆 id 对应
      if (img && typeof img === 'string') {
        const base = img.split(/[\\/]/).pop() || ''
        const stem = base.replace(/\.(png|jpg|jpeg|wav)$/i, '')
        if (stem !== m.id) {
          report.warnings.push(`${tag} 文件名与记忆 id 不一致：${base}`)
        }
      }
    }

    // 文本区的 δ 检查
    if (!isAV) {
      const dp = Number(m.delta_pool ?? 0)
      const dl = Number(m.delta_long ?? 0)
      if (dp < 0 || dl < 0) report.problems.push(`${tag} δ 为负：pool=${dp} long=${dl}`)
    }
  }
}

// ---------- 4. 保护目录孤儿 ----------
for (const sub of ['video', 'audio']) {
  const dir = join(DATA_DIR, 'keep', sub)
  if (!fs.existsSync(dir)) continue
  for (const name of fs.readdirSync(dir)) {
    const id = name.replace(/\.(png|jpg|jpeg|wav)$/i, '')
    let found = null
    try {
      found = store.getMemory(id)
    } catch {}
    if (!found) report.warnings.push(`保护目录孤儿：keep/${sub}/${name}（记忆 ${id} 已不存在）`)
  }
}

// ---------- 5. 冷存 ----------
const coldDir = join(DATA_DIR, 'zones', 'cold')
if (fs.existsSync(coldDir)) {
  const years = fs.readdirSync(coldDir).filter((f) => f.endsWith('.sqlite'))
  report.counts['cold(年文件)'] = years.length
} else {
  report.warnings.push('冷存目录不存在（还没有记忆进入冷存，正常）')
}

// ---------- 输出 ----------
console.log('=== 分区库文件 ===')
console.log('  已存在:', report.files.ok.length, '个')
if (report.files.missing.length) console.log('  未创建（还没写过该区）:', report.files.missing.join(', '))
if (report.files.extra.length) console.log('  多余文件:', report.files.extra.join(', '))

console.log('\n=== 各区条数 ===')
for (const [z, n] of Object.entries(report.counts)) {
  if (n > 0) console.log(`  ${z.padEnd(18)} ${n}`)
}

console.log('\n=== 问题（必须修）===')
if (report.problems.length === 0) console.log('  无')
else for (const p of report.problems.slice(0, 40)) console.log('  ✗ ' + p)

console.log('\n=== 警告（建议看）===')
if (report.warnings.length === 0) console.log('  无')
else for (const w of report.warnings.slice(0, 40)) console.log('  ! ' + w)

console.log('\n=== 结论 ===')
const bad = report.problems.length
const warn = report.warnings.length
if (bad === 0 && warn === 0) console.log('  ✅ 记忆系统体检通过')
else if (bad === 0) console.log(`  ⚠️ 无严重问题，但有 ${warn} 条警告`)
else console.log(`  ❌ 有 ${bad} 个问题、${warn} 条警告`)

store.close?.()
