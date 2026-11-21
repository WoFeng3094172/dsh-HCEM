// 画面路由器（P1）：判断当前画面是「桌面/文档」还是「视频/游戏」
// 启发式（零模型）：
//   - 动态性：近期帧差均值（高 → 视频/游戏）
//   - 亮度分布：暗色占比（游戏/视频常见）
//   - 文字密度：亮像素细碎度（文档/桌面高）
// 返回 'desktop' | 'video' | 'unknown'
import { execFile } from 'node:child_process'

/**
 * 分析一张图的亮度分布（0~1 暗像素占比 / 文字密度代理）
 * @param {string} imagePath
 */
export function analyzeBrightness(imagePath) {
  const safe = String(imagePath).replace(/'/g, "''")
  const ps = `
Add-Type -AssemblyName System.Drawing
$w = 64; $h = 36
$i = [System.Drawing.Image]::FromFile('${safe}')
$b = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($b)
$g.DrawImage($i, 0, 0, $w, $h)
$dark = 0
$bright = 0
$total = $w * $h
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $p = $b.GetPixel($x, $y)
    $v = ($p.R + $p.G + $p.B) / 3
    if ($v -lt 60) { $dark++ }
    elseif ($v -gt 200) { $bright++ }
  }
}
$g.Dispose(); $b.Dispose(); $i.Dispose()
Write-Output ("{0},{1},{2}" -f [Math]::Round($dark/$total,3), [Math]::Round($bright/$total,3), $total)
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve({ dark: 0, bright: 0 })
        return
      }
      const parts = String(stdout).trim().split(',')
      resolve({ dark: parseFloat(parts[0]) || 0, bright: parseFloat(parts[1]) || 0 })
    })
  })
}

/**
 * 路由器：根据帧差历史 + 亮度分布分类
 * @param {object} input { diffHistory: number[], brightness: {dark,bright}, windowTitle?: string }
 */
export function classifyScreen(input = {}) {
  const diffs = Array.isArray(input.diffHistory) ? input.diffHistory : []
  const avgDiff = diffs.length > 0 ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0
  const { dark = 0, bright = 0 } = input.brightness || {}
  const title = String(input.windowTitle || '').toLowerCase()

  // 标题线索
  if (/游戏|game|steam|play|video|视频|电影|bilibili|youtube|netflix/.test(title)) return 'video'
  if (/文档|word|excel|code|editor|浏览器|browser|chrome|edge|terminal|cmd/.test(title)) return 'desktop'

  // 动态性：帧差均值高 → 视频/游戏
  if (avgDiff > 0.05) return 'video'
  // 暗色占比高（>55%）→ 游戏/视频
  if (dark > 0.55) return 'video'
  // 亮色占比高（>45%）→ 文档/桌面
  if (bright > 0.45) return 'desktop'
  return 'unknown'
}
