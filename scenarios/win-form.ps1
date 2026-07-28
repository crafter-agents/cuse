# A window cuse can aim at, which records what it receives.
#
# Notepad cannot be the target on a Windows Server runner: it is the Store build
# and Start-Process returns nothing at all. Recon showed the job does sit in the
# interactive session (session 2, real foreground window), so a window created
# here is a legitimate target - and a TextBox that writes every change to disk
# gives the same ground truth the macOS and Linux checks have.
param([Parameter(Mandatory = $true)][string]$Sink)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'CU_TARGET'
$form.Width = 700
$form.Height = 300
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Consolas', 18)
$box.Add_TextChanged({ Set-Content -Path $Sink -Value $box.Text -NoNewline })
$box.Dock = 'Top'
$box.Height = 180
$form.Controls.Add($box)

# A real button with a real name, so a selector has something to select. It
# records the press the same way the text box records typing: on disk.
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.Name = 'Save'
$save.Dock = 'Bottom'
$save.Height = 60
$save.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$save.Add_Click({ Add-Content -Path "$Sink.button" -Value 'SAVE_CLICKED' })
$form.Controls.Add($save)

$form.Add_Shown({
  $form.Activate()
  $box.Focus() | Out-Null
  Set-Content -Path "$Sink.ready" -Value 'shown' -NoNewline
})

[System.Windows.Forms.Application]::Run($form)
