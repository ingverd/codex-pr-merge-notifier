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
description: Check or reconnect the GitHub PR merge notification bridge in a local Codex desktop chat, including readiness before handing an attached PR to its owner for merge.
---

Invoke as `` `$merge-notifier reconnect `` or `` `$merge-notifier status <PR URL> ``. Before handing an attached PR to its owner for merge, run status for that exact PR.

For reconnect, run ``start-notifier.ps1 -Reconnect`` in ``$taskRoot`` from the current local Codex desktop environment. Preserve process ownership and environment guards. Inspect uncertain startup before retrying. Reconnect does not change attachments, recipients, webhook settings or credentials.

For status, inspect the native ngrok service and localhost listeners for the configured receiver and ngrok API, then run ``merge-notifier.mjs status <PR URL>`` with the bundled Node runtime in ``$taskRoot``. Infer the URL only from a single unambiguous native PR attachment; otherwise ask for the exact PR. The signed read-only request reads repository/port from ignored notifier.json and uses private/webhook.secret opaquely on the existing /github/merge endpoint. It checks the actual receiver's existing desktop connection, exact live route and session capacity, sends no message and fails closed on unverified readiness. Report checkedAt (UTC) and recipients.length from the local_receiver_and_route snapshot, which also identifies receiverPid and routeContextThreadId. Use check only for launcher preflight: its new client does not prove receiver readiness. Diagnose failed status, use guarded reconnect when applicable, then rerun status.

Status does not prove public ingress or guarantee a delayed merge. Merge resolves recipients afresh; there are no timers, queue, persistent delivery ledger or automatic retries. Never replay a merge event. All eligible accessible local non-archived same-account chats with native PR attachments receive notifications. Recipients keep their existing roles: executors perform applicable post-merge work, coordinators get executor status without duplicating checks. No role registry is added.

Per-recipient outcomes, including uncertain sends, are appended to diagnostic logs with delivery ID, canonical PR number/URL, merge SHA, receiver context and recipients. Never display credentials, tokens, signatures, webhook bodies, message contents or account IDs. Never display private/ngrok.yml or private/webhook.secret. Read README.md in the installation when diagnosing a failure.
"@
[IO.File]::WriteAllText((Join-Path $taskSkillRoot 'SKILL.md'),$taskSkill,[Text.UTF8Encoding]::new($false))
Write-Output 'Hook and skill installed. Review/trust the hook in Codex when required.'
