# OpenPalm — Production Bun/TypeScript Assistant Stack

This repository now implements a complete safety-first assistant platform from the 4 root design guides:

- OpenCode runtime + plugin system
- OpenMemory MCP integration
- Gateway control plane (auth, sessions, approvals, tool firewall, audit, staged changes)
- Optional channel adapters (Webhook + Telegram) as dumb adapters
- API/CLI-driven extension approval flow (no manual UI required)
- Docker Compose deployment with private service network and restricted restart sidecar

## Implemented architecture

### Core services
- `openmemory`: long-term memory backend
- `opencode`: agent runtime and orchestration loop
- `gateway`: system control plane
- `compose-control`: tightly scoped restart API used by gateway

### Optional channel services
- `channel-webhook`: generic signed inbound webhook adapter
- `channel-telegram`: Telegram webhook adapter

## Non-technical installation

1. Install Docker Desktop (or Docker Engine + Compose v2)
2. Run:
   ```bash
   ./install.sh
   ```
3. Open:
   - Gateway health: `http://localhost:8080/health`
   - Ops dashboard: `http://localhost:8080/index.html`

To enable channel containers:
```bash
docker compose --profile channels up -d --build
```

## Safety defaults implemented

- Tool firewall with explicit risk tiers (`safe`, `medium`, `high`)
- Approval required for medium/high risk tools
- Network egress allowlist for `safe_fetch`
- Secret detection blocks memory writes and suspicious tool args
- Recall-first response behavior with memory IDs and rationale
- Audit log with request/session/user correlation
- Replay protection and signature verification for channel ingress
- Rate limiting at gateway message ingress

## Admin flow (API/CLI, not UI-manual)

### Extensions
1. Request installation:
   `POST /admin/extensions/request`
2. Review queue:
   `GET /admin/extensions/list`
3. Apply requested extension:
   `POST /admin/extensions/apply` (requires step-up token)
4. Disable extension:
   `POST /admin/extensions/disable` (requires step-up token)

`AUTO_APPROVE_EXTENSIONS` supports policy-based auto-apply for named non-critical plugins.

### Change manager
- `POST /admin/change/propose`
- `POST /admin/change/validate`
- `POST /admin/change/apply`
- `POST /admin/change/rollback`

### Config editor API
- `GET /admin/config`
- `POST /admin/config`

Config writes are backed up atomically and linted to deny permission widening to `allow`.

## CLI for extension approvals

Set env vars and run:
```bash
export GATEWAY_URL=http://localhost:8080
export ADMIN_TOKEN=...
export ADMIN_STEP_UP_TOKEN=...

bun run scripts/extensions-cli.ts request --plugin @scope/plugin
bun run scripts/extensions-cli.ts list
bun run scripts/extensions-cli.ts apply --request <request-id>
bun run scripts/extensions-cli.ts disable --plugin @scope/plugin
```

## Notes on external dependencies

This implementation avoids non-essential runtime package dependencies to remain functional in restricted environments.


## Release readiness notes

- Core stack is intended to run with `docker compose up -d --build`.
- Optional channel adapters are enabled via `--profile channels`.
- Extension approvals are handled via API/CLI workflow rather than manual UI actions.
