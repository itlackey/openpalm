# Gateway Service

The `gateway` container is the central security and routing layer for OpenPalm. Every message from every channel passes through the gateway — it is the single enforcement point for authentication, rate limiting, input validation, and audit logging.

**Key invariant:** No channel can talk to the assistant directly. Channel containers have network access only to the gateway.

## What it does

- **HMAC signature verification** — Validates that messages came from a legitimate channel adapter
- **Payload validation** — Validates structure and content before further processing
- **Rate limiting** — 120 requests/min per user
- **Channel intake validation** — Uses the `channel-intake` agent (all tools denied) to validate and summarize untrusted input before it reaches the full agent
- **Audit logging** — Records all inbound requests and their outcomes
- **Stateless routing** — Does not store messages, sessions, or user data

## Message processing pipeline

```
User -> Channel Adapter -> [HMAC sign] -> Gateway (/channel/inbound)
     -> OpenCode (channel-intake agent: validate/summarize)
     -> Gateway -> OpenCode (default agent: full processing)
     -> Open Memory -> Response -> Gateway -> Channel Adapter -> User
```

The 6-step inbound pipeline at `/channel/inbound`:

1. **HMAC signature verification** — Rejects unsigned or tampered requests (`403 invalid_signature`)
2. **Payload validation** — Rejects malformed payloads (`400 invalid_payload`)
3. **Rate limiting** — Rejects excess requests with `429 rate_limited` (120 req/min/user)
4. **Intake validation** — Forwards message to the `channel-intake` agent (deny-all tools); rejects invalid input with `422 invalid_channel_request`
5. **Forward to assistant** — Sends only the validated summary to the default agent for full processing
6. **Audit log** — Records all requests and outcomes

## Channel intake agent

The `channel-intake` agent is defined in `core/gateway/opencode/agents/channel-intake.md`. It runs with `"*": false` (all tools denied) — it can only validate and summarize input. Only the validated summary is forwarded to the full agent.

This uses OpenCode's built-in agent permission model for isolation without requiring a separate container.

Extension sources are baked into the gateway image at build time:

```
core/gateway/opencode/
├── opencode.jsonc          # Intake agent config (all tools denied via "*": "deny")
├── AGENTS.md               # Action gating rules
├── agents/
│   └── channel-intake.md   # Channel intake agent definition
└── skills/
    └── channel-intake/
        └── SKILL.md        # Channel message validation/summarization skill
```

The gateway has no host config volume — its extensions are fully baked and not overridable.

## Channel security hardening

- Each channel has a unique HMAC shared secret generated at install time and written to `STATE/channel-<name>/.env`
- Secrets are never exposed to users
- Replay protection: timestamp + nonce validation
- Replay nonce cache persists to `STATE/gateway/nonce-cache.json` so replay protection survives gateway restarts
- Max message size limits
- Per-user rate limiting

### Network placement

- Public entrypoint: reverse proxy (Caddy) + TLS
- OpenCode and OpenMemory are private; only the gateway can access them
- Channel adapters have network access only to the gateway — not to OpenCode, OpenMemory, admin, or any other service

### Capability isolation

Channel adapters do not:
- Access Docker
- Access the host filesystem
- Hold non-channel secrets

## API endpoints

See [API Reference](../dev/docs/api-reference.md) for full endpoint details.

| Endpoint | Description |
|---|---|
| `GET /health` | Gateway health status |
| `POST /channel/inbound` | Signed channel payload from adapters |

### `/channel/inbound` payload

```json
{
  "userId": "discord:123",
  "channel": "discord",
  "text": "hello",
  "metadata": {},
  "nonce": "uuid",
  "timestamp": 1730000000000
}
```

Headers: `x-channel-signature` (HMAC-SHA256)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_TIMEOUT_MS` | `15000` | Timeout for OpenCode requests |

## Related docs

- [Architecture](../dev/docs/architecture.md) — Full container architecture and data flow
- [Security Guide](../docs/security.md) — Defense-in-depth security model
- [API Reference](../dev/docs/api-reference.md) — All service endpoints
