$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$taskRoot = $PSScriptRoot
$taskPhase = 'preflight'
$taskSuccessful = $false
try {
  $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
  if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator permission is required' }
  if (Get-Service -Name ngrok -ErrorAction SilentlyContinue) { throw 'A service already exists; inspect native readback before repeating setup' }
  $taskNgrokExe = Join-Path $taskRoot 'ngrok.exe'
  $taskAuth = Join-Path $taskRoot 'private\ngrok.yml'
  $taskConfig = Join-Path $taskRoot 'ngrok-service.yml'
  $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskNgrokExe
  if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'ngrok, Inc\.') { throw 'The vendor binary signature is invalid' }
  & $taskNgrokExe config check --config $taskAuth --config $taskConfig *> $null
  if ($LASTEXITCODE -ne 0) { throw 'ngrok configuration is invalid' }
  if (Get-Process -Name ngrok -ErrorAction SilentlyContinue) { throw 'An ngrok process is already running; inspect it before setup' }

  # The service identity gets no read permission on the webhook secret.
  $taskPhase = 'service-file-access'
  $taskLocalService = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
  foreach ($taskEntry in @(
    @{Path=$taskRoot;Rights='ReadAndExecute'},
    @{Path=(Join-Path $taskRoot 'private');Rights='ReadAndExecute'},
    @{Path=$taskNgrokExe;Rights='ReadAndExecute'},
    @{Path=$taskConfig;Rights='Read'},
    @{Path=$taskAuth;Rights='Read'}
  )) {
    $taskAcl = Get-Acl -LiteralPath $taskEntry.Path
    $taskAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskLocalService,$taskEntry.Rights,'Allow'))
    Set-Acl -LiteralPath $taskEntry.Path -AclObject $taskAcl
  }
  $taskPhase = 'install-service'
  & $taskNgrokExe service install --config $taskAuth --config $taskConfig *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Service installation failed; inspect native state before repeating' }
  $taskPhase = 'configure-service'
  & sc.exe config ngrok 'obj=' 'NT AUTHORITY\LocalService' 'start=' 'auto' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Service account configuration failed' }
  & sc.exe failure ngrok 'reset=' '86400' 'actions=' 'restart/5000/restart/30000/restart/60000' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Native failure recovery configuration failed' }

  $taskPhase = 'start-service'
  Start-Service -Name ngrok
  (Get-Service -Name ngrok).WaitForStatus('Running', [TimeSpan]::FromSeconds(10))
  $taskService = Get-CimInstance Win32_Service -Filter "Name='ngrok'"
  if ($taskService.StartName -ne 'NT AUTHORITY\LocalService' -or $taskService.StartMode -ne 'Auto' -or $taskService.State -ne 'Running') { throw 'Native service readback did not match' }
  $taskSuccessful = $true
  $taskPhase = 'complete'
} catch {
  # Do not persist vendor stderr, credential data or raw exceptions.
} finally {
  [IO.File]::WriteAllText((Join-Path $taskRoot 'service-setup-result.json'),
    ([pscustomobject]@{success=$taskSuccessful;stage=$taskPhase} | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}
if (-not $taskSuccessful) { exit 1 }
