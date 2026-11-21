// 帧差检测（P1）：比较两张截图，返回「变化像素占比」（0~1）
// 用 PowerShell + .NET 缩放为 64x36 灰度后逐像素比较（纯 CPU，无需图像库）
// 变化像素 = 灰度差超过阈值的像素；占比比平均差更敏感（小区域变化不会被平均掉）
import { execFile } from 'node:child_process'

/**
 * 计算两张图的变化分数（变化像素占比）
 * @param {string} prevPath 上一张
 * @param {string} curPath 当前
 * @param {number} [pixelThreshold=15] 单像素灰度差阈值
 * @returns {Promise<number>} 0~1（越高变化越大）
 */
export function frameDiff(prevPath, curPath, pixelThreshold = 15) {
  const safePrev = String(prevPath).replace(/'/g, "''")
  const safeCur = String(curPath).replace(/'/g, "''")
  const ps = `
Add-Type -AssemblyName System.Drawing
$w = 64; $h = 36
$i1 = [System.Drawing.Image]::FromFile('${safePrev}')
$i2 = [System.Drawing.Image]::FromFile('${safeCur}')
$b1 = New-Object System.Drawing.Bitmap $w, $h
$b2 = New-Object System.Drawing.Bitmap $w, $h
$g1 = [System.Drawing.Graphics]::FromImage($b1)
$g2 = [System.Drawing.Graphics]::FromImage($b2)
$g1.DrawImage($i1, 0, 0, $w, $h)
$g2.DrawImage($i2, 0, 0, $w, $h)
$changed = 0
$total = $w * $h
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $p1 = $b1.GetPixel($x, $y)
    $p2 = $b2.GetPixel($x, $y)
    $v1 = ($p1.R + $p1.G + $p1.B) / 3
    $v2 = ($p2.R + $p2.G + $p2.B) / 3
    if ([Math]::Abs($v1 - $v2) -gt ${pixelThreshold}) { $changed++ }
  }
}
$ratio = $changed / $total
$g1.Dispose(); $g2.Dispose(); $b1.Dispose(); $b2.Dispose(); $i1.Dispose(); $i2.Dispose()
Write-Output ([Math]::Round($ratio, 4))
`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      const n = parseFloat(String(stdout).trim())
      resolve(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
    })
  })
}

/**
 * 变化判定：超过阈值视为「明显变化」
 * @param {number} diff 变化像素占比
 * @param {number} threshold 阈值（默认 0.03 = 3% 的像素变化）
 */
export function isSignificantChange(diff, threshold = 0.03) {
  return diff >= threshold
}
