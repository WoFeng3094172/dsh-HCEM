#!/usr/bin/env node
// 训练工具分类头：从 data/classifier/labels.jsonl 学习工具选择偏好
//
// 用法：
//   node plugin/tools/train-classifier.mjs            # 训练并保存
//   node plugin/tools/train-classifier.mjs --status   # 只看当前状态
//   node plugin/tools/train-classifier.mjs --dry      # 训练但不保存
//
// 前置：8094（Qwen3-Embedding）在跑；labels 至少 40 条（建议 2000+）。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { loadLabels, trainHead, saveModel, loadModel, loadConfig, MODEL_PATH } from '../lib/routing/classifier.mjs'

const ARGS = new Set(process.argv.slice(2))
const EMBED_URL = process.env.HCEM_EMBED_URL || 'http://127.0.0.1:8094/v1/embeddings'
const MIN = 40

async function embed(texts) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: texts }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
  const j = await res.json()
  return (j.data || []).map((d) => d.embedding)
}

function status() {
  const cfg = loadConfig()
  const labels = loadLabels()
  const model = loadModel()
  const bySource = {}
  const byTool = {}
  for (const l of labels) {
    bySource[l.source || '?'] = (bySource[l.source || '?'] || 0) + 1
    byTool[l.tool || '?'] = (byTool[l.tool || '?'] || 0) + 1
  }
  console.log('开关：', cfg.enabled ? '开' : '关', '（alpha=' + cfg.alpha + '）')
  console.log('标签：', labels.length, '条', JSON.stringify(bySource))
  console.log('类别：', Object.keys(byTool).length, '个', JSON.stringify(byTool))
  console.log('模型：', model ? `${model.samples} 条 / ${model.tools.length} 类 / 留出 ${(model.testAcc * 100).toFixed(1)}% / ${model.trainedAt}` : '无')
  const minClass = Math.min(...Object.values(byTool), Infinity)
  if (labels.length < 2000) console.log(`⚠️ 建议 2000+ 条（当前 ${labels.length}）`)
  if (Number.isFinite(minClass) && minClass < 30) console.log(`⚠️ 最小类只有 ${minClass} 条（建议 ≥30）`)
}

async function main() {
  if (ARGS.has('--status')) return status()
  const labels = loadLabels()
  if (labels.length < MIN) {
    console.error(`❌ 标签不足：${labels.length} 条（至少 ${MIN}）`)
    process.exit(1)
  }
  // 去重（同一 query + tool 只保留一条）防泄漏
  const seen = new Set()
  const uniq = labels.filter((l) => {
    if (!l?.query || !l?.tool) return false
    const k = l.query + '|' + l.tool
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  console.log(`样本：${labels.length} → 去重后 ${uniq.length}`)

  const samples = []
  for (let i = 0; i < uniq.length; i += 8) {
    const batch = uniq.slice(i, i + 8)
    const vecs = await embed(batch.map((b) => b.query))
    batch.forEach((b, j) => {
      if (Array.isArray(vecs[j])) samples.push({ vec: vecs[j], tool: b.tool, state: b.state || {}, aqua: b.aqua || 0 })
    })
    process.stdout.write(`\r向量化 ${Math.min(i + 8, uniq.length)}/${uniq.length}`)
  }
  console.log()

  const r = trainHead({ samples })
  if (!r.ok) {
    console.error('❌', r.error)
    process.exit(1)
  }
  console.log('训练报告：', JSON.stringify(r.report))
  if (ARGS.has('--dry')) return console.log('（--dry：未保存）')
  if (existsSync(MODEL_PATH)) {
    copyFileSync(MODEL_PATH, MODEL_PATH + '.bak')
    console.log('已备份旧模型 → head.json.bak')
  }
  const s = saveModel(r.model)
  console.log(s.ok ? '✅ 已保存 data/classifier/head.json' : '❌ 保存失败：' + s.error)
}

main().catch((e) => {
  console.error('训练失败：', String((e && e.message) || e))
  process.exit(1)
})
