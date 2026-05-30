# core/guardian — Message Guardian

Bun HTTP server that acts as the security checkpoint for all inbound channel traffic. Every channel message must pass through the guardian before reaching the assistant.

The image also ships the OpenCode binary (pinned to the same `OPENCODE_VERSION` as the assistant). Guardian-side OpenCode instances read their global config from `/etc/opencode` (bind-mounted from `OP_HOME/config/guardian`, set via `OPENCODE_CONFIG_DIR`) and share provider credentials with the assistant through the read-only `auth.json` mount (from `OP_HOME/config/stack/auth.json`).

## Security pipeline

For each `POST /channel/inbound` request:

1. Reject bodies over 100 KiB; parse JSON
2. Validate payload shape (channel, userId, text, nonce, timestamp + length bounds)
3. Look up `CHANNEL_<NAME>_SECRET` and verify the HMAC-SHA256 signature (`x-channel-signature`)
4. Enforce rate limits — 120 req/min per user, 200 req/min per channel
5. Reject replayed nonces (5-minute window)
6. **Content validation** (opt-in) — semantic check for malicious content (see below)
7. Forward validated message to the assistant

Any failure returns an error and the message never reaches the assistant.

## Content validation (opt-in)

Steps 1–2 are structural only — they confirm a message is *well-formed*, not
that it is *safe*. When `GUARDIAN_CONTENT_VALIDATION` is enabled, step 6 adds a
semantic layer that inspects what the message is actually trying to do, using a
local OpenCode moderator. It is layered cheap → expensive:

- **Heuristic pre-screen** (`@openpalm/channels-sdk/content-screen`): pure,
  in-process pattern matching that scores prompt-injection / jailbreak /
  exfiltration / obfuscation signals. Most traffic scores 0 and is forwarded
  without ever touching a model.
- **LLM escalation**: only messages whose risk crosses
  `GUARDIAN_MODERATION_THRESHOLD` are sent to the guardian's local OpenCode
  moderator (loopback `:4097`, started by the entrypoint, using the small model
  pinned in `config/guardian/opencode.jsonc` and the shared provider creds). It
  returns a strict JSON verdict: `allow`, `flag` (forward + audit), or `block`.

**Fail-closed:** if an escalated message cannot be classified (moderator down,
timeout, unparseable output) it is **blocked** (`403 content_blocked`). Because
that trades availability for security, the feature is **off by default** — turn
it on only once a moderation model is configured. The taxonomy and output
contract live in `config/guardian/instructions/moderation.md`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/channel/inbound` | Receive a signed channel message |
| `GET` | `/health` | Health check |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant endpoint |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenCode global config dir (bind-mounted from `config/guardian`) |
| `GUARDIAN_SECRETS_PATH` | — | Path to env file containing channel secrets |
| `GUARDIAN_AUDIT_PATH` | `/opt/openpalm/logs/guardian-audit.log` | Audit log path |
| `CHANNEL_<NAME>_SECRET` | — | Per-channel HMAC secret (from secrets file or env) |
| `GUARDIAN_CONTENT_VALIDATION` | `0` | Enable LLM-assisted content validation (fail-closed) |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local OpenCode moderator endpoint |
| `GUARDIAN_MODERATION_PORT` | `4097` | Loopback port the entrypoint starts the moderator on |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic risk score at/above which a message is escalated to the model |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Per-classification timeout; on expiry the message fails closed |

## Development

```bash
bun run src/server.ts
```

Or from the repo root:

```bash
bun run guardian:dev
bun run guardian:test
```

## Testing

```bash
cd core/guardian && bun test
```
