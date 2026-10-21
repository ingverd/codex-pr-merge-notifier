import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

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

test('a startup hook releases captured output while its real receiver stays alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-pr-merge-hook-test-'));
  let hook;
  let receiverPid;
  let closed;
  let timer;
  try {
    copyFileSync(join(source, 'start-notifier.ps1'), join(root, 'start-notifier.ps1'));
    copyFileSync(join(source, 'merge-notifier.mjs'), join(root, 'merge-notifier.mjs'));
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private', 'webhook.secret'), 'fixture-only-secret-value-'.repeat(3));
    writeFileSync(join(root, 'desktop-client.mjs'), `
export async function openDesktopClient() {
  if (process.argv[2] === 'serve') console.error('fixture diagnostic');
  return { close() {}, async call() { return {}; } };
}
`);
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    writeFileSync(join(root, 'notifier.json'), JSON.stringify({repository:'octocat/example',port}));
    const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
    writeFileSync(join(root, 'harness.ps1'), `
$ErrorActionPreference = 'Stop'
$env:CODEX_APP_TOOLS_PIPE_PATH = 'fixture-pipe'
$env:CODEX_MCP_NODE_PATH = ${psQuote(process.execPath)}
function Get-Service { param($Name, $ErrorAction) [pscustomobject]@{Status='Running'} }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  $taskPidFile = Join-Path $PSScriptRoot 'receiver.pid'
  $taskLogFile = Join-Path $PSScriptRoot 'receiver.stdout.log'
  if ((Test-Path -LiteralPath $taskPidFile) -and (Test-Path -LiteralPath $taskLogFile) -and
      (Get-Content -LiteralPath $taskLogFile -Raw) -match 'listening') {
    [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=[int]$LocalPort;OwningProcess=[int](Get-Content -LiteralPath $taskPidFile)}
  }
}
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
  $taskProcess = Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'receiver.pid'), [string]$taskProcess.Id)
  $taskProcess
}
& (Join-Path $PSScriptRoot 'start-notifier.ps1') -Hook
`);
    hook = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'harness.ps1')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    hook.stdout.on('data', data => { stdout += data; });
    hook.stderr.on('data', data => { stderr += data; });
    closed = new Promise(resolve => hook.once('close', code => resolve(code)));
    hook.stdin.end(JSON.stringify({hook_event_name:'SessionStart',source:'startup',session_id:'11111111-1111-4111-8111-111111111111'}));
    const result = await Promise.race([
      closed.then(code => ({code})),
      new Promise(resolve => { timer = setTimeout(() => resolve({timedOut:true}), 10000); })
    ]);
    clearTimeout(timer);
    receiverPid = Number(readFileSync(join(root, 'receiver.pid'), 'utf8'));
    assert.equal(result.timedOut, undefined, 'hook output remained open after its PowerShell launcher exited');
    assert.equal(result.code, 0, stderr);
    assert.equal(stdout.trim(), '', 'a successful startup hook must stay quiet\n' +
      readFileSync(join(root, 'receiver.stdout.log'), 'utf8') + '\n' +
      readFileSync(join(root, 'receiver.stderr.log'), 'utf8'));
    assert.doesNotThrow(() => process.kill(receiverPid, 0), 'receiver must outlive its startup hook');
    assert.match(readFileSync(join(root, 'receiver.stdout.log'), 'utf8'), /listening/);
    assert.match(readFileSync(join(root, 'receiver.stderr.log'), 'utf8'), /fixture diagnostic/);
    const response = await fetch(`http://127.0.0.1:${port}/github/merge`, {method:'POST',body:'{}',signal:AbortSignal.timeout(5000)});
    assert.equal(response.status, 401, 'receiver remains available and rejects an unsigned event');
  } finally {
    clearTimeout(timer);
    if (!receiverPid) {
      try { receiverPid = Number(readFileSync(join(root, 'receiver.pid'), 'utf8')); } catch {}
    }
    if (receiverPid) { try { process.kill(receiverPid); } catch {} }
    if (hook?.exitCode === null) hook.kill();
    if (closed) await closed;
    assert.equal(dirname(root), tmpdir(), 'cleanup stays inside the test temporary directory');
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('real receiver routes a signed merge to both eligible native attachments, logs it and rejects replay', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createHmac } = await import('node:crypto');
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'codex-pr-merge-chain-test-'));
  let receiver;
  let closed;
  try {
    for (const file of ['merge-notifier.mjs', 'desktop-client.mjs']) copyFileSync(join(source, file), join(root, file));
    const secret = 'isolated-fixture-secret-never-used-by-real-bridge';
    mkdirSync(join(root, 'private'));
    const secretPath = join(root, 'private', 'webhook.secret');
    writeFileSync(secretPath, secret);
    const stdoutPath = join(root, 'receiver.stdout.log');
    const stderrPath = join(root, 'receiver.stderr.log');
    writeFileSync(stdoutPath, 'previous stdout marker\n');
    writeFileSync(stderrPath, 'previous stderr marker\n');
    const caller = 'fixture-caller';
    const recipients = ['fixture-executor', 'fixture-coordinator'];
    const dbPath = join(root, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, creator_account_id TEXT, creator_user_id TEXT, archived INTEGER); CREATE TABLE thread_attachments(thread_id TEXT, attachment_type TEXT, identity_key TEXT, payload TEXT)');
    const putThread = db.prepare('INSERT INTO threads VALUES(?,?,?,?)');
    for (const id of [caller, ...recipients]) putThread.run(id, 'fixture-account', 'fixture-user', 0);
    putThread.run('fixture-foreign', 'another-account', 'another-user', 0);
    putThread.run('fixture-archived', 'fixture-account', 'fixture-user', 1);
    const prUrl = 'https://github.com/octocat/example/pull/164';
    const identity = JSON.stringify(['github.com', 'octocat', 'example', 164]);
    const putAttachment = db.prepare('INSERT INTO thread_attachments VALUES(?,?,?,?)');
    for (const id of [...recipients, 'fixture-foreign', 'fixture-archived']) {
      putAttachment.run(id, 'pull_request', identity, JSON.stringify({url:'https://github.com/Octocat/Example/pull/164'}));
    }
    db.close();
    const resources = join(root, 'resources');
    const pluginRoot = join(resources, 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools');
    mkdirSync(pluginRoot, {recursive:true});
    const callsPath = join(root, 'fake-native-calls.jsonl');
    writeFileSync(callsPath, '');
    writeFileSync(join(pluginRoot, 'server.mjs'), `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result = {};
  if (request.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};
  if (request.method === 'tools/list') result = {tools:[]};
  if (request.method === 'tools/call') {
    const {name,arguments:args,_meta} = request.params;
    appendFileSync(process.env.FIXTURE_NATIVE_CALLS, JSON.stringify({name,args,context:_meta['openai/threadId']})+'\\n');
    if (_meta['openai/threadId'] !== 'fixture-caller') throw new Error('wrong caller');
    if (name !== 'list_artifacts' && !['fixture-executor','fixture-coordinator'].includes(args.threadId)) throw new Error('excluded chat reached native transport');
    result = {content:[{type:'text',text:JSON.stringify({ok:true})}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`);
    const reservation = (await import('node:net')).createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    writeFileSync(join(root,'notifier.json'),JSON.stringify({repository:'octocat/example',port}));
    receiver = spawn(process.execPath, [join(root, 'merge-notifier.mjs'), 'serve', secretPath], {
      windowsHide:true, stdio:['ignore','pipe','pipe'],
      env:{...process.env,CODEX_THREAD_ID:caller,CODEX_MCP_NODE_PATH:process.execPath,
        CODEX_ELECTRON_RESOURCES_PATH:resources,CODEX_APP_TOOLS_PIPE_PATH:'fixture-only-pipe',
        MERGE_NOTIFIER_CODEX_STATE_DB:dbPath,MERGE_NOTIFIER_PORT:String(port),
        MERGE_NOTIFIER_REPOSITORY:'Octocat/Example',FIXTURE_NATIVE_CALLS:callsPath}
    });
    let diagnostics = '';
    receiver.stderr.on('data', data => { diagnostics += data; });
    receiver.stdout.resume();
    closed = new Promise(resolve => receiver.once('close', resolve));
    const endpoint = `http://127.0.0.1:${port}/github/merge`;
    let ready = false;
    for (let attempt=0; attempt<100; attempt++) {
      if (receiver.exitCode !== null) assert.fail('receiver exited: '+diagnostics);
      try { await fetch(endpoint); ready=true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, 'isolated receiver starts');
    const readCalls = () => readFileSync(callsPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const checkerEnv = {...process.env,CODEX_THREAD_ID:'different-checker',MERGE_NOTIFIER_PORT:String(port)};
    delete checkerEnv.CODEX_APP_TOOLS_PIPE_PATH;
    delete checkerEnv.CODEX_ELECTRON_RESOURCES_PATH;
    delete checkerEnv.CODEX_TECTONIC_PATH;
    const statusCli = spawn(process.execPath,[join(root,'merge-notifier.mjs'),'status',prUrl],{
      windowsHide:true,env:checkerEnv,stdio:['ignore','pipe','pipe']
    });
    let statusOutput='', statusError='';
    statusCli.stdout.on('data',data=>{statusOutput+=data;});
    statusCli.stderr.on('data',data=>{statusError+=data;});
    const statusExit = await new Promise(resolve=>statusCli.once('close',resolve));
    assert.equal(statusExit,0,statusError);
    const status = JSON.parse(statusOutput);
    assert.equal(status.code,'local_ready');
    assert.equal(status.ready,true);
    assert.equal(status.scope,'local_receiver_and_route');
    assert.equal(status.prUrl,prUrl);
    assert.equal(status.routeContextThreadId,caller,'diagnostic must use the running receiver context');
    assert.equal(status.receiverPid,receiver.pid);
    assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
    assert.deepEqual(status.recipients.map(item=>item.threadId).sort(),recipients.slice().sort());
    const diagnosticCalls = readCalls();
    assert.ok(diagnosticCalls.some(call=>call.name==='list_artifacts'),'readiness checks the existing desktop transport');
    assert.deepEqual(diagnosticCalls.filter(call=>call.name==='read_thread').map(call=>call.args.threadId).sort(),recipients.slice().sort());
    assert.ok(diagnosticCalls.every(call=>call.context===caller));
    assert.equal(diagnosticCalls.filter(call=>call.name==='send_message_to_thread').length,0,'status never sends messages');
    const unsignedStatus = await fetch(endpoint,{method:'POST',headers:{'x-github-event':'merge_notifier_status'},body:JSON.stringify({prUrl})});
    assert.equal(unsignedStatus.status,401);
    assert.equal(readCalls().filter(call=>call.name==='send_message_to_thread').length,0);
    const mergeSha = 'a'.repeat(40);
    const payload = {action:'closed',number:164,repository:{full_name:'Octocat/Example'},
      pull_request:{number:164,merged:true,html_url:'https://github.com/Octocat/Example/pull/164',
        merge_commit_sha:mergeSha,merged_at:'2025-01-01T00:00:00Z'}};
    const body = JSON.stringify(payload);
    const deliveryId = '00000000-0000-4000-8000-000000000164';
    const headers = {'x-github-event':'pull_request','x-github-delivery':deliveryId,
      'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')};
    const first = await fetch(endpoint,{method:'POST',headers,body});
    assert.equal(first.status,200,JSON.stringify(await first.clone().json()));
    assert.equal((await first.json()).code,'delivered');
    const repeat = await fetch(endpoint,{method:'POST',headers,body});
    assert.equal(repeat.status,202);
    assert.equal((await repeat.json()).code,'duplicate_delivery');
    const unsigned = await fetch(endpoint,{method:'POST',body});
    assert.equal(unsigned.status,401);
    const calls = readFileSync(callsPath,'utf8').trim().split('\n').map(JSON.parse);
    const sends = calls.filter(call=>call.name==='send_message_to_thread');
    assert.deepEqual(sends.map(call=>call.args.threadId).sort(),recipients.slice().sort());
    assert.ok(sends.every(call=>call.args.hostId==='local' && call.context===caller));
    assert.ok(sends.every(call=>call.args.prompt.includes(mergeSha)));
    const log = readFileSync(stdoutPath,'utf8');
    assert.ok(log.startsWith('previous stdout marker\n'),'receiver preserves preceding stdout logs');
    assert.ok(readFileSync(stderrPath,'utf8').startsWith('previous stderr marker\n'),'receiver preserves preceding stderr logs');
    const events = log.trim().split('\n').slice(1).map(JSON.parse);
    const started = events.find(event=>event.eventType==='receiver_started');
    assert.equal(started.contextThreadId,caller);
    assert.equal(started.databasePath,dbPath);
    assert.equal(started.pid,receiver.pid);
    const delivered = events.find(event=>event.eventType==='webhook_request' && event.code==='delivered');
    assert.equal(delivered.status,200);
    assert.ok(Number.isFinite(Date.parse(delivered.at)));
    assert.equal(delivered.deliveryId,deliveryId);
    assert.equal(delivered.prUrl,prUrl);
    assert.equal(delivered.prNumber,164);
    assert.equal(delivered.mergeSha,mergeSha);
    assert.equal(delivered.routeContextThreadId,caller);
    assert.deepEqual(delivered.recipients.map(item=>item.threadId).sort(),recipients.slice().sort());
    assert.deepEqual(delivered.deliveries.map(item=>({threadId:item.threadId,hostId:item.hostId,code:item.code})).sort((a,b)=>a.threadId.localeCompare(b.threadId)),
      recipients.map(threadId=>({threadId,hostId:'local',code:'delivered'})).sort((a,b)=>a.threadId.localeCompare(b.threadId)));
  } finally {
    if (receiver?.exitCode===null) receiver.kill();
    if (closed) await closed;
    const {resolve,relative,isAbsolute} = await import('node:path');
    const cleanupRelative = relative(resolve(tmpdir()),resolve(root));
    assert.ok(cleanupRelative && !cleanupRelative.startsWith('..') && !isAbsolute(cleanupRelative),'cleanup target stays inside temporary directory');
    rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});
