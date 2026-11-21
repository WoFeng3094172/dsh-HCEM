// 窗口检测（Windows）：获取前台/指定窗口的位置 → 用于 ROI 截图
// 用 PowerShell + user32 P/Invoke（GetForegroundWindow / GetWindowRect）
import { execFileSync } from 'node:child_process'

const PS = 'powershell.exe'

const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$h = [Win32]::GetForegroundWindow()
$r = New-Object Win32+RECT
[void][Win32]::GetWindowRect($h, [ref]$r)
$p = Get-Process | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1
$out = @{
  handle = [int64]$h
  left = $r.Left
  top = $r.Top
  right = $r.Right
  bottom = $r.Bottom
  width = $r.Right - $r.Left
  height = $r.Bottom - $r.Top
  title = if ($p) { $p.MainWindowTitle } else { '' }
  process = if ($p) { $p.ProcessName } else { '' }
  pid = if ($p) { $p.Id } else { 0 }
}
ConvertTo-Json -Compress -InputObject $out
`

/**
 * 获取前台窗口 rect（屏幕坐标）
 * @returns {{ok:boolean, left?:number, top?:number, width?:number, height?:number, title?:string, process?:string, error?:string}}
 */
export function getForegroundWindow() {
  try {
    const out = execFileSync(PS, ['-NoProfile', '-Command', SCRIPT], {
      timeout: 10000,
      encoding: 'utf8',
      windowsHide: true,
    })
    const data = JSON.parse(String(out).trim().split('\n').pop())
    if (!data || !(data.width > 0) || !(data.height > 0)) return { ok: false, error: 'invalid rect' }
    return {
      ok: true,
      left: data.left,
      top: data.top,
      width: data.width,
      height: data.height,
      title: data.title ?? '',
      process: data.process ?? '',
      pid: Number(data.pid) || 0,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

/** 判断窗口是否是「视频类」（标题含播放器/视频站点关键词） */
export function isVideoWindow(win) {
  if (!win?.ok) return false
  const t = String(win.title || '') + ' ' + String(win.process || '')
  return /bilibili|youtube|video|player|mpv|vlc|potplayer|chrome|edge|firefox|播放|视频/i.test(t)
}
