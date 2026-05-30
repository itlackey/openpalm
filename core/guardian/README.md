# core/guardian — Message Guardian

Bun HTTP server that acts as the security checkpoint for all inbound channel traffic. Every channel message must pass through the guardian before reaching the assistant.

The image also ships the OpenCode binary (pinned to the same `OPENCODE_VERSION` as the assistant). Guardian-side OpenCode instances read their global config from `/etc/opencode` (bind-mounted from `OP_HOME/config/guardian`, set via `OPENCODE_CONFIG_DIR`) and share provider credentials with the assistant through the read-only `auth.json` mount (from `OP_HOME/config/stack/auth.json`).

## Security pipeline

For each `POST /channel/inbound` request:

1. Parse JSON body
2. Look up `CHANNEL_<NAME>_SECRET` from environment
3. Verify HMAC-SHA256 signature (`x-channel-signature` header)
4. Reject replayed nonces (5-minute cache)
5. Enforce rate limits — 120 req/min per user, 200 req/min per channel
6. Validate payload shape (channel, userId, message, timestamp)
7. Forward validated message to the assistant

Any failure at steps 2–6 returns an error and the message never reaches the assistant.

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
