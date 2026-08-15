param(
  [Parameter(Mandatory = $true)][string]$DisplayMode,
  [Parameter(Mandatory = $true)][string]$Accessibility
)

$ErrorActionPreference = "Stop"
if ($DisplayMode -notin @("automatic", "always", "never")) {
  throw "invalid linux-display '$DisplayMode': expected automatic, always, or never"
}
if ($Accessibility -notin @("true", "false")) {
  throw "invalid linux-accessibility '$Accessibility': expected true or false"
}

Write-Output "::notice::cuse platform preparation: Windows uses its current interactive session; no display service was changed"
