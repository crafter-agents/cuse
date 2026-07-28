# Evidence for why `notepad` starts nothing on Windows Server.
#
# `notepad.exe` on the PATH is an App Execution Alias: a zero-byte file with a
# reparse point (tag 0x8000001B) that names a Store package. On Server SKUs that
# package is not provisioned, so the alias resolves, a process is created, and no
# window ever appears - which is exactly the silent success cuse exists to catch.
$ErrorActionPreference = 'Continue'

Write-Host "### what `notepad` on the PATH actually is"
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\notepad.exe'
if (Test-Path $alias) {
  $f = Get-Item $alias
  Write-Host "  path:  $($f.FullName)"
  Write-Host "  bytes: $($f.Length)          # zero, because it is not a program"
  Write-Host "  attrs: $($f.Attributes)      # ReparsePoint"
  fsutil reparsepoint query $alias 2>&1 | Select-String -Pattern 'Reparse Tag Value|Microsoft.WindowsNotepad|notepad' |
    ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "  no alias at $alias"
}

Write-Host "### is the package it names actually installed"
$pkg = Get-AppxPackage *WindowsNotepad* 2>$null
Write-Host "  Get-AppxPackage *WindowsNotepad* -> $(if ($pkg) { $pkg.PackageFullName } else { 'nothing' })"

Write-Host "### and the classic binary, which is what the documented workaround uses"
$classic = Join-Path $env:SystemRoot 'System32\notepad.exe'
if (Test-Path $classic) {
  Write-Host "  $classic exists, $((Get-Item $classic).Length) bytes"
} else {
  Write-Host "  $classic is missing too"
}
