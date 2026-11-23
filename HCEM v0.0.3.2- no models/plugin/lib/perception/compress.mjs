// 压缩层（P1）：按画面类型选择压缩策略
// - 桌面/文档 → ForestPrune（保留文字/UI 结构，精炼描述）
// - 视频/游戏 → FrameFusion（相似帧融合/去重）
// 简化实现（论文算法的实用近似）：
//   ForestPrune：对文档帧提取文字块（OCR 或 Qwen 描述），只留结构化摘要
//   FrameFusion：aHash 相似度去重，相邻相似帧只保留第一帧
import { execFile } from 'node:child_process'

/**
 * 计算图片的 8x8 灰度 aHash（64 位十六进制）
 * @param {string} imagePath
 * @returns {Promise<string>}
 */
export function aHash(imagePath) {
  const safe = String(imagePath).replace(/'/g, "''")
  const ps = `
Add-Type -AssemblyName System.Drawing
$i = [System.Drawing.Image]::FromFile('${safe}')
$b = New-Object System.Drawing.Bitmap 8, 8
$g = [System.Drawing.Graphics]::FromImage($b)
$g.DrawImage($i, 0, 0, 8, 8)
$vals = @()
for ($y = 0; $y -lt 8; $y++) {
  for ($x = 0; $x -lt 8; $x++) {
    $p = $b.GetPixel($x, $y)
    $vals += (($p.R + $p.G + $p.B) / 3)
  }
}
$avg = ($vals | Measure-Object -Average).Average
$bits = ''
foreach ($v in $vals) { if ($v -ge $avg) { $bits += '1' } else { $bits += '0' } }
$hex = ''
for ($i = 0; $i -lt 64; $i += 4) {
  $nibble = 0
  for ($j = 0; $j -lt 4; $j++) { if ($bits[$i + $j] -eq '1') { $nibble += [Math]::Pow(2, 3 - $j) } }
  $hex += '{0:x}' -f [int]$nibble
}
$g.Dispose(); $b.Dispose(); $i.Dispose()
Write-Output $hex
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).trim())
    })
  })
}

/**
 * 汉明距离（十六进制 aHash）
 */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    for (let b2 = 0; b2 < 4; b2 += 1) if ((x >> b2) & 1) d += 1
  }
  return d
}

/**
 * FrameFusion（视频/游戏）：相似帧去重
 * @param {Array<{path:string, t:number}>} frames
 * @param {number} maxDistance 汉明距离阈值（默认 5，越小越严格）
 * @returns {Promise<Array<{path:string, t:number}>>} 去重后的关键帧
 */
export async function frameFusion(frames, maxDistance = 5) {
  const kept = []
  let lastHash = null
  for (const f of frames) {
    const h = await aHash(f.path)
    if (!h) continue
    if (lastHash && hammingDistance(h, lastHash) <= maxDistance) continue
    kept.push(f)
    lastHash = h
  }
  return kept
}

/**
 * ForestPrune（桌面/文档）：从描述文本中保留结构化信息
 * 简化：去掉语气词/重复，保留关键句 + 数值/列表
 * @param {string} text
 * @returns {string}
 */
export function forestPruneText(text) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/(嗯|啊|哦|呃|那个|然后)/g, '')
    .trim()
  if (t.length <= 200) return t
  // 超长时保留前 2 句 + 含数字/列表的句子
  const sentences = t.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter(Boolean)
  const keep = []
  for (const s of sentences) {
    if (keep.length < 2) keep.push(s)
    else if (/\d/.test(s) && keep.length < 5) keep.push(s)
  }
  return keep.join(' ')
}
