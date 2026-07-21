# Complete OpenPalm Testing Workflow

Testing is organized into 6 tiers, from fastest/simplest to most thorough. Run them in order — each builds on the confidence established by the previous tier.

---

## Prerequisites

Before running any stack tests (Tiers 5+), ensure:

1. **Dev environment is seeded:** `./scripts/dev-setup.sh --seed-env` (seeds the admin password `dev-admin-token` as a file-based secret and tests read it from `OP_UI_LOGIN_PASSWORD` via `scripts/load-test-env.sh`)
2. **Ollama running on host** (required for T6 LLM tests)
3. **Docker running** — T5/T6 rebuild and recreate containers automatically

### Test tier commands

```bash
bun run test:t1   # Type check (svelte-check + SDK)
bun run test:t2   # Non-admin unit tests
bun run test:t3   # Admin unit tests (vitest)
bun run test:t4   # Mocked browser E2E (Playwright)
bun run test:t5   # Integration E2E (rebuilds stack)
bun run test:t6   # Full stack E2E + LLM pipeline (rebuilds stack, no-skip enforced)
```

### T5 vs T6

| | T5 (Integration) | T6 (Full + LLM) |
|---|---|---|
| Stack rebuild | Yes (--build --force-recreate) | Yes (--build --force-recreate) |
| `RUN_DOCKER_STACK_TESTS` | Yes | Yes |
| `RUN_LLM_TESTS` | No | Yes |
| `PW_ENFORCE_NO_SKIP` | No (LLM tests skip gracefully) | Yes (all tests must run) |
| Script | `bun run admin:test:stack` | `bun run admin:test:llm` |

### Standalone E2E commands

| Command | `STACK` | `LLM` | `NO_SKIP` | Use case |
|---|---|---|---|---|
| `bun run admin:test:stack` | 1 | - | - | Stack integration only (LLM tests skip) |
| `bun run admin:test:llm` | 1 | 1 | 1 | Full suite, no skips |
| `bun run admin:test:e2e` | 1 | 1 | 1 | Alias — same as llm |
| `bun run admin:test:e2e:mocked` | - | - | - | Browser contract tests only |

### Why T5/T6 always rebuild containers

Docker `restart` does NOT re-read compose config changes (env_file paths, mount points, environment variables). Only `docker compose up --force-recreate` picks up changes. Since test code changes frequently modify compose configs, env files, and mount paths, the test workflow always rebuilds to avoid stale-container failures.

---

## Tier 1: Type Checking & Linting

**Time:** ~10s | **Prerequisites:** None

```bash
bun run check    # svelte-check + TypeScript
```

Validates type correctness across all SvelteKit admin code.

---

## Tier 2: Non-Admin Unit Tests

**Time:** ~25s | **Prerequisites:** None

```bash
bun run test
```

Runs all non-admin unit tests: lib, cli, guardian, portal adapters, scheduler-related helpers, and admin-tools.

---

## Tier 3: Admin Unit Tests

**Time:** ~5s | **Prerequisites:** None

```bash
bun run admin:test:unit
```

Runs Vitest server + browser component tests for the admin SvelteKit app.

---

## Tier 4: Mocked Browser E2E

**Time:** ~2min | **Prerequisites:** Admin build (`bun run admin:build`)

```bash
bun run admin:test:e2e:mocked
```

Runs Playwright against a built admin app with mocked API endpoints. Tests setup wizard UI and browser contracts without live backend services.

---

## Tier 5: Integration E2E

**Time:** ~5min (includes rebuild) | **Prerequisites:** Docker, dev env seeded

```bash
bun run test:t5
```

Rebuilds and recreates the entire compose stack, then runs integration Playwright tests. LLM-dependent tests are skipped (no `RUN_LLM_TESTS`).

**What it validates:**
- OpenCode web UI accessible
- OpenCode API session management
- Guardian security pipeline (HMAC, replay, rate-limit, content validation) via portal→guardian→assistant
- Scheduler automations API

---

## Tier 6: Full Stack E2E + LLM Pipeline

**Time:** ~5min (includes rebuild) | **Prerequisites:** Docker, dev env seeded, Ollama with models

```bash
bun run test:t6
```

Same as T5 but additionally enables LLM tests and enforces no-skip policy. Every test must run — any skip is a failure.

**Additional validation over T5:**
- Full assistant message pipeline (send message → LLM inference → response)
- Portal→Guardian→Assistant→LLM full chain with real inference

**Model prerequisites:** Ollama with:
- `qwen2.5-coder:3b` or equivalent (system LLM)

---

## Stack-in-Isolation (Manual Setup)

`test:t5`/`test:t6` drive the stack for you. When you need finer control — e.g.
reproducing a stack-test failure by hand, or running against a hand-built
`.dev-test/` tree instead of `.dev/` — start the stack manually on isolated
ports so it never conflicts with a production instance on the same machine.

**Port Isolation:**

| Service | Production defaults | Dev/test ports (`dev-setup.sh`) |
|---|---|---|
| Admin UI (host process) | `3880` | `9100` |
| Assistant (OpenCode) | `3800` → container `4096` | `4800` → container `4096` |
| Guardian | network-only | network-only |

`dev-setup.sh --seed-env` seeds `.dev/knowledge/env/stack.env` with the dev/test ports. `global-setup.ts` reads that file before tests run and auto-constructs `ADMIN_URL` and `ASSISTANT_URL`, so tests automatically target the correct stack with no extra env vars needed.

Tests read port configuration in this priority order:
1. Explicit env vars (`ADMIN_URL`, `ASSISTANT_URL`)
2. `STACK_ENV_PATH` — path to a `stack.env`; `global-setup.ts` builds `ADMIN_URL`/`ASSISTANT_URL` from `OP_HOST_UI_PORT`/`OP_ASSISTANT_PORT` found there
3. Hardcoded test defaults: 9100 / 4800 (match dev-setup.sh)

**Seed a test `.dev-test/` directory:**

```bash
mkdir -p .dev-test/config/stack
mkdir -m 700 -p .dev-test/knowledge/secrets
cat > .dev-test/knowledge/env/stack.env <<'EOF'
OP_HOME=.dev-test
OP_UID=$(id -u)
OP_GID=$(id -g)
OP_DOCKER_SOCK=/var/run/docker.sock
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev
OP_ASSISTANT_PORT=4800
OP_HOST_UI_PORT=9100
OP_SETUP_COMPLETE=true
EOF
chmod 600 .dev-test/knowledge/env/stack.env
printf '%s\n' 'dev-admin-token' > .dev-test/knowledge/secrets/op_ui_login_password
chmod 600 .dev-test/knowledge/secrets/op_ui_login_password
```

Or use the dev-setup script (which seeds `.dev/` with dev ports) and manually adjust ports, or start the compose stack with explicit port env vars.

**Start the Docker stack (assistant + guardian):**

Managed compose files live under `.dev/system/stack/`; `.dev/config/stack/`
contains only the user-owned `custom.compose.yml` overlay.

```bash
bun run dev:build
# or with test ports:
OP_ASSISTANT_PORT=4800 \
docker compose --project-directory . \
  -f .dev/system/stack/core.compose.yml \
  -f .dev/system/stack/services.compose.yml \
  -f .dev/system/stack/portals.compose.yml \
  -f .dev/config/stack/custom.compose.yml \
  -f compose.dev.yml \
  --env-file .dev/knowledge/env/stack.env \
  --project-name openpalm-test \
  up -d
```

Verify: `docker ps | grep openpalm-test` should show assistant (healthy) and guardian. From there, start the admin UI host process (`OP_HOME=.dev-test PORT=9100 npm run preview` from `packages/ui`) and point `ADMIN_URL`/`ASSISTANT_URL` at the ports above.

---

## Quick Reference

| Tier | Time | Command | Coverage |
|------|------|---------|----------|
| T1 | ~10s | `bun run test:t1` | Types + SDK |
| T2 | ~25s | `bun run test:t2` | All non-admin unit tests |
| T3 | ~5s | `bun run test:t3` | Admin unit tests |
| T4 | ~2min | `bun run test:t4` | Mocked browser E2E |
| T5 | ~5min | `bun run test:t5` | Integration E2E (stack rebuild) |
| T6 | ~5min | `bun run test:t6` | Full E2E + LLM (no skips) |

## Recommended Local Workflow

```bash
# 1. Quick validation (always before committing)
bun run check && bun run test && bun run admin:test:unit

# 2. Mocked browser contracts (before pushing UI changes)
bun run admin:test:e2e:mocked

# 3. Stack integration (before pushing stack/compose changes)
bun run test:t5

# 4. Full validation (before releases or LLM-touching changes)
bun run test:t6

# 5. Clean-slate validation (before releases)
./scripts/dev-e2e-test.sh
```
