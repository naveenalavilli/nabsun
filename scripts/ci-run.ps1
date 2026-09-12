# Preserve streamed output and the native exit code for each CI step.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('typecheck', 'build', 'verify:cli', 'verify:browse', 'verify:page',
    'verify:agent', 'verify:mcp', 'verify:local', 'fetch:model', 'check:payload', 'dist:win', 'dist:win:ci')]
  [string]$Script,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArguments
)

$ErrorActionPreference = 'Stop'
# npm writes progress and expected negative-test diagnostics to stderr.
# PowerShell 7 must use its exit code, not treat those lines as exceptions.
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Force -Path ci-logs | Out-Null
$logPath = Join-Path ci-logs ($Script.Replace(':', '-') + '.log')
& npm.cmd run $Script -- @ScriptArguments 2>&1 | Tee-Object -FilePath $logPath
$result = $LASTEXITCODE
if ($null -eq $result) { throw 'npm did not return an exit code' }
exit $result
