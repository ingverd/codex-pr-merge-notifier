$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskCodexHome=$env:CODEX_HOME
if(-not $taskCodexHome){$taskCodexHome=Join-Path $env:USERPROFILE '.codex'}
$taskSkillRoot=Join-Path $taskCodexHome 'skills\merge-notifier'
if(Test-Path -LiteralPath $taskSkillRoot){throw 'A merge-notifier skill already exists; inspect it before replacing'}
if(-not (Test-Path -LiteralPath (Join-Path $taskRoot 'notifier.json'))){throw 'Configure the installation first'}
$taskHooksPath=Join-Path $taskCodexHome 'hooks.json'
$taskCommand='powershell.exe -NoProfile -NonInteractive -File "' + (Join-Path $taskRoot 'start-notifier.ps1') + '" -Hook'
$taskGroup=[pscustomobject]@{matcher='^(startup|resume)$';hooks=@([pscustomobject]@{type='command';command=$taskCommand;commandWindows=$taskCommand;timeout=40;statusMessage='Connecting PR merge notifications';additionalContextLimit=200})}
if(Test-Path -LiteralPath $taskHooksPath) {
  $taskHooks=Get-Content -Raw -LiteralPath $taskHooksPath | ConvertFrom-Json
} else { $taskHooks=[pscustomobject]@{hooks=[pscustomobject]@{}} }
if(-not $taskHooks.hooks){throw 'Existing hook configuration has an unexpected shape'}
$taskExisting=@($taskHooks.hooks.SessionStart)
if($taskExisting.Count -eq 1 -and $null -eq $taskExisting[0]){$taskExisting=@()}
foreach($taskEntry in $taskExisting){foreach($taskHandler in $taskEntry.hooks){if($taskHandler.command -eq $taskCommand){throw 'This hook already exists; inspect the current installation'}}}
$taskHooks.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue @($taskExisting + $taskGroup) -Force
if(-not (Test-Path -LiteralPath $taskCodexHome)){New-Item -ItemType Directory -Path $taskCodexHome | Out-Null}
[IO.File]::WriteAllText($taskHooksPath,($taskHooks|ConvertTo-Json -Depth 100),[Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Path $taskSkillRoot | Out-Null
$taskSkill=@"
---
name: merge-notifier
description: Check or reconnect the GitHub PR merge notification bridge in a local Codex desktop chat.
---

Use `` `$merge-notifier reconnect `` to run ``start-notifier.ps1 -Reconnect`` in ``$taskRoot`` with the current desktop environment. Use `` `$merge-notifier status `` to inspect the ngrok service and configured localhost port, then run ``merge-notifier.mjs check`` with the bundled Node runtime.

Never display private/ngrok.yml or private/webhook.secret. Never override process ownership guards. Inspect an uncertain startup or send before retrying. Reconnect does not change PR attachments, recipients, GitHub webhook settings or credentials. Read README.md in the installation when diagnosing a failure.
"@
[IO.File]::WriteAllText((Join-Path $taskSkillRoot 'SKILL.md'),$taskSkill,[Text.UTF8Encoding]::new($false))
Write-Output 'Hook and skill installed. Review/trust the hook in Codex when required.'
