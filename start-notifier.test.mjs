import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url));
function run(caseName) {
  const root = mkdtempSync(join(tmpdir(), 'codex-pr-merge-start-test-'));
  try {
    copyFileSync(join(source, 'start-notifier.ps1'), join(root, 'start-notifier.ps1'));
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'notifier.json'), JSON.stringify({repository:'octocat/example',port:8028}));
    writeFileSync(join(root, 'private', 'webhook.secret'), 'fixture only');
    writeFileSync(join(root, 'private', 'ngrok.yml'), 'fixture only');
    writeFileSync(join(root, 'merge-notifier.mjs'), '');
    writeFileSync(join(root, 'node-fixture.ps1'), `Write-Output '{"connected":true}'`);
    const harness = `
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$env:CODEX_THREAD_ID = '11111111-1111-4111-8111-111111111111'
$env:CODEX_APP_TOOLS_PIPE_PATH = 'fixture-pipe'
$env:CODEX_MCP_NODE_PATH = Join-Path $taskRoot 'node-fixture.ps1'
$global:stops = @(); $global:starts = 0; $global:hasListener = $true; $global:listenerPid=77
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = ([BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:CODEX_APP_TOOLS_PIPE_PATH)))).Replace('-','').ToLowerInvariant() } finally { $taskHasher.Dispose() }
$global:commandLine = '"' + $env:CODEX_MCP_NODE_PATH + '" "' + (Join-Path $taskRoot 'merge-notifier.mjs') + '" serve "' + (Join-Path $taskRoot 'private\\webhook.secret') + '" ' + $taskHash
if ('${caseName}' -eq 'stale') { $global:commandLine = $global:commandLine.Replace($taskHash, ('a' * 64)) }
if ('${caseName}' -eq 'foreign') { $global:commandLine = 'an unrelated application' }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) if ($global:hasListener) { [pscustomobject]@{OwningProcess=$global:listenerPid;LocalAddress='127.0.0.1';LocalPort=8028} } }
function Get-CimInstance { param($ClassName, $Filter) [pscustomobject]@{ProcessId=77;ParentProcessId=0;ExecutablePath=$env:CODEX_MCP_NODE_PATH;CommandLine=$global:commandLine} }
function Get-Service { param($Name, $ErrorAction) [pscustomobject]@{Status='Running'} }
function Get-Process { param($Name, $Id, $ErrorAction) [pscustomobject]@{Id=77;HasExited=$false} }
function Stop-Process { param($Id, $ErrorAction) $global:stops += $Id; $global:hasListener=$false }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru) $global:starts++; $global:hasListener=$true; $global:listenerPid=88; [pscustomobject]@{Id=88;HasExited=$false} }
$taskFailure=$null; $taskOutput=$null
try { if ('${caseName}' -eq 'reconnect') { $taskOutput = & (Join-Path $taskRoot 'start-notifier.ps1') -Reconnect } else { $taskOutput = & (Join-Path $taskRoot 'start-notifier.ps1') } } catch { $taskFailure=$_.Exception.Message }
[pscustomobject]@{stops=@($global:stops);starts=$global:starts;failure=$taskFailure;output=$taskOutput} | ConvertTo-Json -Depth 4 -Compress
`;
    writeFileSync(join(root, 'harness.ps1'), harness);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'harness.ps1')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('startup reuses a notifier connected to the current app without restarting it', () => {
  const result = run('current');
  assert.equal(result.failure, null);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
  assert.equal(JSON.parse(result.output).code, 'already_connected');
});

test('an unrelated listener is never stopped or replaced', () => {
  const result = run('foreign');
  assert.match(result.failure, /unrelated|owned/i);
  assert.equal(result.starts, 0);
  assert.deepEqual(result.stops, []);
});

test('startup replaces only an owned notifier from a previous app connection', () => {
  const result = run('stale');
  assert.equal(result.failure, null);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.stops, [77]);
  assert.equal(JSON.parse(result.output).code, 'connected');
});

test('explicit reconnect replaces the owned receiver once even in the current app', () => {
  const result = run('reconnect');
  assert.equal(result.failure, null);
  assert.equal(result.starts, 1);
  assert.deepEqual(result.stops, [77]);
});
