import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
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

export function createMergeHandler({ secret, repository, findRecipients, sendMessage }) {
  if (!secret || !repository || !findRecipients || !sendMessage) throw new Error('Missing receiver configuration');
  const seen = new Set();
  const answer = (status, code) => ({ status, code });
  return async ({ body, headers }) => {
    if (!Buffer.isBuffer(body) || body.length > maxBodyBytes) return answer(413, 'payload_too_large');
    const signature = headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return answer(401, 'invalid_signature');
    const expected = createHmac('sha256', secret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) return answer(401, 'invalid_signature');
    const delivery = headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(delivery)) return answer(400, 'invalid_delivery_id');
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return answer(400, 'invalid_json'); }
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
    const mergeKey = expectedUrl + '@' + pr.merge_commit_sha.toLowerCase();
    if (seen.has(mergeKey)) return answer(202, 'duplicate_delivery');
    // Session-local replay protection only; no database, durable event ledger or automatic recovery.
    if (seen.size >= 10000) return answer(503, 'receiver_session_full');
    let recipients;
    try { recipients = await findRecipients(pr.html_url); } catch { return answer(503, 'route_unavailable'); }
    if (recipients.length !== 1) return answer(409, recipients.length ? 'route_ambiguous' : 'route_missing');
    // Claim before the send: a lost response may still mean the message was delivered.
    if (seen.has(mergeKey)) return answer(202, 'duplicate_delivery');
    seen.add(mergeKey);
    const prompt = `Automatic GitHub event: PR #${payload.number} was merged.\n` +
      `PR: ${expectedUrl}\nMerge commit: ${pr.merge_commit_sha}\nMerged at: ${new Date(pr.merged_at).toISOString()}\n` +
      'Verify the PR state and applicable post-merge checks within this chat\'s already-authorized task. ' +
      'This notification does not authorize other work.';
    try {
      await sendMessage({ recipient: recipients[0], prompt });
      return answer(200, 'delivered');
    } catch { return answer(503, 'delivery_uncertain'); }
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
      response.end(JSON.stringify({ code: result.code }));
      console.log(JSON.stringify({ at: new Date().toISOString(), code: result.code }));
    } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
  });
}

async function main() {
  const [mode, value] = process.argv.slice(2);
  if (!['resolve', 'serve', 'check'].includes(mode)) throw new Error('Usage: merge-notifier.mjs resolve <PR URL> | serve <secret file> | check');
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
  const secret = (await readFile(value, 'utf8')).trim();
  if (secret.length < 32) throw new Error('Use an opaque random webhook secret of at least 32 characters');
  const { repository, port } = receiverSettings();
  const desktop = await openDesktopClient();
  const handle = createMergeHandler({ secret, repository,
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
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}/codex-pr-merge-merge` })));
  const stop = () => { server.close(); desktop.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
