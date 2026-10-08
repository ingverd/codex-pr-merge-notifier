# Codex PR merge notifier

[English](README.md) | [Русский](README.ru.md)

Send a signed GitHub PR merge event to the local Codex chat that owns its native PR attachment. Experimental community tooling, unaffiliated with OpenAI or ngrok.

`GitHub webhook → HTTPS tunnel → localhost receiver → matching Codex chat`

## Set up with a Codex agent

Share this repository link in a **local Codex desktop chat for your project** to request installation:

[https://github.com/ingverd/codex-pr-merge-notifier](https://github.com/ingverd/codex-pr-merge-notifier)

The instructions below let the agent work out the setup from your project; you do not need to copy a separate installation prompt. You will still need an ngrok account, permission to administer your project's GitHub webhooks, and any Windows/Codex permission confirmations. The agent should ask only for information or steps it cannot safely obtain or perform itself.

### Instructions for the agent

When the user shares this repository to set up merge notifications, carry the installation through verification using the Windows installation steps below. If the link was shared for a review or explanation, follow that request instead.

1. **Identify the target before cloning.** Inspect the current project's GitHub remote and existing notifier settings. Use the current project's `owner/repo` when there is one clear intended GitHub.com repository; ask only if the target is missing or ambiguous. This notifier's own clone remote is not the target. Keep credential-bearing remote URLs out of output. Obtain the user's assigned ngrok domain from their dashboard or ask for the domain, never their token.
2. **Check compatibility and existing state.** Confirm Windows, a local Codex desktop chat, Node.js 24+, and the current desktop connection required by `desktop-client.mjs`. Do not invent or persist app IPC paths. Inspect existing service, receiver, hook, skill and local settings before making changes. Reuse a matching installation; the setup scripts intentionally refuse overwrites and service takeover. For a conflicting installation, explain the conflict and ask which one the user wants to keep before replacing anything.
3. **Use the supplied setup.** Clone into a stable folder outside the user's application checkout, inspect the scripts and run the source tests. Use the official signed ngrok binary and follow **Install on Windows** in order. No npm dependencies are needed. For a fresh installation, check that the configured receiver port and ngrok's local API port 4040 are available. Automate the documented steps with available tools; do not introduce another supervisor, scheduled task, routing registry or global shell-policy change.
4. **Keep secrets local.** Run `connect-ngrok.ps1` in an interactive local PowerShell so the user can enter the authtoken in its masked prompt. Have the user enter `private/webhook.secret` directly into GitHub as described below. Never read or display either credential in agent output, chat, screenshots or logs. Use the normal UAC and Codex hook-review flows when required; do not bypass them. Give the user one concrete local action when a step requires their input, then continue after it is completed.
5. **Verify the running installation.** Read back the ngrok service's running state, automatic startup, Local Service account and native recovery settings. Confirm the assigned HTTPS endpoint forwards to the configured receiver on `127.0.0.1`, the installed startup hook is enabled, targets this installation and has passed required Codex review, and `merge-notifier.mjs check` reports `connected: true`. Check GitHub's live webhook configuration: exact target repository, `/github/merge`, JSON, SSL verification enabled, and only `pull_request` events. Confirm a genuine GitHub ping delivery receives HTTP 202. Inspect uncertain mutations before retrying.
6. **Verify routing when a real PR is available.** Use the native Codex PR attachment in the intended chat, then run `merge-notifier.mjs resolve <PR URL>`. Exactly that one eligible chat must be returned. Do not attach every PR to the installation chat or create/merge a PR just for testing. If no suitable PR exists, report routing as unverified. Ping proves webhook ingress and signature validation; only a real owner-approved merge can prove delivery into the destination chat.
7. **Report the result.** Give the installation path, configured `owner/repo`, webhook URL, checks that passed, any unverified stage or concrete blocker, and the `$merge-notifier status` / `$merge-notifier reconnect` commands. Do not report a complete end-to-end test unless a real merge notification was observed. Keep the existing chat's model and reasoning settings.

## Scope and compatibility

- One explicitly configured GitHub.com repository per installation. Reuse the same source with your own repository, domain and credentials.
- Windows setup helpers, Node.js 24 or later, and local Codex desktop chats. Cloud/remote chat routing and other operating systems' setup are not supported.
- Routing reads Codex's native SQLite attachment metadata without modifying it. Exactly one accessible, non-archived chat must match the PR; missing or ambiguous routes fail closed.
- The receiver uses the installed app's internal database schema and bundled app-tools channel. These are **internal interfaces**, not a stable public integration API. Recheck after Codex updates. The original integration was exercised on Codex desktop 26.930.2377.0 and CLI 0.159.0-alpha.12.1.
- HMAC SHA-256 is required for every webhook. Only a merged `pull_request` close event for the allowed repository can send a message. PR titles/bodies are never copied into prompts.
- Replay protection lasts for one receiver process. There is no offline queue, persistent event ledger or automatic resend after an uncertain send.
- ngrok uses its native Windows service and failure recovery. The receiver reconnects on chat startup/resume; use the chat command if it fails between those events. Windows/Codex must be running when delivery arrives.

## Install on Windows

1. Clone this repository into a stable folder. Keep it there: service and hook definitions use its absolute path.
2. Download the signed Windows agent from [ngrok](https://ngrok.com/download/windows), and put `ngrok.exe` in that folder. Create an ngrok account and obtain its assigned HTTPS domain. The agent is a separate vendor dependency and is not distributed by this project.
3. From PowerShell in that folder, initialize your local settings:

   ```powershell
   .\configure.ps1 -Repository 'your-owner/your-repo' -NgrokDomain 'your-assigned-domain.ngrok-free.dev'
   .\connect-ngrok.ps1
   ```

   Enter the ngrok authtoken only in the masked local prompt. `configure.ps1` generates a separate random GitHub webhook secret inside `private/`, sets its Windows ACL, and refuses to overwrite an existing installation. Use `-Port 9042` if port 8028 is already used.

4. Open an administrator PowerShell in the installation folder and run `install-ngrok-service.ps1`. Existing ngrok services/processes are not taken over. The service runs as Windows Local Service, with automatic startup and native failure recovery. It gets read access to the ngrok credential, not the GitHub webhook secret.
5. From a local Codex desktop chat, run `install-codex-hook.ps1`. It adds one user-level `SessionStart` hook and installs the `merge-notifier` skill. It preserves other hooks and refuses to replace an existing skill. Review/trust the hook through Codex's supported hook review if the app requires it. [Codex hook documentation](https://learn.chatgpt.com/docs/hooks).
6. In GitHub repository **Settings → Webhooks**, configure `https://YOUR_DOMAIN/github/merge`, JSON, SSL verification enabled, and only `pull_request` events. Enter the contents of `private/webhook.secret` directly into GitHub's Secret field using your local editor; do not paste it into a chat. Start the receiver and confirm GitHub's ping delivery receives HTTP 202.
7. Attach the PR to its intended local Codex chat. The integration sends only if exactly one eligible chat has that attachment. No extra routing registry is needed.

No GitHub access token is required by the running receiver. GitHub webhook administration uses your normal repository permissions. ngrok and webhook credentials are local settings, ignored by Git, and are never part of the repository.

## Commands

In a local Codex chat:

```text
$merge-notifier reconnect
$merge-notifier status
```

Manual receiver startup from that chat's shell:

```powershell
.\start-notifier.ps1
.\start-notifier.ps1 -Reconnect
```

`reconnect` changes the receiver's app connection. Recipients still come from PR attachments; it does not send every notification to the invoking chat. It checks process ownership and never replaces an unrelated listener. An uncertain startup or send must be inspected before retrying.

Read-only diagnostics:

```powershell
& $env:CODEX_MCP_NODE_PATH .\merge-notifier.mjs check
& $env:CODEX_MCP_NODE_PATH .\merge-notifier.mjs resolve 'https://github.com/your-owner/your-repo/pull/123'
```

Direct `serve` additionally requires `MERGE_NOTIFIER_REPOSITORY`, and optionally `MERGE_NOTIFIER_PORT`. `start-notifier.ps1` reads those settings from ignored `notifier.json`. `MERGE_NOTIFIER_CODEX_STATE_DB` can override the native database path for diagnosis; `CODEX_HOME` otherwise locates `state_5.sqlite`.

The receiver writes startup messages, event status codes and sanitized errors to `receiver.stdout.log` and `receiver.stderr.log` in the installation folder, including direct `serve` runs. The Windows starter launches a separate hidden process without redirecting the hook's channels, so the running receiver does not delay hook completion.

## Verification and privacy

```powershell
npm test
# Or use the bundled runtime from a local Codex desktop chat:
& $env:CODEX_MCP_NODE_PATH --test
```

Tests use synthetic repositories, chats, merge payloads and databases. They perform no GitHub writes or chat sends. The source export excludes credentials, binaries, native databases, logs, actual chat IDs, personal filesystem paths and the original repository/domain configuration. Tests cover signed/unsigned delivery, routing, replay, uncertain sends and safe reconnect. CI runs the same tests on Windows.

The source tests do not prove that a future Codex version has compatible internal interfaces. Verify the live app connection, native routing and GitHub ping after installing or updating. A successful ping proves ingress/signatures; use a real owner-approved merge to verify the complete workflow.

## License

[MIT](LICENSE). Third-party tools retain their own licenses and terms.
