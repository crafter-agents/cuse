param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Scenario,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$OutputFile
)

$ErrorActionPreference = "Stop"
$resultFile = Join-Path ([System.IO.Path]::GetTempPath()) ("cuse-result-{0}.json" -f [guid]::NewGuid())

try {
  Push-Location $WorkingDirectory
  try {
    & $Executable scenario $Scenario --json 1> $resultFile
    $scenarioExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  try {
    $resultText = [System.IO.File]::ReadAllText($resultFile)
    $result = $resultText | ConvertFrom-Json
  } catch {
    [Console]::Error.WriteLine("cuse execution adapter expected one structured scenario result")
    exit 4
  }

  $fallbackVerdicts = @{ 0 = "passed"; 1 = "failed"; 2 = "invalid"; 3 = "timed_out"; 4 = "refused" }
  $verdict = if ($result.action -eq "scenario") {
    if ($null -ne $result.data.status) { $result.data.status } else { $fallbackVerdicts[$scenarioExit] }
  } else { $null }
  if ($verdict -isnot [string] -or $verdict -notmatch '^[a-z][a-z_]*$') {
    [Console]::Error.WriteLine("cuse execution adapter expected one structured scenario result")
    exit 4
  }

  do {
    $delimiter = "cuse_result_{0}" -f [guid]::NewGuid().ToString("N")
  } while (($resultText -split "`r?`n") -contains $delimiter)

  [System.IO.File]::AppendAllText(
    $OutputFile,
    "verdict=$verdict`nresult-json<<$delimiter`n$resultText`n$delimiter`nexit-code=$scenarioExit`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  exit $scenarioExit
} finally {
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
}
