# OpenPalm Security Guide

OpenPalm uses defense in depth: multiple independent controls are applied so a single failure does not expose the full system.

## 1) Network boundary and route controls (Caddy)

- Caddy fronts all inbound traffic.
- `/admin*`, `/admin/opencode*`, and `/admin/openmemory*` are LAN-restricted.
- Channel routes are LAN-only by default and can be explicitly toggled to public in admin.
- Setup wizard can harden further with `host` scope (localhost-only matchers + localhost compose bindings).
- Unknown routes are rejected at the edge.

**Why:** keep management surfaces private by default and reduce internet-exposed attack surface.

## 2) Signed channel ingress and throttling (Gateway)

- Channel adapters sign payloads with HMAC shared secrets.
- Gateway verifies signatures before processing messages.
- Gateway enforces per-user rate limiting.
- Gateway writes audit logs for accepted, denied, and failed actions.

**Why:** prevent spoofed requests, dampen abuse, and provide traceability.

## 3) Agent-level isolation for channel intake

- The gateway sends raw channel input to the `channel-intake` agent on OpenCode Core.
- The `channel-intake` agent has all tools denied (bash, edit, webfetch) — it can only validate and summarize.
- Only validated summaries are forwarded to the default agent for full processing.

**Why:** reduce prompt-injection risk by handling untrusted channel input with a locked-down agent before it reaches the full agent.

## 4) Core runtime guardrails

- Core runtime policy blocks permission widening in config editor flows.
- Secret-aware memory policy and action-gating skills are included by default.
- The `openmemory-http` plugin enforces secret detection on all write-back operations and bounds context injection to prevent token exhaustion.
- Plugin/extension risk levels and permission notes are surfaced in admin.

**Why:** constrain high-risk operations and make capability risks explicit before enabling extensions.

## 5) Admin and control-plane separation

- Admin API requires admin token authentication.
- Only controller can execute compose lifecycle operations.
- Controller access requires controller token.

**Why:** isolate orchestration privileges from user-facing paths and enforce explicit auth boundaries.

## 6) Secrets and configuration partitioning

- `system.env`: installer-managed system template (advanced edits only).
- `user.env`: user-specific overrides (in config home).
- `secrets.env`: runtime secrets for core integrations (in config home).

**Why:** separate generated system settings, user overrides, and secrets to reduce accidental misconfiguration and leakage.

## 7) Optional LAN SSH for opencode-core (disabled by default)

- SSH is opt-in (`OPENCODE_ENABLE_SSH=1`).
- Password auth is disabled; key auth only via `opencode-core/ssh/authorized_keys`.
- Bind defaults are localhost unless explicitly opened to LAN.

### SSH Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_ENABLE_SSH` | `0` | Set to `1` to enable the SSH server inside the opencode-core container |
| `OPENCODE_CORE_SSH_PORT` | `2222` | Host port mapped to the container's SSH port 22 |
| `OPENCODE_CORE_SSH_BIND_ADDRESS` | `127.0.0.1` | Bind address for the SSH port on the host. Use `0.0.0.0` to expose to LAN |

### SSH Setup Steps

1. Set `OPENCODE_ENABLE_SSH=1` in your environment or `user.env`.
2. Place your public key in `~/.config/openpalm/opencode-core/ssh/authorized_keys`.
3. Restart `opencode-core` for changes to take effect.
4. Connect via `ssh -p ${OPENCODE_CORE_SSH_PORT} root@localhost` (default port 2222).

The SSH port binding is configured in `docker-compose.yml` as:
```
"${OPENCODE_CORE_SSH_BIND_ADDRESS:-127.0.0.1}:${OPENCODE_CORE_SSH_PORT:-2222}:22"
```

**Why:** allow controlled remote administration while preserving secure-by-default local-only operation.

---

For architecture and route details, see [architecture.md](./architecture.md). For API controls, see [api-reference.md](./api-reference.md).
