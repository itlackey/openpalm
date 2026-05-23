# Testing the OpenPalm Stack in Isolation

How to run the full e2e test suite against a real dev stack instance, including the assistant (OpenCode) container.

## Port Isolation

Dev-setup and tests use **offset ports** so they never conflict with a production instance running on the same machine:

| Service | Production defaults | Dev/test ports (`dev-setup.sh`) |
|---|---|---|
| Admin UI (host process) | `8100` | `9100` |
| Assistant (OpenCode) | `3800` → container `4096` | `4800` → container `4096` |
| Guardian | `8180` | `9180` |

`dev-setup.sh --seed-env` seeds `.dev/config/stack/stack.env` with the dev/test ports. `global-setup.ts` reads that file before tests run and auto-constructs `ADMIN_URL` and `ASSISTANT_URL`, so tests automatically target the correct stack with no extra env vars needed.

Tests read port configuration in this priority order:
1. Explicit env vars (`ADMIN_URL`, `ASSISTANT_URL`, `OP_GUARDIAN_PORT`)
2. `STACK_ENV_PATH` — path to a `stack.env`; `global-setup.ts` builds `ADMIN_URL`/`ASSISTANT_URL` from `OP_ADMIN_PORT`/`OP_ASSISTANT_PORT` found there
3. Hardcoded test defaults: 9100 / 4800 / 9180 (match dev-setup.sh)

## Architecture

| Service | How it runs |
|---|---|
| Admin UI | Host process (`bun run ui:dev` or `openpalm ui serve`) |
| Assistant (OpenCode) | Docker container — host port `OP_ASSISTANT_PORT` → container port 4096 |
| Guardian | Docker container — host port `OP_GUARDIAN_PORT` |

> The admin UI is **not** a container. It is a SvelteKit app run as a host process. `OP_ADMIN_PORT` in `stack.env` (default `8100`) is its listen port.

## Starting a Test Stack

### 1. Seed a test `.dev-test/` directory

Create a stack env with test-isolated ports:

```bash
mkdir -p .dev-test/config/stack
cat > .dev-test/config/stack/stack.env <<'EOF'
OP_HOME=.dev-test
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_DOCKER_SOCK=/var/run/docker.sock
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
OP_UI_TOKEN=dev-admin-token
OP_ASSISTANT_TOKEN=$(openssl rand -hex 32)
OP_ASSISTANT_PORT=4800
OP_ADMIN_PORT=9100
OP_GUARDIAN_PORT=9180
OP_SETUP_COMPLETE=true
EOF
chmod 600 .dev-test/config/stack/stack.env
```

Or use the dev-setup script (which seeds `.dev/` with dev ports) and manually adjust ports, or start the compose stack with explicit port env vars.

### 2. Start the Docker stack (assistant + guardian)

```bash
bun run dev:build
# or with test ports:
OP_ASSISTANT_PORT=4800 OP_GUARDIAN_PORT=9180 \
docker compose --project-directory . \
  -f .dev/config/stack/core.compose.yml \
  -f compose.dev.yml \
  --env-file .dev/config/stack/stack.env \
  --project-name openpalm-test \
  up -d
```

Verify: `docker ps | grep openpalm-test` should show assistant (healthy) and guardian.

### 3. Start the Admin UI host process

```bash
cd packages/ui
OP_HOME="$(pwd)/../../.dev" \
PORT=9100 \
OP_OPENCODE_URL="http://localhost:4800" \
npm run preview
```

Verify: `curl http://localhost:9100/health` should return `{"status":"ok","service":"admin"}`.

## Running the Stack Tests

```bash
RUN_DOCKER_STACK_TESTS=1 \
OP_UI_LOGIN_PASSWORD=dev-admin-token \
ADMIN_URL=http://127.0.0.1:9100 \
bun run ui:test:e2e
```

Or, using `STACK_ENV_PATH` to auto-build URLs from a stack.env:

```bash
RUN_DOCKER_STACK_TESTS=1 \
OP_UI_LOGIN_PASSWORD=dev-admin-token \
STACK_ENV_PATH=.dev-test/config/stack/stack.env \
bun run ui:test:e2e
```

`global-setup.ts` constructs `ADMIN_URL` from `OP_ADMIN_PORT` and `ASSISTANT_URL` from `OP_ASSISTANT_PORT` in the referenced stack.env if those URL vars are not already set.

All three required env vars for the first form:
- `RUN_DOCKER_STACK_TESTS=1` — gates are skipped by default; this unlocks them
- `OP_UI_LOGIN_PASSWORD=dev-admin-token` — the admin password seeded by `dev-setup.sh` (renamed from `ADMIN_TOKEN` in Phase 2 of the auth/proxy refactor)
- `ADMIN_URL=http://127.0.0.1:9100` — admin host URL (auto-built if `STACK_ENV_PATH` is used)

Expected results (with assistant running):
- `AKM Config API` — tests pass
- `Admin Health Endpoint` — 4 tests, all pass (including `opencode:true`)
- `Connections Tab — Providers` — tests pass (`available:true`)
- `OpenCode Web UI` — tests pass
- `Automation Scheduler` — tests pass
- `Channel -> Guardian -> Assistant Pipeline` — **skipped or partially failing** in dev (see below)

## Verifying the Health Endpoint Manually

```bash
# Should return 401 — no token
curl -i http://localhost:9100/admin/health

# Should return { ok: true, opencode: true } — assistant is running
curl -b "op_session=dev-admin-token" http://localhost:9100/admin/health

# Should return available: true — assistant is reachable
curl -b "op_session=dev-admin-token" http://localhost:9100/admin/providers | jq '.available'
```

## Running against a production stack (ports 8100/3800/8180)

If you need to test against a production instance running on the default ports, pass `ADMIN_URL` explicitly to override:

```bash
RUN_DOCKER_STACK_TESTS=1 \
OP_UI_LOGIN_PASSWORD=your-password \
ADMIN_URL=http://127.0.0.1:8100 \
ASSISTANT_URL=http://localhost:3800 \
OP_GUARDIAN_PORT=8180 \
bun run ui:test:e2e
```

## Known Dev Gaps

### Guardian not host-exposed in default dev stack
`compose.dev.yml` exposes the guardian on `OP_GUARDIAN_PORT` (default `8180`). If you're running the plain dev stack without `compose.dev.yml`, the guardian has no host port. The `channel-guardian-pipeline.pw.ts` tests require the guardian to be reachable from the host.

### OpenCode port vs admin default
The admin UI's `http.ts` defaults to reading `OP_ASSISTANT_PORT` from `process.env`, which is promoted from `stack.env` during startup. When running the admin as a host process in dev, set `OP_OPENCODE_URL=http://localhost:3800` (or 4800 for test stacks) to reach the assistant through its host-side port mapping.

### Mocked contract tests (no stack required)
The mocked e2e suite tests the wizard and admin browser contracts without a running stack:
```bash
bun run ui:test:e2e:mocked
```
These always pass without docker and cover the majority of browser-level route contracts.
