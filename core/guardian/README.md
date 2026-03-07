# core/guardian — Message Guardian

Bun HTTP server that acts as the security checkpoint for all inbound channel traffic. Every channel message must pass through the guardian before reaching the assistant.

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
| `OPENPALM_ASSISTANT_URL` | `http://assistant:4096` | Assistant endpoint |
| `GUARDIAN_SECRETS_PATH` | — | Path to `secrets.env` for channel secrets |
| `GUARDIAN_AUDIT_PATH` | `/app/audit/guardian-audit.log` | Audit log path |
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
