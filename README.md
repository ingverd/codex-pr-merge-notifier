# Codex PR merge notifier

Send a signed GitHub PR merge event to the local Codex chat that owns its native PR attachment. Experimental community tooling, unaffiliated with OpenAI or ngrok.

`GitHub webhook → HTTPS tunnel → localhost receiver → matching Codex chat`

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
