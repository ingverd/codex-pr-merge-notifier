param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+$')][string]$Repository,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9.-]+$')][string]$NgrokDomain,
  [ValidateRange(1024,65535)][int]$Port=8028
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$taskRoot=$PSScriptRoot
$taskPrivate=Join-Path $taskRoot 'private'
if (Test-Path -LiteralPath $taskPrivate) { throw 'Private settings already exist; do not overwrite credentials' }
foreach($taskFile in @('notifier.json','ngrok-service.yml')) {
  if(Test-Path -LiteralPath (Join-Path $taskRoot $taskFile)){throw 'Local settings already exist; inspect them before setup'}
}
New-Item -ItemType Directory -Path $taskPrivate | Out-Null
$taskOwner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAcl=Get-Acl -LiteralPath $taskPrivate
$taskAcl.SetAccessRuleProtection($true,$false)
$taskAcl.SetOwner($taskOwner)
foreach($taskSid in @($taskOwner.Value,'S-1-5-18','S-1-5-32-544')) {
  $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($taskSid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $taskPrivate -AclObject $taskAcl
$taskRandom=[Security.Cryptography.RandomNumberGenerator]::Create()
$taskBytes=New-Object byte[] 32
try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
$taskSecret=([BitConverter]::ToString($taskBytes)).Replace('-','').ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $taskPrivate 'webhook.secret'),$taskSecret,[Text.UTF8Encoding]::new($false))
[Array]::Clear($taskBytes,0,$taskBytes.Length)
$taskSecret=$null
[IO.File]::WriteAllText((Join-Path $taskRoot 'notifier.json'),([pscustomobject]@{repository=$Repository;port=$Port}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$taskNgrok=@"
version: 3
agent:
  console_ui: false
  inspect_db_size: -1
  log: 'false'
  web_addr: 127.0.0.1:4040
endpoints:
  - name: codex-pr-merge-notifier
    url: https://$NgrokDomain
    upstream:
      url: http://127.0.0.1:$Port
"@
[IO.File]::WriteAllText((Join-Path $taskRoot 'ngrok-service.yml'),$taskNgrok,[Text.UTF8Encoding]::new($false))
Write-Output 'Local settings initialized. Credentials are never printed.'
