import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Console } from 'node:console';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDesktopClient } from './desktop-client.mjs';

const maxBodyBytes = 1024 * 1024;

export function receiverSettings(env = process.env) {
  const repository = env.MERGE_NOTIFIER_REPOSITORY;
  if (typeof repository !== 'string' || !/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Set MERGE_NOTIFIER_REPOSITORY to the exact GitHub owner/repository');
  const port = Number(env.MERGE_NOTIFIER_PORT || 8028);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid listening port');
  return { repository, port };
}

function normalizePrUrl(value) {
  if (typeof value !== 'string') throw new Error('Invalid pull request URL');
  const url = new URL(value);
  const parts = url.pathname.split('/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      parts.length !== 5 || parts[3] !== 'pull' || !/^[1-9][0-9]*$/.test(parts[4])) {
    throw new Error('Invalid pull request URL');
  }
  return `${url.origin}/${parts[1].toLowerCase()}/${parts[2].toLowerCase()}/pull/${parts[4]}`;
}

export function selectRecipient(prUrl, rows) {
  const wanted = normalizePrUrl(prUrl);
  const matches = new Map();
  for (const row of rows) {
    if (normalizePrUrl(row.url) === wanted) {
      const recipient = { threadId: row.threadId, hostId: row.hostId };
      matches.set(JSON.stringify(recipient), recipient);
    }
  }
  return [...matches.values()];
}

export function readNativeRecipients(prUrl, {
  databasePath = process.env.MERGE_NOTIFIER_CODEX_STATE_DB || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite'),
  contextThreadId = process.env.CODEX_THREAD_ID
} = {}) {
  const normalized = new URL(normalizePrUrl(prUrl));
  const [, owner, repository, , number] = normalized.pathname.split('/');
  if (!Number.isSafeInteger(Number(number))) throw new Error('Invalid PR number');
  const identity = JSON.stringify([normalized.hostname, owner, repository, Number(number)]);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const caller = db.prepare('SELECT creator_account_id, creator_user_id FROM threads WHERE id = ?').get(contextThreadId);
    if (!caller) throw new Error('The calling Codex chat is unavailable');
    const rows = db.prepare(`
      SELECT a.thread_id, a.payload FROM thread_attachments a
      JOIN threads t ON t.id = a.thread_id
      WHERE a.attachment_type = 'pull_request' AND a.identity_key = ? AND t.archived = 0
        AND (t.creator_account_id IS ? OR t.creator_account_id IS NULL)
        AND (t.creator_user_id IS ? OR t.creator_user_id IS NULL)
    `).all(identity, caller.creator_account_id, caller.creator_user_id);
    return selectRecipient(prUrl, rows.map(row => ({ threadId: row.thread_id, hostId: 'local', url: JSON.parse(row.payload).url })));
  } finally { db.close(); }
}

export function createMergeHandler({ secret, repository, findRecipients, sendMessage, checkConnection }) {
  if (!secret || !repository || !findRecipients || !sendMessage) throw new Error('Missing receiver configuration');
  const seen = new Set();
  return async ({ body, headers }) => {
    const details = {};
    const answer = (status, code) => ({ status, code, ...details });
    if (!Buffer.isBuffer(body) || body.length > maxBodyBytes) return answer(413, 'payload_too_large');
    const signature = headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return answer(401, 'invalid_signature');
    const expected = createHmac('sha256', secret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return answer(401, 'invalid_signature');
    const delivery = headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(delivery)) return answer(400, 'invalid_delivery_id');
    details.deliveryId = delivery;
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return answer(400, 'invalid_json'); }
    if (headers['x-github-event'] === 'merge_notifier_status') {
      Object.assign(details, { ready: false, scope: 'local_receiver_and_route',
        checkedAt: new Date().toISOString(), receiverPid: process.pid,
        routeContextThreadId: process.env.CODEX_THREAD_ID });
      try { details.prUrl = normalizePrUrl(payload?.prUrl); } catch { return answer(400, 'invalid_pr_url'); }
      if (!details.prUrl.startsWith(`https://github.com/${repository.toLowerCase()}/pull/`)) return answer(403, 'unexpected_repository');
      if (!Number.isSafeInteger(Number(new URL(details.prUrl).pathname.split('/')[4]))) return answer(400, 'invalid_pr_url');
      if (seen.size >= 10000) return answer(503, 'receiver_session_full');
      try {
        if (!checkConnection) return answer(503, 'desktop_unavailable');
        await checkConnection();
      } catch { return answer(503, 'desktop_unavailable'); }
      try { details.recipients = await findRecipients(details.prUrl); } catch { return answer(503, 'route_unavailable'); }
      details.checkedAt = new Date().toISOString();
      details.ready = details.recipients.length > 0;
      return details.ready ? answer(200, 'local_ready') : answer(409, 'route_missing');
    }
    if (headers['x-github-event'] !== 'pull_request' || payload?.action !== 'closed' || payload?.pull_request?.merged !== true) {
      return answer(202, 'ignored_event');
    }
    if (typeof payload.repository?.full_name !== 'string' || payload.repository.full_name.toLowerCase() !== repository.toLowerCase()) return answer(403, 'unexpected_repository');
    const pr = payload.pull_request;
    const expectedUrl = `https://github.com/${repository.toLowerCase()}/pull/${payload.number}`;
    try {
      if (!Number.isSafeInteger(payload.number) || payload.number <= 0 || pr.number !== payload.number ||
          normalizePrUrl(pr.html_url) !== expectedUrl || typeof pr.merge_commit_sha !== 'string' || !/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha) ||
          typeof pr.merged_at !== 'string' || !Number.isFinite(Date.parse(pr.merged_at))) return answer(400, 'incomplete_merge');
    } catch { return answer(400, 'incomplete_merge'); }
    const mergeSha = pr.merge_commit_sha.toLowerCase();
    Object.assign(details, { prUrl: expectedUrl, prNumber: payload.number, mergeSha,
      routeContextThreadId: process.env.CODEX_THREAD_ID });
    const mergeKey = expectedUrl + '@' + mergeSha;
    if (seen.has(mergeKey)) return answer(202, 'duplicate_delivery');
    // Session-local replay protection only; no database, durable event ledger or automatic recovery.
    if (seen.size >= 10000) return answer(503, 'receiver_session_full');
    let recipients;
    try { recipients = await findRecipients(pr.html_url); } catch { return answer(503, 'route_unavailable'); }
    details.recipients = recipients.map(({ threadId, hostId }) => ({ threadId, hostId }));
    if (!recipients.length) return answer(409, 'route_missing');
    // Claim before any send: a lost response may still mean that recipient received it.
    if (seen.has(mergeKey)) return answer(202, 'duplicate_delivery');
    seen.add(mergeKey);
    const prompt = `Automatic GitHub event: PR #${payload.number} was merged.\n` +
      `PR: ${expectedUrl}\nMerge commit: ${mergeSha}\nMerged at: ${new Date(pr.merged_at).toISOString()}\n` +
      'Follow your existing role within this chat\'s already-authorized task. ' +
      'If you are the executor, verify the PR state and applicable post-merge checks. ' +
      'If you are the coordinator, update status from the executor\'s result without duplicating implementation or checks. ' +
      'This notification does not authorize other work.';
    details.deliveries = [];
    for (const recipient of recipients) {
      try {
        await sendMessage({ recipient, prompt });
        details.deliveries.push({ ...recipient, code: 'delivered' });
      } catch {
        details.deliveries.push({ ...recipient, code: 'delivery_uncertain' });
      }
    }
    return details.deliveries.some(result => result.code === 'delivery_uncertain')
      ? answer(503, 'delivery_uncertain') : answer(200, 'delivered');
  };
}

export function createWebhookServer(handle) {
  return createServer({ requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/github/merge') {
      response.writeHead(404).end(); return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const result = await handle({ body: Buffer.concat(chunks), headers: request.headers });
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.scope === 'local_receiver_and_route' ? result : { code: result.code }));
      console.log(JSON.stringify({ at: new Date().toISOString(), eventType: result.scope === 'local_receiver_and_route' ? 'readiness_check' : 'webhook_request', ...result }));
    } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
  });
}

async function main() {
  const [mode, value] = process.argv.slice(2);
  if (!['resolve', 'serve', 'check', 'status'].includes(mode)) throw new Error('Usage: merge-notifier.mjs resolve <PR URL> | status <PR URL> | serve <secret file> | check');
  if (mode === 'status') {
    const prUrl = normalizePrUrl(value);
    const secret = (await readFile(join(dirname(process.argv[1]), 'private', 'webhook.secret'), 'utf8')).trim();
    if (secret.length < 32) throw new Error('The configured webhook secret is unavailable');
    const config = JSON.parse(await readFile(join(dirname(process.argv[1]), 'notifier.json'), 'utf8'));
    const { repository, port } = receiverSettings({
      MERGE_NOTIFIER_REPOSITORY: config.repository, MERGE_NOTIFIER_PORT: String(config.port)
    });
    if (!prUrl.startsWith(`https://github.com/${repository.toLowerCase()}/pull/`)) throw new Error('The PR must belong to the configured repository');
    const body = JSON.stringify({ prUrl });
    let result;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/github/merge`, {
        method: 'POST', body, signal: AbortSignal.timeout(25000), headers: {
          'x-github-event': 'merge_notifier_status', 'x-github-delivery': randomUUID(),
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
        }
      });
      const snapshot = await response.json();
      const ready = response.status === 200 && snapshot.code === 'local_ready' && snapshot.ready === true &&
        snapshot.scope === 'local_receiver_and_route' && snapshot.prUrl === prUrl &&
        Number.isFinite(Date.parse(snapshot.checkedAt)) && Array.isArray(snapshot.recipients) && snapshot.recipients.length > 0;
      result = { ...snapshot, ready };
    } catch { result = { ready: false, code: 'receiver_unavailable', scope: 'local_receiver_and_route', prUrl, checkedAt: new Date().toISOString() }; }
    console.log(JSON.stringify(result));
    process.exitCode = result.ready ? 0 : 1;
    return;
  }

  if (mode === 'check') {
    const desktop = await openDesktopClient();
    try {
      await desktop.call('list_artifacts', {});
      console.log(JSON.stringify({ connected: true }));
    } finally { desktop.close(); }
    return;
  }
  if (mode === 'resolve') {
    console.log(JSON.stringify({ recipients: readNativeRecipients(value) }, null, 2));
    return;
  }
  const logRoot = dirname(process.argv[1]);
  globalThis.console = new Console({
    stdout: createWriteStream(join(logRoot, 'receiver.stdout.log'), { flags: 'a' }),
    stderr: createWriteStream(join(logRoot, 'receiver.stderr.log'), { flags: 'a' })
  });
  const secret = (await readFile(value, 'utf8')).trim();
  if (secret.length < 32) throw new Error('Use an opaque random webhook secret of at least 32 characters');
  const { repository, port } = receiverSettings();
  const desktop = await openDesktopClient();
  const handle = createMergeHandler({ secret, repository, checkConnection: () => desktop.call('list_artifacts', {}),
    findRecipients: async url => {
      const recipients = readNativeRecipients(url);
      // Older chats can lack creator metadata. Confirm every candidate is accessible
      // through the current desktop account before interpreting the result as a route.
      for (const recipient of recipients) {
        await desktop.call('read_thread', { ...recipient, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
      }
      return recipients;
    },
    sendMessage: ({ recipient, prompt }) => desktop.call('send_message_to_thread', { ...recipient, prompt })
  });
  const server = createWebhookServer(handle);
  server.on('error', () => { desktop.close(); console.error('The local receiver could not listen'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({
    at: new Date().toISOString(), eventType: 'receiver_started', pid: process.pid,
    contextThreadId: process.env.CODEX_THREAD_ID,
    databasePath: process.env.MERGE_NOTIFIER_CODEX_STATE_DB || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'state_5.sqlite'),
    listening: `http://127.0.0.1:${port}/github/merge`
  })));
  const stop = () => { server.close(); desktop.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
