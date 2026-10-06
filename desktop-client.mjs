import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

// Reuse the installed Codex plugin's transport and schemas.
export async function openDesktopClient() {
  const context = process.env.CODEX_THREAD_ID;
  const node = process.env.CODEX_MCP_NODE_PATH;
  const resources = process.env.CODEX_ELECTRON_RESOURCES_PATH ||
    (process.env.CODEX_TECTONIC_PATH && dirname(dirname(process.env.CODEX_TECTONIC_PATH)));
  if (!context || !node || !resources || !process.env.CODEX_APP_TOOLS_PIPE_PATH) {
    throw new Error('Launch from the intended Codex desktop chat environment');
  }
  const plugin = join(resources, 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools', 'server.mjs');
  const child = spawn(node, [plugin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  function fail(error) {
    for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(error); }
    pending.clear();
  }
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  function request(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Codex response timed out; do not retry a send')); }, 20000);
      pending.set(requestId, { resolve, reject, timer });
      send({ id: requestId, method, params });
    });
  }
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id); clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    } catch { fail(new Error('Invalid response from the installed Codex plugin')); }
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('The installed Codex plugin closed')));
  const close = () => { child.stdin.end(); lines.close(); child.kill(); fail(new Error('Client closed')); };
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'codex-pr-merge-notifier', version: '0.1.0' } });
    send({ method: 'notifications/initialized' });
    await request('tools/list', {});
  } catch (error) { close(); throw error; }
  return { close, async call(name, args, contextThreadId = context) {
    const result = await request('tools/call', { name, arguments: args, _meta: { 'openai/threadId': contextThreadId } });
    if (result.isError) throw new Error('The Codex app tool rejected the operation');
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  } };
}
