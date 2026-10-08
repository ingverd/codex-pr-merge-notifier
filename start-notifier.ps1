param([switch]$Reconnect, [switch]$Hook)
$ErrorActionPreference = 'Stop'
$taskMutex = $null
$taskLockHeld = $false
try {
  if ($Hook) {
    $taskInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($taskInput.hook_event_name -ne 'SessionStart' -or $taskInput.source -notin @('startup','resume') -or
        $taskInput.session_id -notmatch '^[a-f0-9-]{36}$') { throw 'Unexpected hook input' }
    $env:CODEX_THREAD_ID = $taskInput.session_id
  }
  if (-not $env:CODEX_THREAD_ID -or -not $env:CODEX_APP_TOOLS_PIPE_PATH -or -not $env:CODEX_MCP_NODE_PATH) {
    throw 'A current local Codex desktop connection is required'
  }
  $taskRoot = $PSScriptRoot
  $taskConfig = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'notifier.json') | ConvertFrom-Json
  if ($taskConfig.repository -notmatch '^[a-z0-9-]+/[a-z0-9_.-]+$') { throw 'An exact repository must be configured' }
  $taskPort = 0
  if (-not [int]::TryParse([string]$taskConfig.port,[ref]$taskPort) -or $taskPort -lt 1024 -or $taskPort -gt 65535) { throw 'Invalid configured port' }
  $env:MERGE_NOTIFIER_REPOSITORY = $taskConfig.repository
  $env:MERGE_NOTIFIER_PORT = [string]$taskPort
  $taskScript = Join-Path $taskRoot 'merge-notifier.mjs'
  $taskSecret = Join-Path $taskRoot 'private\webhook.secret'
  if (-not (Test-Path -LiteralPath $taskSecret)) { throw 'The configured webhook secret file is missing' }
  $taskService = Get-Service -Name ngrok -ErrorAction SilentlyContinue
  if (-not $taskService -or $taskService.Status -ne 'Running') { throw 'The ngrok Windows service is not running' }

  # Native mutex prevents concurrent startup hooks from launching duplicate receivers.
  $taskMutex = [Threading.Mutex]::new($false, 'Local\CodexPrMergeNotifierStart')
  try { $taskLockHeld = $taskMutex.WaitOne(8000) } catch [Threading.AbandonedMutexException] { $taskLockHeld = $true }
  if (-not $taskLockHeld) { throw 'Another notifier startup is still in progress' }
  $taskPreviousNoWarnings = $env:NODE_NO_WARNINGS
  try {
    $env:NODE_NO_WARNINGS = '1'
    $taskCheck = & $env:CODEX_MCP_NODE_PATH $taskScript check 2>$null | ConvertFrom-Json
  } finally { $env:NODE_NO_WARNINGS = $taskPreviousNoWarnings }
  if (-not $taskCheck.connected) { throw 'The current Codex desktop connection is unavailable' }
  $taskHasher = [Security.Cryptography.SHA256]::Create()
  try { $taskConnection = ([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:CODEX_APP_TOOLS_PIPE_PATH)))).Replace('-','').ToLowerInvariant() } finally { $taskHasher.Dispose() }

  $taskListeners = @(Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue)
  if ($taskListeners.Count) {
    if ($taskListeners.Count -ne 1 -or $taskListeners[0].LocalAddress -ne '127.0.0.1') { throw 'Port 8028 has an unrelated listener' }
    $taskOld = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskListeners[0].OwningProcess)
    $taskRuntimeRoot = Join-Path $env:USERPROFILE 'AppData\Local\OpenAI\Codex\runtimes\'
    $taskOwnedNode = $taskOld.ExecutablePath -eq $env:CODEX_MCP_NODE_PATH -or
      ($taskOld.ExecutablePath -and $taskOld.ExecutablePath.StartsWith($taskRuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($taskOld.ExecutablePath) -eq 'node.exe')
    $taskExePattern = [Regex]::Escape([string]$taskOld.ExecutablePath)
    $taskScriptPattern = [Regex]::Escape($taskScript)
    $taskSecretPattern = [Regex]::Escape($taskSecret)
    $taskOwnedPattern = '^(?:"' + $taskExePattern + '"|' + $taskExePattern + ')\s+(?:"' + $taskScriptPattern + '"|' + $taskScriptPattern + ')\s+serve\s+(?:"' + $taskSecretPattern + '"|' + $taskSecretPattern + ')(?:\s+([a-f0-9]{64}))?\s*$'
    if (-not $taskOwnedNode -or $taskOld.CommandLine -notmatch $taskOwnedPattern) { throw 'Port 8028 is not owned by this notifier' }
    $taskOldConnection = $Matches[1]
    if (-not $Reconnect -and $taskOldConnection -eq $taskConnection) {
      if (-not $Hook) { [pscustomobject]@{code='already_connected';receiverPid=$taskOld.ProcessId} | ConvertTo-Json -Compress }
      return
    }
    $taskReadback = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskOld.ProcessId)
    if ($taskReadback.CommandLine -ne $taskOld.CommandLine -or $taskReadback.ExecutablePath -ne $taskOld.ExecutablePath) { throw 'The owned notifier process changed during preflight' }
    foreach ($taskChild in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $taskOld.ProcessId))) {
      if ($taskChild.ParentProcessId -eq $taskOld.ProcessId -and $taskChild.ExecutablePath -eq $taskOld.ExecutablePath -and
          $taskChild.CommandLine -match '\\codex-app-tools\\server\.mjs"?\s*$') { Stop-Process -Id $taskChild.ProcessId -ErrorAction Stop }
    }
    Stop-Process -Id $taskOld.ProcessId -ErrorAction Stop
  }
  # Keep Windows shell launch detached; the receiver writes its own logs.
  $taskReceiver = Start-Process -FilePath $env:CODEX_MCP_NODE_PATH -ArgumentList @(
    ('"' + $taskScript + '"'), 'serve', ('"' + $taskSecret + '"'), $taskConnection
  ) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
  $taskDeadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    $taskReady = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $taskReceiver.Id }
    if ($taskReady) { break }
    if ($taskReceiver.HasExited) { throw 'The notifier could not start; inspect its sanitized diagnostics' }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $taskDeadline)
  if (-not $taskReady) { throw 'Notifier startup is uncertain; inspect the listener before repeating' }
  if (-not $Hook) { [pscustomobject]@{code='connected';receiverPid=$taskReceiver.Id} | ConvertTo-Json -Compress }
} catch {
  if ($Hook) {
    [pscustomobject]@{systemMessage='Codex PR merge notifier merge notifications could not connect. Use $merge-notifier reconnect in a local Codex chat to diagnose and reconnect.'} | ConvertTo-Json -Compress
  } else { throw }
} finally {
  if ($taskLockHeld) { $taskMutex.ReleaseMutex() }
  if ($taskMutex) { $taskMutex.Dispose() }
}
