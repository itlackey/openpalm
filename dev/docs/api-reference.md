# API Reference (v0.3.0)

This document summarizes the primary HTTP contracts developers depend on.

## Admin API (`core/admin`)

### Purpose
- Setup completion and install lifecycle.
- Config render/apply and service control.
- Secrets and automation management.

### Common expectations
- Write operations require admin auth token/header.
- Errors should use a consistent JSON shape (`error`, optional `details`/`code`).
- Config writes are validated against YAML-first stack model before apply.

### High-use endpoint groups

### Key documented admin routes
- `GET /setup/status`
- `POST /command`
- `GET /state`
- `POST /plugins/install`
- `GET|POST|PUT|DELETE /secrets`
- `GET|POST|PUT|DELETE /automations`

- **Setup/Auth**: setup status, login/session, bootstrap operations.
- **Config**: load/save/apply `openpalm.yaml` and related generated outputs.
- **Compose control**: up/down/restart/status via allowlisted admin runner paths.
- **Secrets**: CRUD for `secrets.env` keys used by channel/service refs.
- **Automations**: CRUD + run-now for cron-based prompts.

### `POST /command` high-use command types

- Stack/config: `stack.render`, `stack.spec.set`, `stack.apply`
- Channels/services setup: `setup.*`, `channel.configure`
- Secrets/automations: `secret.*`, `automation.*`, `snippet.import`
- Service lifecycle: `service.up`, `service.stop`, `service.restart`, `service.update`
- Service introspection: `service.logs` (`payload.service`, optional `payload.tail`), `service.status`

## Gateway API (`core/gateway`)

### Purpose
- Secure channel ingress endpoint for all adapters.
- Input verification, rate limiting, and intake validation.
- Dispatch to assistant runtime + audit logging.

### Intake contract
Incoming channel payloads must include enough metadata for:
- Signature verification/auth,
- Replay/nonce protection,
- channel/user/session attribution,
- message content + optional attachments/metadata.

Gateway rejects invalid payloads before assistant dispatch.

## Channel adapter expectations
- Adapters under `channels/*` should treat platform payloads as untrusted input.
- Normalize provider-specific updates into gateway contract payloads.
- Return retry-safe status codes for webhook/platform delivery semantics.

### OpenAI-compatible channel (`channel-openai`, `8186`)

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/messages` (Anthropic-compatible)
- `POST /v1/complete` (Anthropic-compatible)
- `GET /health`

The adapter is a thin facade over the standard gateway flow:
1. Accept OpenAI-style and Anthropic-style request shapes.
2. Normalize prompt/message text into a signed `ChannelMessage` for `/channel/inbound`.
3. Return provider-compatible response JSON populated from gateway `answer`.

## Change management
When changing admin or gateway contracts:
1. Update this document.
2. Update consumer code (`packages/ui`, `packages/cli`, relevant channel adapters).
3. Add or update tests at unit + integration boundaries.
