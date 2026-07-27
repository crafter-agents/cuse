# Open a console window with a title we choose, as a target for the input test.
# Notepad on Windows Server is the Store build and presents no window on the
# runner's session, so it cannot be the thing cuse types into.
Start-Process powershell -ArgumentList '-NoExit','-Command','$Host.UI.RawUI.WindowTitle = "CU_TARGET"; Write-Host "ready"'
Start-Sleep -Seconds 6
Get-Process | Where-Object { $_.MainWindowTitle } |
  Select-Object ProcessName, MainWindowTitle | Format-Table -AutoSize
