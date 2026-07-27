# Why does a Windows job see no window on the desktop it can screenshot?
# Everything here is a question about the runner, not about cuse.
Write-Host "### who and where"
whoami
Write-Host "session id: $((Get-Process -Id $PID).SessionId)"

Write-Host "### sessions on this box"
query session 2>&1 | Out-String

Write-Host "### processes that own a window handle (not merely a title)"
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object Id, SessionId, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String

Write-Host "### start notepad and watch for a handle to appear"
$p = Start-Process notepad -PassThru
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  $p.Refresh()
  Write-Host "  t+$i handle=$($p.MainWindowHandle) session=$($p.SessionId) exited=$($p.HasExited)"
  if ($p.MainWindowHandle -ne 0) { break }
}

Write-Host "### can AppActivate reach it by pid rather than by title"
try {
  $s = New-Object -ComObject WScript.Shell
  Write-Host "AppActivate(pid) -> $($s.AppActivate($p.Id))"
} catch { Write-Host "AppActivate threw: $_" }

Add-Type -AssemblyName System.Windows.Forms
Write-Host "virtual screen: $([System.Windows.Forms.SystemInformation]::VirtualScreen)"

Write-Host "### is this session attached to an interactive desktop"
$sig = @'
using System; using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
Add-Type $sig
Write-Host "foreground window: $([D]::GetForegroundWindow())"
Write-Host "input desktop:     $([D]::OpenInputDesktop(0, $false, 0x0100))"
Write-Host "thread desktop:    $([D]::GetThreadDesktop([D]::GetCurrentThreadId()))"

try { $p.Kill() } catch {}
