# Rec 3: Docker-Backed Happy-Path Wizard E2E Gate

## Problem

`release.yml` passes green without proving the full install→wizard→`setup.complete`→healthy
runtime path works with real Docker Compose. The critical code path in
`packages/ui/src/routes/setup/complete/+server.ts:23–29` checks
`process.env.OPENPALM_TEST_MODE === '1'` and **skips** `applyStack()` and the
`composeAction('up', [...CoreStartupServices])` call when that flag is set. The Playwright
UI tests at `packages/ui/e2e/10-setup-wizard-ui.pw.ts:26–29` always run with
`OPENPALM_TEST_MODE=1` (set by the test server fixture), so every existing test avoids the
real compose path entirely.

There is no `test/install-e2e/` directory, and no job in `release.yml` exercises the real
wizard flow end-to-end.

**References:**
- `packages/ui/src/routes/setup/complete/+server.ts:23` — `OPENPALM_TEST_MODE` bypass
- `packages/ui/src/routes/command/+server.ts:342–351` — `setup.complete` command (same bypass at line 342)
- `test/docker/docker-stack.docker.ts:31–34` — guard pattern to mirror
- `.github/workflows/release.yml:100–165` — where to add the new job
- `dev/docs/testing-todos.md:141–158` — P3-A source requirement

---

## Part 1: Create `test/install-e2e/happy-path.docker.ts`

### File location

```
test/install-e2e/happy-path.docker.ts
```

This mirrors the existing `test/docker/docker-stack.docker.ts` pattern. The `.docker.ts`
extension is not picked up by `bun test` (which only collects `*.test.ts`), so the test
only runs when invoked explicitly or via the CI job below.

### Guard pattern (mirror lines 31–34 of `docker-stack.docker.ts`)

```typescript
const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe", stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);
const runDockerStackTests = dockerAvailable && Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS !== "0";
```

All `describe` blocks must be wrapped with `describe.skipIf(!runDockerStackTests)`.

### Constants

```typescript
const REPO_ROOT = resolve(import.meta.dir, "../..");
const COMPOSE_BASE = join(REPO_ROOT, "packages/lib/src/embedded/state/docker-compose.yml");
const PROJECT_NAME = "openpalm-install-e2e";
const TIMEOUT = 15_000;
const ADMIN_TOKEN = "test-e2e-wizard-token";   // ≥8 chars, satisfies password validation
const ADMIN_PORT = 18300;                        // Non-conflicting with docker-stack tests (18200)
```

### `beforeAll`: temp dir layout, env files, compose overlay, build, start, wait for health

Follow the same structure as `docker-stack.docker.ts:100–227`. Key points:

1. `mkdtempSync(join(tmpdir(), "openpalm-install-e2e-"))` for full isolation.
2. Create all required subdirectories under `data/`, `config/`, and `state/` (same list as
   `docker-stack.docker.ts:109–119`).
3. Write `state/system.env` containing `ADMIN_TOKEN=<ADMIN_TOKEN>`.
4. Write empty `.env` files for each service state dir.
5. Write a minimal `state/caddy.json` (same static JSON used in `docker-stack.docker.ts:129–143`).
6. Write empty `config/secrets.env`.
7. Write `.env` file for compose interpolation (same keys as `docker-stack.docker.ts:150–165`,
   with `ADMIN_TOKEN=<ADMIN_TOKEN>` and `POSTGRES_PASSWORD=test-pg-password`).
8. Write a compose overlay that:
   - Builds `admin` from `core/admin/Dockerfile` (context `.`)
   - Exposes port `ADMIN_PORT:8100`
   - Mounts the temp dirs as `/data`, `/config`, `/state`
   - Sets `ADMIN_TOKEN`, `COMPOSE_PROJECT_PATH`, `OPENPALM_COMPOSE_FILE`
   - Does **NOT** set `OPENPALM_TEST_MODE` — this is the key difference from Playwright tests
9. Run `docker compose build admin` (no gateway needed for wizard flow).
10. Run `docker compose up -d admin`.
11. `waitForHealth("http://127.0.0.1:<ADMIN_PORT>/health")` with 60 s timeout.

`beforeAll` timeout: `180_000` (3 min, same as existing docker test).

### `afterAll`: tear down containers and remove temp dir

```typescript
afterAll(async () => {
  if (!runDockerStackTests || !tmpDir) return;
  await composeRun("down", "--remove-orphans", "--timeout", "5");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}, 30_000);
```

### Helper functions

Copy `api()`, `authedJson()`, and `waitForHealth()` verbatim from
`docker-stack.docker.ts:57–87`. No need to redefine `cmd()` or `compose()` — the wizard
flow calls specific REST endpoints, not the `/command` bus.

Add a thin `setupPost(path, body)` helper for unauthenticated setup POSTs:

```typescript
function setupPost(path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
}
```

### Test suite: `describe.skipIf(!runDockerStackTests)("install e2e: setup wizard happy path", ...)`

The tests call the same REST endpoints the UI calls. All setup endpoints are accessible
without auth during first-boot from localhost (see `setup/step/+server.ts:16–18`,
`setup/complete/+server.ts:18–20`, etc.).

**Step-by-step API calls and assertions, in order:**

---

#### Test 1: Verify first-boot state

```
GET /setup/status
```

- Assert `resp.status === 200`
- Assert `body.completed === false`
- Assert `body.firstBoot === true`

*Reference: `packages/ui/src/routes/setup/status/+server.ts:7–44`*

---

#### Test 2: Mark Welcome step complete

```
POST /setup/step
Body: { "step": "welcome" }
```

- Assert `resp.status === 200`
- Assert `body.ok === true`
- Assert `body.state.steps.welcome === true`

*Reference: `packages/ui/src/routes/setup/step/+server.ts:20–34`*

---

#### Test 3: Save Profile step (name, email, password)

Use the `/command` endpoint with `setup.profile` because the REST-only path for profile
is wired through the command bus (no dedicated `/setup/profile` route exists).

```
POST /command
Body: {
  "type": "setup.profile",
  "payload": {
    "name": "E2E Test User",
    "email": "e2e@test.local",
    "password": "test-e2e-wizard-token"
  }
}
```

- Assert `resp.status === 200`
- Assert `body.ok === true`
- Assert `body.data.state.profile.name === "E2E Test User"`

Then mark the step complete:

```
POST /setup/step
Body: { "step": "profile" }
```

- Assert `resp.status === 200`

*Reference: `packages/ui/src/routes/command/+server.ts:245–270`*

> **Note on auth:** The `setup.profile` command writes `ADMIN_TOKEN` to
> `RUNTIME_ENV_PATH` (`upsertEnvVar`, line 254). After this call the admin token in the
> running container matches `ADMIN_TOKEN`. The initial token configured at container
> start-time via the `system.env` mount is also `ADMIN_TOKEN`, so they stay in sync.
> Subsequent authenticated calls use `x-admin-token: ADMIN_TOKEN`.

---

#### Test 4: Configure service instances (Anthropic key required during initial setup)

```
POST /command
Body: {
  "type": "setup.service_instances",
  "payload": {
    "anthropicApiKey": "sk-ant-test-key-for-e2e"
  }
}
```

- Assert `resp.status === 200`
- Assert `body.ok === true`

Then mark the step complete:

```
POST /setup/step
Body: { "step": "serviceInstances" }
```

*Reference: `packages/ui/src/routes/command/+server.ts:272–317`*

> **Why Anthropic key is required:** Lines 284–289 enforce that `anthropicApiKey` must be
> provided (or already present in `secrets.env`) during initial setup (`!setupState.completed`).
> Without it the call returns `400 anthropic_key_required`.

---

#### Test 5: Set access scope

```
POST /command
Body: {
  "type": "setup.access_scope",
  "payload": { "scope": "host" }
}
```

- Assert `resp.status === 200`
- Assert `body.ok === true`
- Assert `body.data.accessScope === "host"`

Then mark the step complete:

```
POST /setup/step
Body: { "step": "accessScope" }
```

*Reference: `packages/ui/src/routes/command/+server.ts:227–243`*

> **Note on composeAction:** This command calls `composeAction('up', 'caddy')` (line 240).
> Caddy is not running in the minimal test stack, so this will fail silently (`.catch(() => {})`).
> The command still returns 200 — no assertion failure.

---

#### Test 6: Set channels (empty selection is fine)

```
POST /command
Body: {
  "type": "setup.channels",
  "payload": { "channels": [] }
}
```

- Assert `resp.status === 200`
- Assert `body.ok === true`

Then mark the step complete:

```
POST /setup/step
Body: { "step": "channels" }
```

*Reference: `packages/ui/src/routes/command/+server.ts:318–340`*

---

#### Test 7: Mark Security and HealthCheck steps complete

```
POST /setup/step  →  { "step": "security" }
POST /setup/step  →  { "step": "healthCheck" }
```

Both should return 200 with `body.ok === true`. These are bookkeeping-only steps with no
payload processing.

---

#### Test 8: Call `setup.complete` — real compose path, no test mode flag

```
POST /command
Body: { "type": "setup.complete", "payload": {} }
```

- Assert `resp.status === 200`
- Assert `body.ok === true`
- Assert `body.data.completed === true`

*Reference: `packages/ui/src/routes/command/+server.ts:341–351`*

> **What this exercises:** With `OPENPALM_TEST_MODE` absent (not `"1"`), the real
> `applyStack(stackManager)` path runs (line 344–346). In this minimal test stack only
> the admin service is running; `composeAction('up', [...SetupCoreServices])` will fail
> because the other services are not defined in the test overlay. This means the test
> **must** expect a 500 response from `setup.complete` unless the test overlay also
> includes those services, **or** the assertion is relaxed to accept failure from compose
> while still verifying `completeSetup()` was called.
>
> **Recommended approach:** Assert that `resp.status` is either `200` (if `applyStack`
> succeeds gracefully) **or** that `body.data.completed === true` via a follow-up
> `GET /setup/status` after the attempt. Alternatively, extend the compose overlay to
> include stub definitions for the services referenced by `CoreStartupServices` so
> `composeAction('up', [...])` succeeds. The cleanest approach is the latter — add
> stub no-op service entries to the compose overlay (image: `busybox`, command: `sleep
> infinity`, no ports). This lets `compose up -d` succeed for all listed services.
>
> See the "Compose overlay extension" note in Part 1 below.

---

#### Test 9: Assert `completed: true` after `setup.complete`

```
GET /setup/status
Headers: x-admin-token: <ADMIN_TOKEN>
```

- Assert `resp.status === 200`
- Assert `body.completed === true`
- Assert `body.firstBoot === false`

*Reference: `packages/ui/src/routes/setup/status/+server.ts:10–11` — after completion,
unauthenticated requests to `/setup/status` return 401. So this call must include the token.*

---

#### Test 10: Assert that unauthenticated requests get 401 after setup is complete

```
GET /state    (no token)
GET /secrets  (no token)
```

For each:
- Assert `resp.status === 401`
- Assert `body.ok === false`
- Assert `body.code === "admin_token_required"`

*Reference: `test/docker/docker-stack.docker.ts:268–276` — same assertion pattern*

---

### Compose overlay extension for stub services

To allow `composeAction('up', [...SetupCoreServices])` inside `setup.complete` to
succeed without a full stack, the test compose overlay should add stub entries for each
service in `SetupCoreServices` (`admin`, `caddy`, `assistant`, `gateway`, `openmemory`,
`openmemory-ui`, `postgres`, `qdrant`) that are not otherwise running (`admin` already
exists in the overlay as the real service):

> **Note:** The command bus uses `SetupCoreServices` (`command/+server.ts:47–56`).
> The REST endpoint at `setup/complete/+server.ts:9` uses `CoreStartupServices` —
> the same list. When calling `POST /command` with `type: "setup.complete"`, the
> `SetupCoreServices` constant is used.

```yaml
services:
  admin:
    # ... (real build as above)
  assistant:
    image: busybox
    command: ["sleep", "infinity"]
  gateway:
    image: busybox
    command: ["sleep", "infinity"]
  openmemory:
    image: busybox
    command: ["sleep", "infinity"]
  openmemory-ui:
    image: busybox
    command: ["sleep", "infinity"]
  postgres:
    image: busybox
    command: ["sleep", "infinity"]
  qdrant:
    image: busybox
    command: ["sleep", "infinity"]
  caddy:
    image: busybox
    command: ["sleep", "infinity"]
```

This approach:
- Does not start any real services (busybox `sleep infinity` has no ports, no health checks)
- Satisfies Docker Compose `up -d` for all named services in `SetupCoreServices`
- `busybox` is already available on all CI runners without a pull step

---

### Full file outline

```typescript
/**
 * Install E2E: Setup Wizard Happy-Path
 *
 * Drives the setup wizard API in sequence against a real Docker-built admin
 * container with OPENPALM_TEST_MODE absent (compose apply runs for real).
 * Asserts completed: true and that unauthenticated requests get 401.
 *
 * Run: OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts
 *
 * Requirements: Docker daemon running.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Constants
const REPO_ROOT = resolve(import.meta.dir, "../..");
const COMPOSE_BASE = join(REPO_ROOT, "packages/lib/src/embedded/state/docker-compose.yml");
const PROJECT_NAME = "openpalm-install-e2e";
const TIMEOUT = 15_000;
const ADMIN_TOKEN = "test-e2e-wizard-token";
const ADMIN_PORT = 18300;

// Guard (mirrors docker-stack.docker.ts:31–34)
const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe", stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);
const runDockerStackTests = dockerAvailable && Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS !== "0";

// State
let tmpDir: string;
let envFilePath: string;
let composeTestFile: string;

// Helpers: compose(), composeRun(), waitForHealth(), api(), authedJson(), setupPost()
// ... (see detail above)

beforeAll(async () => { /* ... */ }, 180_000);
afterAll(async () => { /* ... */ }, 30_000);

describe.skipIf(!runDockerStackTests)("install e2e: setup wizard happy path", () => {
  it("GET /setup/status — first-boot state", async () => { /* test 1 */ });
  it("POST /setup/step welcome — marks welcome step complete", async () => { /* test 2 */ });
  it("POST /command setup.profile — saves name, email, password", async () => { /* test 3 */ });
  it("POST /command setup.service_instances — anthropic key required, accepted", async () => { /* test 4 */ });
  it("POST /command setup.access_scope — sets host scope", async () => { /* test 5 */ });
  it("POST /command setup.channels — empty selection accepted", async () => { /* test 6 */ });
  it("POST /setup/step security + healthCheck — bookkeeping steps complete", async () => { /* test 7 */ });
  it("POST /command setup.complete — real compose path, returns ok", async () => { /* test 8 */ });
  it("GET /setup/status (authed) — completed: true, firstBoot: false", async () => { /* test 9 */ });
  it("protected endpoints reject unauthenticated after setup complete", async () => { /* test 10 */ });
});
```

---

## Part 2: Add `setup-wizard-e2e` job to `release.yml`

### Where to insert

Insert the new job after `docker-build` (line 100) and before the `release` job (line 164).
Update the `release` job's `needs:` array to include `setup-wizard-e2e`.

### Exact YAML to add (between lines 160 and 163)

```yaml
  setup-wizard-e2e:
    if: inputs.component == 'platform' || inputs.component == 'admin'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Run install E2E wizard test
        env:
          OPENPALM_RUN_DOCKER_STACK_TESTS: "1"
        run: bun test ./test/install-e2e/happy-path.docker.ts
      - name: Upload admin logs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: install-e2e-admin-logs
          path: /tmp/openpalm-install-e2e-*/
          if-no-files-found: ignore
          retention-days: 7
```

**Why `if: inputs.component == 'platform' || inputs.component == 'admin'`:**
The wizard E2E test builds the admin image. Skipping it for channel-only or CLI releases
(where admin is unchanged) keeps release times reasonable and avoids redundant work.
For `platform` releases, it always runs because any component could affect the setup path.

### Update `release` job `needs:` (line 165)

Change:
```yaml
    needs: [unit-tests, integration, contracts, security, ui, docker-build]
```

To:
```yaml
    needs: [unit-tests, integration, contracts, security, ui, docker-build, setup-wizard-e2e]
```

The `release` job already uses:
```yaml
    if: always() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled')
```

This means if `setup-wizard-e2e` is skipped (e.g. for a CLI release), the `skipped` result
does not count as failure, and the release still proceeds. This is the correct behavior.

### Full diff summary for `release.yml`

- **Insert** the `setup-wizard-e2e` job block (shown above) between line 160 and line 163.
- **Edit** line 165 to add `setup-wizard-e2e` to `needs:`.

---

## Part 3: Add `test:install:smoke` script to `package.json`

Add a script to `package.json` scripts alongside `test:docker` (line 47):

```json
"test:install:smoke": "OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts"
```

This gives developers a named command to run locally without memorizing the env var flag.

---

## How to run the test locally

```bash
# Requires: Docker daemon running, bun installed
OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts

# Or via the package.json script (after adding it):
bun run test:install:smoke
```

Expected duration: 3–8 minutes (image build dominates; subsequent runs are faster if
Docker layer cache is warm).

To skip the test (e.g. in local `bun test` runs), simply don't set the env var. The
`describe.skipIf(!runDockerStackTests)` guard ensures it is silently skipped.

---

## File references

| File | Lines | Notes |
|---|---|---|
| `test/docker/docker-stack.docker.ts` | 31–34 | Guard pattern to mirror |
| `test/docker/docker-stack.docker.ts` | 57–87 | `waitForHealth`, `api`, `authedJson` helpers |
| `test/docker/docker-stack.docker.ts` | 100–227 | `beforeAll` structure to follow |
| `test/docker/docker-stack.docker.ts` | 242 | `describe.skipIf` pattern |
| `test/docker/docker-stack.docker.ts` | 268–276 | Auth rejection assertion pattern |
| `packages/ui/src/routes/setup/status/+server.ts` | 7–44 | `GET /setup/status` response shape |
| `packages/ui/src/routes/setup/step/+server.ts` | 6–35 | `POST /setup/step` handler, valid steps |
| `packages/ui/src/routes/setup/complete/+server.ts` | 11–43 | `POST /setup/complete` REST endpoint |
| `packages/ui/src/routes/command/+server.ts` | 245–270 | `setup.profile` command |
| `packages/ui/src/routes/command/+server.ts` | 272–317 | `setup.service_instances` command (Anthropic key required) |
| `packages/ui/src/routes/command/+server.ts` | 227–243 | `setup.access_scope` command |
| `packages/ui/src/routes/command/+server.ts` | 318–340 | `setup.channels` command |
| `packages/ui/src/routes/command/+server.ts` | 47–56 | `SetupCoreServices` — services that need busybox stubs in the test overlay |
| `packages/ui/src/routes/command/+server.ts` | 341–351 | `setup.complete` command (real compose path, no OPENPALM_TEST_MODE bypass) |
| `packages/lib/src/admin/setup-manager.ts` | 37–65 | `DEFAULT_STATE` — all step names and shape |
| `.github/workflows/release.yml` | 100–165 | `docker-build` job and `release` job (insertion point) |
| `package.json` | 47 | `test:docker` script (pattern for `test:install:smoke`) |

---

## Implementation checklist

1. Create directory `test/install-e2e/`.
2. Create `test/install-e2e/happy-path.docker.ts` with full implementation per Part 1.
3. Verify tests pass locally: `OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts`.
4. Add `test:install:smoke` script to root `package.json` per Part 3.
5. Edit `.github/workflows/release.yml`: insert `setup-wizard-e2e` job and update `release.needs`.
6. Verify the new job only activates for `platform` and `admin` releases and is skipped for others.
7. Verify the `release` job's `always()` + `!contains(needs.*.result, 'failure')` guard still works correctly when `setup-wizard-e2e` is skipped.
