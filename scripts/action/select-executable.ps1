param(
  [AllowEmptyString()][string]$Override,
  [AllowEmptyString()][string]$Installed,
  [Parameter(Mandatory = $true)][string]$Workspace
)

$ErrorActionPreference = "Stop"
$candidate = $Installed
$source = "downloaded"

if (-not [string]::IsNullOrWhiteSpace($Override)) {
  $candidate = $Override
  $source = "override"
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path $Workspace $candidate
  }
}

if ([string]::IsNullOrWhiteSpace($candidate)) {
  throw "no cuse executable was selected"
}
if (-not (Test-Path -LiteralPath $candidate)) {
  throw "cuse executable $source does not exist: $candidate"
}
$item = Get-Item -LiteralPath $candidate
if ($item.PSIsContainer) {
  throw "cuse executable $source is not a file: $candidate"
}
if ($item.Extension -notin @(".exe", ".com", ".cmd", ".bat")) {
  throw "cuse executable $source is not executable: $candidate"
}

$item.FullName
