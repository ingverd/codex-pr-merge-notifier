$ErrorActionPreference = 'Stop'
$taskPrivateDir = Join-Path $PSScriptRoot 'private'
$taskNgrokConfig = Join-Path $taskPrivateDir 'ngrok.yml'
$taskNgrokExe = Join-Path $PSScriptRoot 'ngrok.exe'
if (-not (Test-Path -LiteralPath $taskNgrokExe)) { throw 'ngrok.exe is missing from this installation' }
if (-not (Test-Path -LiteralPath $taskPrivateDir)) { throw 'The protected private directory is missing' }

Write-Host 'Codex PR merge notifier merge notifications: connect ngrok'
Write-Host 'Get your authtoken at https://dashboard.ngrok.com/get-started/your-authtoken'
Write-Host 'Paste it into the hidden prompt below. Do not send it to the chat.'
$taskSecureToken = Read-Host 'ngrok authtoken (hidden)' -AsSecureString
if ($taskSecureToken.Length -eq 0) { throw 'No token was entered' }
$taskTokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureToken)
try {
  $taskPlainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskTokenPointer)
  & $taskNgrokExe config add-authtoken $taskPlainToken --config $taskNgrokConfig *> $null
  $taskTokenExit = $LASTEXITCODE
} finally {
  $taskPlainToken = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskTokenPointer)
  $taskSecureToken.Dispose()
}
if ($taskTokenExit -ne 0) { throw 'ngrok could not save the token; no credential details are displayed' }
Write-Host 'Token saved in the protected local configuration. Return to Codex and say: ready.'
