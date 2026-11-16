param(
  [string]$ReleaseDir = 'release',
  [string]$Publisher = $env:WINDOWS_SIGNING_PUBLISHER
)

$ErrorActionPreference = 'Stop'

function Assert-NabsunSignedFile {
  param([string]$FilePath, [string]$ExpectedPublisher)
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'Expected publisher is required' }
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Signed file missing: $FilePath" }
  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature ($($signature.Status)): $FilePath" }
  if ($null -eq $signature.SignerCertificate) { throw "Signing certificate missing: $FilePath" }
  $actual = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if (-not [string]::Equals($actual, $ExpectedPublisher, [System.StringComparison]::Ordinal)) {
    throw "Publisher mismatch: $FilePath"
  }
  if ($null -eq $signature.TimeStamperCertificate) { throw "Trusted timestamp missing: $FilePath" }
}

function Test-NabsunWindowsRelease {
  param([string]$Directory, [string]$ExpectedPublisher)
  $version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
  $packages = @("Nabsun-$version-x64-setup.exe", "Nabsun-$version-portable.exe")
  $application = Join-Path $Directory 'win-unpacked'
  # Assert the app exists before enumerating, so a missing directory cannot pass.
  Assert-NabsunSignedFile (Join-Path $application 'Nabsun.exe') $ExpectedPublisher
  foreach ($file in Get-ChildItem -LiteralPath $application -Recurse -File) {
    if ($file.Extension -in @('.exe', '.dll')) {
      Assert-NabsunSignedFile $file.FullName $ExpectedPublisher
    }
  }
  foreach ($name in $packages) {
    Assert-NabsunSignedFile (Join-Path $Directory $name) $ExpectedPublisher
  }
  # Checksums must describe the final signed bytes, never the unsigned inputs.
  $checksums = foreach ($name in $packages) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $Directory $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name"
  }
  $checksums | Set-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS.txt') -Encoding ascii
  Write-Host 'Verified Windows publisher, Authenticode signatures and timestamps; checksums generated.'
}

if ($MyInvocation.InvocationName -ne '.') {
  Test-NabsunWindowsRelease $ReleaseDir $Publisher
}
