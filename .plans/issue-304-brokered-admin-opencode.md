# Issue #304 — Admin OpenCode instance inside the admin container

## Design (simplified 2026-03-20)

The admin container runs a second OpenCode instance alongside SvelteKit. The user accesses it directly via the web UI at `localhost:3881` — the same pattern as the assistant OpenCode at `localhost:3800`. No broker, no intermediary API, no session proxying.

**What this is:** An admin-level OpenCode agent with admin-tools loaded, auto-started by the container entrypoint, accessible only from the host machine via localhost binding.

**What this is not:** A brokered/mediated runtime with supervisor modules, elevated API routes, or session proxying through admin. The original plan's broker complexity was removed.

## Current state (mostly complete)

| Component | Status | Evidence |
|-----------|--------|----------|
| **Dockerfile** | ✅ Done | `core/admin/Dockerfile:65-86` — OpenCode v1.2.24 + Bun installed at runtime |
| **Entrypoint auto-start** | ✅ Done | `core/admin/entrypoint.sh:60` — `start_opencode` runs automatically |
| **Compose port binding** | ✅ Done | `assets/admin.yml:59` — `127.0.0.1:3881:4097` (host-only) |
| **Config seeding** | ✅ Done | `packages/lib/src/control-plane/core-assets.ts:246` — `ensureAdminOpenCodeConfig()` |
| **Admin-tools plugin** | ✅ Done | `assets/admin-opencode.jsonc` loads `@openpalm/admin-tools` + `@openpalm/assistant-tools` |
| **Auth (token split)** | ✅ Done | `packages/admin/src/lib/server/helpers.ts` — `ADMIN_TOKEN` / `ASSISTANT_TOKEN` distinct |
| **38XX port scheme** | ✅ Done | Admin UI at `3880`, admin OpenCode at `3881`, all localhost-bound |
| **No Caddy route** | ✅ Correct | Caddyfile has no admin OpenCode proxy — host-only access by design |

## Remaining work

### 1. Admin UI link/status indicator

Add a link or status card in the admin dashboard that:
- Shows whether admin OpenCode is running (health check against `localhost:4097` from inside the container)
- Links the user to `localhost:3881` (or the configured `OP_ADMIN_OPENCODE_PORT`)

### 2. Documentation updates

- ✅ `docs/technical/core-principles.md:153` — port table updated (removed "Brokered")
- ✅ `.github/roadmap/0.10.0/README.md:108` — scope simplified
- ✅ `.github/roadmap/0.10.0/review-decisions.md:81` — Q4 updated to reflect direct access
- ✅ `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:156` — token matrix updated

### 3. Test coverage

- Verify admin OpenCode is reachable at the configured port (E2E)
- Verify it is NOT exposed through Caddy (no public route)
- Verify admin-tools plugin loads correctly
- Update existing `packages/admin/e2e/opencode-ui.test.ts` for 38XX ports if needed

## Non-goals

- No broker/supervisor module — OpenCode auto-starts and the entrypoint handles cleanup on exit
- No elevated API routes (`/admin/elevated/*`) — user accesses the web UI directly
- No session proxying or message forwarding — direct interaction
- No new lib types/DTOs for runtime status or session metadata
- No Caddy route — host-only access is intentional

## Constraints preserved

1. Admin remains the sole orchestrator (Docker socket via docker-socket-proxy)
2. Admin OpenCode uses `ADMIN_TOKEN` — it IS an admin agent
3. No new public ingress (localhost binding only)
4. Assistant isolation preserved — assistant does not gain admin token
5. All actions through admin-tools go through existing admin API endpoints

## Relevant files

- `core/admin/Dockerfile` — runtime image with OpenCode + Bun
- `core/admin/entrypoint.sh` — auto-starts SvelteKit + OpenCode
- `assets/admin.yml` — compose overlay with port binds and env vars
- `assets/admin-opencode.jsonc` — seeded OpenCode config with admin-tools
- `packages/lib/src/control-plane/core-assets.ts` — config seeding function
- `packages/admin/src/lib/opencode/client.server.ts` — existing OpenCode client (targets assistant at 4096; admin instance is separate at 4097)
- `packages/admin/e2e/opencode-ui.test.ts` — existing E2E tests to update
