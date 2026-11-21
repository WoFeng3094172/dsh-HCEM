# 鼠标轨迹常驻输出（每 100ms 一行 "x,y"）
# 用一次启动、持续输出的方式，避免反复起进程
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CursorPos {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$p = New-Object CursorPos+POINT
while ($true) {
  [void][CursorPos]::GetCursorPos([ref]$p)
  Write-Output "$($p.X),$($p.Y)"
  Start-Sleep -Milliseconds 100
}
