// 屏幕捕获（P1）：检测多屏 + 按屏截图 + 缩放 + 局部二次截图
// 检测多屏不需要额外权限（System.Windows.Forms.Screen 是公开 API）
import { execFile } from 'node:child_process'

/**
 * 检测所有屏幕
 * @returns {Promise<Array<{index:number, device:string, x:number, y:number, width:number, height:number, primary:boolean}>>}
 */
export function listScreens() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$out = @()
$i = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  $out += ("{0},{1},{2},{3},{4},{5}" -f $i, $s.DeviceName, $b.X, $b.Y, $b.Width, $b.Height)
  $i++
}
Write-Output ($out -join [char]10)
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      const screens = String(stdout)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [index, device, x, y, width, height] = line.split(',')
          return {
            index: Number(index),
            device,
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
            primary: Number(x) === 0 && Number(y) === 0,
          }
        })
      resolve(screens)
    })
  })
}

/**
 * 截图到 PNG
 *
 * 默认只截**主显示器**。早期版本用 SystemInformation.VirtualScreen（所有屏横向拼接），
 * 三屏 5680×1152 缩到 1280 宽后只有 1280×260 —— 视觉模型看到一张极扁的拼接图，
 * 会报「屏幕全黑 / 无内容」，注入到提示词里就是重复无效的描述。现在按目标区域直接抓图，
 * 宽高比与原屏一致（主屏 2048×1152 → 1280×720）。
 *
 * @param {string} outPath 输出路径
 * @param {object} opts
 * @param {number} [opts.maxWidth=1280] 缩放最大宽度（0 = 不缩放）
 * @param {number} [opts.screenIndex] 指定屏幕（默认主屏）
 * @param {{left:number,top:number,width:number,height:number}} [opts.region] 局部区域（绝对屏幕坐标，优先于 screenIndex）
 * @returns {Promise<string>}
 */
export function captureScreen(outPath, opts = {}) {
  const safe = String(outPath).replace(/'/g, "''")
  const maxWidth = Number(opts.maxWidth ?? 1280) || 0
  const region = opts.region
  const trimBlack = opts.trimBlack === true
  const screenIndex = Number.isInteger(opts.screenIndex) ? opts.screenIndex : null

  let regionPs
  if (region) {
    regionPs = `New-Object System.Drawing.Rectangle(${Math.round(region.left)}, ${Math.round(region.top)}, ${Math.round(region.width)}, ${Math.round(region.height)})`
  } else if (screenIndex !== null) {
    regionPs = `([System.Windows.Forms.Screen]::AllScreens[${screenIndex}].Bounds)`
  } else {
    regionPs = `([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)`
  }

  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$r = ${regionPs}
$bmp = New-Object System.Drawing.Bitmap $r.Width, $r.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$scale = [Math]::Min(1.0, ${maxWidth > 0 ? maxWidth : '$r.Width'} / $r.Width)
$w = [Math]::Max(1, [int]($r.Width * $scale))
$h = [Math]::Max(1, [int]($r.Height * $scale))
$crop = New-Object System.Drawing.Bitmap $w, $h
$cg = [System.Drawing.Graphics]::FromImage($crop)
$cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle(0, 0, $r.Width, $r.Height)), [System.Drawing.GraphicsUnit]::Pixel)
$trim = ${trimBlack ? '$true' : '$false'}
$outBmp = $crop
if ($trim) {
  $minL = $w; $minT = $h; $maxR = -1; $maxB = -1
  for ($y = 0; $y -lt $h; $y += 3) {
    for ($x = 0; $x -lt $w; $x += 3) {
      $px = $crop.GetPixel($x, $y)
      if (([int]$px.R + [int]$px.G + [int]$px.B) -gt 30) {
        if ($x -lt $minL) { $minL = $x }
        if ($x -gt $maxR) { $maxR = $x }
        if ($y -lt $minT) { $minT = $y }
        if ($y -gt $maxB) { $maxB = $y }
      }
    }
  }
  if ($maxR -gt $minL -and $maxB -gt $minT -and (($maxR - $minL + 1) -lt $w -or ($maxB - $minT + 1) -lt $h)) {
    $cw = $maxR - $minL + 1
    $ch = $maxB - $minT + 1
    $outBmp = New-Object System.Drawing.Bitmap $cw, $ch
    $g2 = [System.Drawing.Graphics]::FromImage($outBmp)
    $g2.DrawImage($crop, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($minL, $minT, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
    $g2.Dispose()
  }
}
$outBmp.Save('${safe}')
if (-not [object]::ReferenceEquals($outBmp, $crop)) { $outBmp.Dispose() }
$cg.Dispose(); $crop.Dispose(); $g.Dispose(); $bmp.Dispose()
`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 30000 }, (error) => {
      if (error) reject(error)
      else resolve(outPath)
    })
  })
}
