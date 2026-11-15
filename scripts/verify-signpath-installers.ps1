param(
  [string]$OriginalDir = 'release',
  [string]$SignedDir = 'release/signpath-signed',
  [string]$Publisher = $env:SIGNPATH_PUBLISHER
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/verify-windows-signatures.ps1" -Publisher $Publisher
$version = (Get-Content -LiteralPath "$PSScriptRoot/../package.json" -Raw | ConvertFrom-Json).version
foreach ($name in @("Nabsun-$version-x64-setup.exe", "Nabsun-$version-portable.exe")) {
  Assert-NabsunSignedFile (Join-Path $SignedDir $name) $Publisher
}
& node "$PSScriptRoot/signpath-payload.cjs" $OriginalDir $SignedDir
if ($LASTEXITCODE -ne 0) { throw 'Signed installer payload verification failed' }
Write-Host 'Verified installer envelopes only; embedded application signatures are outside this candidate scope.'
