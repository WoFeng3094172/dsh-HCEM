# 启动 HCEM 情绪悬浮小窗（Edge 应用窗口 + 置顶）
$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:8082/hsl?compact=1'
$edgePaths = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw '找不到 msedge.exe' }

$workDir = 'E:\HCEM\HCEM v0.0.2\data\edge-hsl'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HcemWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$hwnd = [HcemWin]::FindByTitle('HCEM 情绪')
if ($hwnd -eq [IntPtr]::Zero) {
  Start-Process -FilePath $edge -ArgumentList @(
    "--app=$url",
    '--window-size=250,300',
    "--user-data-dir=$workDir",
    '--no-first-run',
    '--no-default-browser-check'
  ) | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $hwnd = [HcemWin]::FindByTitle('HCEM 情绪')
    if ($hwnd -ne [IntPtr]::Zero) { break }
  }
}
if ($hwnd -eq [IntPtr]::Zero) { throw '窗口没找到' }

[HcemWin]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
Write-Output "OK hwnd=$hwnd"