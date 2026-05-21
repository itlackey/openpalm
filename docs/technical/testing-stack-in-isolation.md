# Testing the OpenPalm Stack in Isolation

How to run the full e2e test suite against a real dev stack instance, including the assistant (OpenCode) container.

## Architecture

The stack has three independently-addressable services on the HOST:

| Service | Host URL | How it runs |
|---|---|---|
| Admin UI | `http://localhost:8100` | Host process (`bun run ui:dev` or `openpalm ui serve`) |
| Assistant (OpenCode) | `http://localhost:3800` | Docker container — host port 3800 → container port 4096 |
| Guardian | Not exposed in dev | Docker container — no host port by default |

> The admin UI is **not** a container. It is a SvelteKit app run as a host process. The `OP_ADMIN_PORT` in `stack.env` (default `8100`) is its listen port.

## Prerequisites

1. **Dev stack seeded** — run once to create `.dev/` directories and seed configs:
   ```bash
   bun run dev:setup
   # or
   ./scripts/dev-setup.sh --seed-env
   ```

2. **Docker stack running** — assistant + guardian containers:
   ```bash
   bun run dev:stack
   # or
   bun run dev:build   # build from source
   ```
   Verify: `docker ps | grep openpalm` should show `openpalm-assistant-1` (healthy) and `openpalm-guardian-1`.

3. **Admin server running** — the SvelteKit admin UI as a host process, pointed at the assistant:
   ```bash
   cd packages/ui
   OP_HOME="$(pwd)/../../.dev" \
   OP_OPENCODE_URL="http://localhost:3800" \
   npm run dev -- --host 127.0.0.1 --port 8100
   ```
   Verify: `curl http://localhost:8100/health` should return `{"status":"ok","service":"admin"}`.

   > `OP_OPENCODE_URL` must be set because the default is `localhost:4096` (container-internal port). The host-side mapping is port **3800**.

## Running the Stack Tests

```bash
RUN_DOCKER_STACK_TESTS=1 \
ADMIN_TOKEN=dev-admin-token \
ADMIN_URL=http://localhost:8100 \
bun run ui:test:e2e
```

All three env vars are required:
- `RUN_DOCKER_STACK_TESTS=1` — gates are skipped by default; this unlocks them
- `ADMIN_TOKEN=dev-admin-token` — the admin token seeded by `dev-setup.sh`
- `ADMIN_URL=http://localhost:8100` — overrides the default 3880 to match the dev admin port

Expected results (with assistant running):
- `AKM Config API` — 34 tests, all pass
- `Admin Health Endpoint` — 4 tests, all pass (including `opencode:true`)
- `Connections Tab — Providers` — 4 tests, all pass (`available:true`)
- `OpenCode Web UI` — 5 tests, all pass
- `Automation Scheduler` — 6 tests, all pass
- `Channel -> Guardian -> Assistant Pipeline` — **skipped or partially failing** in dev (guardian not host-exposed; see below)

## Verifying the Health Endpoint Manually

```bash
# Should return 401 — no token
curl -i http://localhost:8100/admin/health

# Should return { ok: true, opencode: true } — assistant is running
curl -H "x-admin-token: dev-admin-token" http://localhost:8100/admin/health

# Should return available: true — assistant is reachable
curl -H "x-admin-token: dev-admin-token" http://localhost:8100/admin/providers | jq '.available'
```

## Known Dev Gaps

### Guardian not host-exposed
The `openpalm-guardian-1` container does not map its port to the host in the dev stack. The `channel-guardian-pipeline.pw.ts` tests that hit port 8180 (the guardian) will fail with `ECONNREFUSED`. This is expected in dev — the guardian only receives traffic routed through its compose network. To test guardian behavior, run those tests inside the compose network or temporarily expose the port with a local override compose file.

### OpenCode port vs admin default
The admin UI's `http.ts` defaults to `localhost:4096` (the container-internal port). When running the admin as a host process in dev, you must set `OP_OPENCODE_URL=http://localhost:3800` to reach the assistant through its host-side port mapping.

### Mocked contract tests (no stack required)
The mocked e2e suite tests the wizard and admin browser contracts without a running stack:
```bash
bun run ui:test:e2e:mocked
```
These always pass without docker and cover the majority of browser-level route contracts.
