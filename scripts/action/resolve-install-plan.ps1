param(
  [Parameter(Mandatory = $true)][string]$RunnerOS,
  [Parameter(Mandatory = $true)][string]$RunnerArch
)

$ErrorActionPreference = "Stop"

$asset = Get-Content (Join-Path $PSScriptRoot "assets.tsv") |
  ForEach-Object {
    $fields = $_ -split "`t", 3
    if ($fields.Count -eq 3 -and $fields[0] -eq $RunnerOS -and $fields[1] -eq $RunnerArch) {
      $fields[2]
    }
  } |
  Select-Object -First 1

if ($null -ne $asset) {
  $plan = [ordered]@{
    "schemaVersion" = 1
    "supported" = $true
    "runner" = [ordered]@{ "os" = $RunnerOS; "arch" = $RunnerArch }
    "strategy" = "native"
    "requestedArch" = $RunnerArch
    "resolvedArch" = $RunnerArch
    "asset" = $asset
    "executablePath" = $null
    "remediation" = $null
  }
} else {
  $plan = [ordered]@{
    "schemaVersion" = 1
    "supported" = $false
    "runner" = [ordered]@{ "os" = $RunnerOS; "arch" = $RunnerArch }
    "strategy" = "unsupported"
    "requestedArch" = $RunnerArch
    "resolvedArch" = $null
    "asset" = $null
    "executablePath" = $null
    "remediation" = [ordered]@{
      "kind" = "executable-path"
      "message" = "Provide a compatible cuse executable with the executable-path input."
    }
  }
}

$plan | ConvertTo-Json -Depth 3 -Compress
