// 窗口检测（Windows）：获取前台/指定窗口的位置 → 用于 ROI 截图
// 用 PowerShell + user32 P/Invoke（GetForegroundWindow / GetWindowRect）
import { execFileSync } from 'node:child_process'

const PS = 'powershell.exe'

const SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
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
  if (!win || !win.ok) return false
  const process = String(win.process || '')
  const title = String(win.title || '')
  // 播放器进程：只认真正的播放器，浏览器进程本身不算
  if (/potplayer|mpv|vlc|mpc-hc|wmplayer|player/i.test(process)) return true
  // 浏览器/网页：标题必须命中视频站；不能因为标题里出现“视频”两个字就算
  // （实测 GitHub 的 README 标题含“视频分镜”会被误判，导致桌面每 6 秒被截）
  if (/bilibili|youtube|netflix|iqiyi|youku|douyin|tiktok|twitch|哔哩哔哩|b\s*站/i.test(title)) return true
  return false
}


// ── 枚举所有可见窗口（含非前台）────────────────────────────
// 用途：视频在第二块屏/后台窗口时，前台是聊天窗口，不能只靠 getForegroundWindow。
const ENUM_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$out = New-Object System.Collections.ArrayList
$cb = [WinEnum+EnumWindowsProc]{
  param($h, $l)
  if ([WinEnum]::IsWindowVisible($h)) {
    $len = [WinEnum]::GetWindowTextLength($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][WinEnum]::GetWindowText($h, $sb, $sb.Capacity)
      $r = New-Object WinEnum+RECT
      [void][WinEnum]::GetWindowRect($h, [ref]$r)
      $procId = 0
      [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$procId)
      $proc = ''
      try { $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } catch {}
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      if ($w -gt 160 -and $ht -gt 120) {
        [void]$out.Add([pscustomobject]@{ handle=[int64]$h; left=$r.Left; top=$r.Top; width=$w; height=$ht; title=$sb.ToString(); process=$proc; pid=$procId })
      }
    }
  }
  return $true
}
[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($out)
`

let __winCache = { at: 0, list: [] }

/**
 * 列出当前所有可见窗口（含非前台）
 * @param {{maxAgeMs?:number}} opts 缓存时间，默认 5 秒
 * @returns {Array<{handle:number,left:number,top:number,width:number,height:number,title:string,process:string,pid:number}>}
 */
export function listWindows({ maxAgeMs = 5000 } = {}) {
  const now = Date.now()
  if (now - __winCache.at < maxAgeMs && __winCache.list.length > 0) return __winCache.list.slice()
  try {
    const out = execFileSync(PS, ['-NoProfile', '-Command', ENUM_SCRIPT], {
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
    })
    const raw = JSON.parse(String(out).trim().split('\n').pop())
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((x) => ({
        handle: Number(x.handle) || 0,
        left: Number(x.left) || 0,
        top: Number(x.top) || 0,
        width: Number(x.width) || 0,
        height: Number(x.height) || 0,
        title: String(x.title || ''),
        process: String(x.process || ''),
        pid: Number(x.pid) || 0,
      }))
      .filter((w) => w.width > 0 && w.height > 0)
    __winCache = { at: now, list }
    return list.slice()
  } catch {
    return __winCache.list.slice()
  }
}

/** 视频类窗口（按面积从大到小） */
export function listVideoWindows() {
  return listWindows()
    .filter((w) => isVideoWindow({ ok: true, title: w.title, process: w.process }))
    .sort((a, b) => b.width * b.height - a.width * a.height)
}


/** 过滤掉桌面壳/任务栏/输入法这类“不是内容”的窗口 */
function isContentWindow(w) {
  const t = String(w.title || '').trim()
  if (!t) return false
  if (/^(Program Manager|Windows 输入体验|ShellExperienceHost|Microsoft Text Input Application)$/i.test(t)) return false
  if (/^Windows 默认锁屏界面$/i.test(t)) return false
  return w.width >= 200 && w.height >= 120
}

/**
 * 某块屏幕上「有内容的窗口」（按面积从大到小）
 * @param {{x:number,y:number,width:number,height:number}} screen
 */
export function windowsOnScreen(screen) {
  if (!screen) return []
  return listWindows()
    .filter((w) => {
      if (!isContentWindow(w)) return false
      const cx = w.left + w.width / 2
      const cy = w.top + w.height / 2
      return cx >= screen.x && cx < screen.x + screen.width && cy >= screen.y && cy < screen.y + screen.height
    })
    .sort((a, b) => b.width * b.height - a.width * a.height)
}
