import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Windows setup creates isolated private settings and preserves existing hooks and credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge setup with spaces-'));
  const source = dirname(fileURLToPath(import.meta.url));
  const home = join(root, 'codex-home');
  function run(script, args=[]) {
    return spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',join(root,script),...args], {encoding:'utf8',windowsHide:true,env:{...process.env,CODEX_HOME:home}});
  }
  try {
    for (const script of ['configure.ps1','install-codex-hook.ps1','start-notifier.ps1']) copyFileSync(join(source,script),join(root,script));
    const args=['-Repository','another-owner/another_repo','-NgrokDomain','fixture.example.org','-Port','9042'];
    const configured=run('configure.ps1',args);
    assert.equal(configured.status,0,configured.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'notifier.json'),'utf8')),{repository:'another-owner/another_repo',port:9042});
    assert.equal(statSync(join(root,'private','webhook.secret')).size,64);
    const originalSecretTime=statSync(join(root,'private','webhook.secret')).mtimeMs;
    assert.notEqual(run('configure.ps1',args).status,0);
    assert.equal(statSync(join(root,'private','webhook.secret')).mtimeMs,originalSecretTime);
    const tunnel=readFileSync(join(root,'ngrok-service.yml'),'utf8');
    assert.ok(tunnel.includes('https://fixture.example.org'));
    assert.ok(tunnel.includes('http://127.0.0.1:9042'));
    mkdirSync(home);
    const preserved={hooks:{Stop:[{hooks:[{type:'command',command:'echo preserved'}]}]}};
    writeFileSync(join(home,'hooks.json'),JSON.stringify(preserved));
    const installed=run('install-codex-hook.ps1');
    assert.equal(installed.status,0,installed.stderr);
    const hooks=JSON.parse(readFileSync(join(home,'hooks.json'),'utf8'));
    assert.deepEqual(hooks.hooks.Stop,preserved.hooks.Stop);
    assert.equal(hooks.hooks.SessionStart.length,1);
    const command=hooks.hooks.SessionStart[0].hooks[0].command;
    const target=command.match(/ -File "([^"]+)" -Hook$/)?.[1];
    assert.ok(target, 'The hook must contain one quoted script path');
    const actualFile=statSync(target,{bigint:true});
    const expectedFile=statSync(join(root,'start-notifier.ps1'),{bigint:true});
    assert.equal(actualFile.dev,expectedFile.dev);
    assert.equal(actualFile.ino,expectedFile.ino);
    const skill=readFileSync(join(home,'skills','merge-notifier','SKILL.md'),'utf8');
    assert.ok(skill.includes('$merge-notifier reconnect'));
    const originalHooks=readFileSync(join(home,'hooks.json'),'utf8');
    assert.notEqual(run('install-codex-hook.ps1').status,0);
    assert.equal(readFileSync(join(home,'hooks.json'),'utf8'),originalHooks);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
