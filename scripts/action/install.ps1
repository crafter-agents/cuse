param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$RunnerOS,
  [Parameter(Mandatory = $true)][string]$RunnerArch,
  [Parameter(Mandatory = $true)][string]$InstallDir
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
  throw "unsupported release version: $Version"
}

$assets = Import-Csv (Join-Path $PSScriptRoot "assets.tsv") -Delimiter "`t" -Header OS, Arch, Asset
$match = $assets | Where-Object { $_.OS -eq $RunnerOS -and $_.Arch -eq $RunnerArch }
if ($null -eq $match) {
  throw "unsupported runner: $RunnerOS/$RunnerArch (set the executable-path input to skip installation and provide your own binary)"
}
$asset = $match.Asset

$baseUrl = if ($env:CUSE_RELEASE_BASE_URL) {
  $env:CUSE_RELEASE_BASE_URL.TrimEnd('/')
} else {
  "https://github.com/crafter-agents/cuse/releases/download/$Version"
}
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cuse-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
  $download = Join-Path $workDir $asset
  $sums = Join-Path $workDir "SHA256SUMS"
  $null = Invoke-WebRequest "$baseUrl/$asset" -OutFile $download
  $null = Invoke-WebRequest "$baseUrl/SHA256SUMS" -OutFile $sums

  $escapedAsset = [regex]::Escape($asset)
  $sumLine = Get-Content $sums | Where-Object { $_ -match "^([0-9A-Fa-f]{64})\s+\*?$escapedAsset$" } | Select-Object -First 1
  if ($null -eq $sumLine) {
    throw "SHA256SUMS has no valid entry for $asset"
  }
  $expected = ([regex]::Match($sumLine, '^[0-9A-Fa-f]{64}')).Value
  $actual = (Get-FileHash $download -Algorithm SHA256).Hash
  if ($actual -ne $expected) {
    throw "checksum mismatch for $asset"
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $destination = Join-Path $InstallDir "cuse.exe"
  Move-Item $download $destination -Force
  (Resolve-Path $destination).Path
} finally {
  Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
