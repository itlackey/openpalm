# R7: Extract API tests from Playwright into `bun:test`

## Problem

Nine of the eleven Playwright E2E test files (`packages/ui/e2e/*.pw.ts`) make
pure HTTP API calls using Playwright's `APIRequestContext` and never touch a
browser page. Running them through Playwright adds unnecessary overhead:

- They require `bunx playwright install --with-deps chromium` in CI even though
  they never open a browser.
- They share a single sequential webServer lifecycle managed by
  `playwright.config.ts`, preventing independent parallel execution.
- They use Playwright-specific APIs (`request.get`, `request.post`,
  `expect(res.status()).toBe(...)`) that map directly to native `fetch()` and
  `bun:test` `expect()` with no loss of expressiveness.
- The test ordering (01, 02, 03 ...) creates implicit coupling between files --
  for example, 04-stack-api depends on setup being completed in 03-setup-api.

Only two files actually exercise browser UI through `page`:

- `09-dashboard-ui.pw.ts` -- page navigation and DOM assertions
- `10-setup-wizard-ui.pw.ts` -- multi-step wizard flow with route interception

These belong in Playwright. Everything else should be `bun:test` integration
tests using native `fetch()`.

---

## Inventory of files to migrate

| # | Current file | Tests | What it covers |
|---|---|---|---|
| 01 | `01-health-meta.pw.ts` | 3 | `GET /health`, `GET /meta`, `GET /setup/status` (no auth) |
| 02 | `02-auth.pw.ts` | 8 | Auth rejection on 6 protected paths, wrong token, correct token |
| 03 | `03-setup-api.pw.ts` | 20 | Full setup wizard API flow: steps, profile, service-instances, channels, access-scope, complete; file verification (compose, caddy, env files) |
| 04 | `04-stack-api.pw.ts` | 4 | `GET /stack/spec`, `GET /state`, `stack.spec.set` command, invalid secret ref rejection |
| 05 | `05-secrets-api.pw.ts` | 5 | `GET /secrets`, `secret.upsert`, `GET /secrets/raw`, `secret.raw.set`, `secret.delete` |
| 06 | `06-automations-api.pw.ts` | 6 | `GET /automations`, create/update/delete automation, invalid cron, core automation delete protection |
| 07 | `07-channels-api.pw.ts` | 3 | `GET /channels`, `GET /installed`, `GET /snippets` |
| 08 | `08-command-api.pw.ts` | 5 | Command endpoint: unauthenticated local setup, `setup.step`, `stack.render`, `setup.complete`, unknown command |
| 11 | `11-container-automation-management-api.pw.ts` | 2 | `GET /containers` exclusion list, `GET /automations/history` |

**Total: 9 files, 56 tests to migrate**

### Files to keep in Playwright (unchanged)

| # | File | Tests | Reason |
|---|---|---|---|
| 09 | `09-dashboard-ui.pw.ts` | 6 | Uses `page` for DOM assertions |
| 10 | `10-setup-wizard-ui.pw.ts` | 8 | Uses `page` for wizard flow, route mocking, screenshots |

---

## Architecture for new `bun:test` integration tests

### Directory structure

```
packages/ui/
  e2e/                              # Playwright-only (UI tests)
    09-dashboard-ui.pw.ts           # kept
    10-setup-wizard-ui.pw.ts        # kept
    env.ts                          # kept (used by PW config and UI tests)
    helpers.ts                      # kept (used by UI tests)
    start-webserver.cjs             # kept (used by PW config)
    global-teardown.ts              # kept (used by PW config)
  test/
    api/                            # New bun:test API integration tests
      helpers.ts                    # Shared server helper + fetch wrappers
      01-health-meta.test.ts
      02-auth-api.test.ts
      03-setup-api.test.ts
      04-stack-api.test.ts
      05-secrets-api.test.ts
      06-automations-api.test.ts
      07-channels-api.test.ts
      08-command-api.test.ts
      11-container-automation-management-api.test.ts
```

### Shared server helper (`packages/ui/test/api/helpers.ts`)

This module provides:

1. **`startServer()`** -- builds and starts the SvelteKit server
   programmatically with an isolated temp directory (reusing the
   `createTempDir` + `webServerEnv` pattern from `e2e/env.ts`)
2. **`stopServer()`** -- kills the server process and cleans up the temp dir
3. **`authedGet()` / `authedPost()` / `cmd()`** -- fetch wrappers equivalent
   to the Playwright helpers, but using native `fetch()`
4. **`BASE_URL`** -- dynamically assigned `http://localhost:<port>`

```typescript
// packages/ui/test/api/helpers.ts
import { describe, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const UI_ROOT = resolve(import.meta.dir, "../..");

export const ADMIN_TOKEN = "test-token-e2e";
// Use a different port from Playwright (13456) to allow parallel runs
let port = 13500;

export function getBaseUrl(): string {
  return `http://localhost:${port}`;
}

export function createTempDir(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "openpalm-api-test-"));

  const dataDir = join(tmpDir, "data", "admin");
  const configDir = join(tmpDir, "config");
  const stateRoot = join(tmpDir, "state");
  const cronDir = join(tmpDir, "cron");
  const opencodeDir = join(tmpDir, "data", "assistant", ".config", "opencode");
  const gatewayDir = join(stateRoot, "gateway");
  const openmemoryDir = join(stateRoot, "openmemory");
  const postgresDir = join(stateRoot, "postgres");
  const qdrantDir = join(stateRoot, "qdrant");
  const assistantDir = join(stateRoot, "assistant");

  for (const d of [
    dataDir, configDir, stateRoot, cronDir, opencodeDir,
    gatewayDir, openmemoryDir, postgresDir, qdrantDir, assistantDir
  ]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(join(configDir, "secrets.env"), "", "utf8");
  writeFileSync(join(stateRoot, ".env"), "", "utf8");
  writeFileSync(join(stateRoot, "system.env"), "", "utf8");
  writeFileSync(join(gatewayDir, ".env"), "", "utf8");
  writeFileSync(join(openmemoryDir, ".env"), "", "utf8");
  writeFileSync(join(postgresDir, ".env"), "", "utf8");
  writeFileSync(join(qdrantDir, ".env"), "", "utf8");
  writeFileSync(join(assistantDir, ".env"), "", "utf8");
  writeFileSync(join(opencodeDir, "opencode.json"), '{\n  "plugin": []\n}\n', "utf8");

  return tmpDir;
}

export function buildWebServerEnv(tmpDir: string): Record<string, string> {
  const configDir = join(tmpDir, "config");
  const stateRoot = join(tmpDir, "state");

  return {
    PORT: String(port),
    ORIGIN: `http://localhost:${port}`,
    ADMIN_TOKEN,
    DATA_DIR: join(tmpDir, "data", "admin"),
    OPENPALM_DATA_ROOT: join(tmpDir, "data"),
    OPENPALM_STATE_ROOT: stateRoot,
    OPENPALM_CONFIG_ROOT: configDir,
    OPENCODE_CONFIG_PATH: join(tmpDir, "data", "assistant", ".config", "opencode", "opencode.json"),
    SECRETS_ENV_PATH: join(configDir, "secrets.env"),
    STACK_SPEC_PATH: join(configDir, "openpalm.yaml"),
    RUNTIME_ENV_PATH: join(stateRoot, ".env"),
    SYSTEM_ENV_PATH: join(stateRoot, "system.env"),
    COMPOSE_FILE_PATH: join(stateRoot, "docker-compose.yml"),
    CADDY_JSON_PATH: join(stateRoot, "caddy.json"),
    GATEWAY_ENV_PATH: join(stateRoot, "gateway", ".env"),
    OPENMEMORY_ENV_PATH: join(stateRoot, "openmemory", ".env"),
    POSTGRES_ENV_PATH: join(stateRoot, "postgres", ".env"),
    QDRANT_ENV_PATH: join(stateRoot, "qdrant", ".env"),
    ASSISTANT_ENV_PATH: join(stateRoot, "assistant", ".env"),
    COMPOSE_PROJECT_PATH: stateRoot,
    OPENPALM_COMPOSE_FILE: "docker-compose.yml",
    CRON_DIR: join(tmpDir, "cron"),
    OPENPALM_COMPOSE_BIN: "/usr/bin/true",
  };
}

// The server process and temp dir for the current test suite
let serverProcess: ChildProcess | null = null;
let tmpDir: string | null = null;

export async function startServer(): Promise<string> {
  // Build the SvelteKit app
  const buildResult = spawnSync("bun", ["run", "build"], {
    cwd: UI_ROOT,
    stdio: "pipe",
  });
  if (buildResult.status !== 0) {
    throw new Error(
      `SvelteKit build failed: ${buildResult.stderr?.toString()}`
    );
  }

  tmpDir = createTempDir();
  const env = buildWebServerEnv(tmpDir);

  // Start the server
  serverProcess = spawn("bun", [join(UI_ROOT, "build", "index.js")], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });

  // Wait for server to be ready
  const baseUrl = getBaseUrl();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) return tmpDir;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start within 30s");
}

export function stopServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

export function getTmpDir(): string {
  if (!tmpDir) throw new Error("Server not started; call startServer() first");
  return tmpDir;
}

// ── Fetch wrappers ────────────────────────────────────────────

const AUTH_HEADERS: Record<string, string> = {
  "x-admin-token": ADMIN_TOKEN,
  "content-type": "application/json",
};

export async function authedGet(path: string): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, { headers: AUTH_HEADERS });
}

export async function authedPost(path: string, data: unknown): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify(data),
  });
}

export async function cmd(type: string, payload: Record<string, unknown> = {}): Promise<Response> {
  return authedPost("/command", { type, payload });
}

export async function rawGet(path: string): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`);
}
```

### Key design decisions

1. **Each test file is independently runnable.** Tests that depend on prior
   state (e.g. 04-stack-api needs setup complete) include their own
   `beforeAll` that drives setup to completion via the API. This eliminates
   implicit ordering.

2. **One shared server per file.** Each test file calls `startServer()` in
   `beforeAll` and `stopServer()` in `afterAll`. The server build is cached
   by Vite (only the first file pays the build cost; subsequent files reuse
   `build/`).

3. **Unique ports per file.** Each file uses a different port (13500, 13501,
   ...) so bun can run files in parallel if desired.

4. **Temp dir per file.** Each server gets its own temp directory, ensuring
   complete isolation. The temp dir is cleaned up in `afterAll`.

5. **Native fetch().** All HTTP calls use the global `fetch()` available in
   Bun, with `bun:test` `expect()` for assertions. No Playwright dependency.

---

## Step-by-step migration instructions

### Step 0: Create directory and shared helper

Create `packages/ui/test/api/` directory and the `helpers.ts` file as shown
above.

### Step 1: Migrate `01-health-meta.pw.ts` (3 tests)

Create `packages/ui/test/api/01-health-meta.test.ts`:

- Import `describe, expect, it, beforeAll, afterAll` from `"bun:test"`
- Import `startServer, stopServer, rawGet, getBaseUrl` from `./helpers.ts`
- `beforeAll` calls `startServer()`
- `afterAll` calls `stopServer()`
- Convert each test:
  - `request.get('/health')` becomes `rawGet('/health')`
  - `res.status()` becomes `res.status`
  - `res.json()` stays the same
  - `expect(res.status()).toBe(200)` becomes `expect(res.status).toBe(200)`

This file needs no prior setup state -- it tests unauthenticated endpoints.

### Step 2: Migrate `02-auth.pw.ts` (8 tests)

Create `packages/ui/test/api/02-auth-api.test.ts`:

- Same lifecycle pattern (beforeAll/afterAll)
- Loop over protected paths and assert 401 without token
- Assert 401 with wrong token
- Assert 200 with correct token
- All requests use `fetch()` with appropriate headers

This file needs no prior setup state -- auth rejection works regardless of
setup status.

### Step 3: Migrate `03-setup-api.pw.ts` (20 tests)

Create `packages/ui/test/api/03-setup-api.test.ts`:

- Same lifecycle pattern
- Tests run sequentially within the describe block (bun:test default)
- Convert all `authedPost`/`authedGet`/`cmd` calls to use the helper-module
  versions
- The file-verification tests (lines 132-197) use `existsSync`/`readFileSync`
  on `getTmpDir()` instead of the imported `TMP_DIR`
- **Important:** This file's tests are inherently sequential (each step builds
  on prior state). Keep them in a single `describe` block.

### Step 4: Migrate `04-stack-api.pw.ts` (4 tests)

Create `packages/ui/test/api/04-stack-api.test.ts`:

- Same lifecycle pattern
- **Requires setup to be completed first.** Add a `beforeAll` that runs the
  minimal setup sequence via API calls (call the setup steps + complete).
  Extract this into a shared helper function
  `runMinimalSetup()` in `helpers.ts`:

```typescript
export async function runMinimalSetup(): Promise<void> {
  await authedPost("/setup/step", { step: "welcome" });
  await cmd("setup.profile", { name: "Test", email: "test@example.com" });
  await authedPost("/setup/step", { step: "profile" });
  await authedPost("/setup/service-instances", {
    openmemory: "http://test:8765", psql: "", qdrant: ""
  });
  await authedPost("/setup/step", { step: "serviceInstances" });
  await authedPost("/setup/step", { step: "security" });
  await authedPost("/setup/channels", {
    channels: ["channel-chat"],
    channelConfigs: { "channel-chat": { CHAT_INBOUND_TOKEN: "test-token" } }
  });
  await authedPost("/setup/step", { step: "channels" });
  await authedPost("/setup/access-scope", { scope: "host" });
  await authedPost("/setup/step", { step: "healthCheck" });
  await authedPost("/setup/complete", {});
}
```

- Convert Playwright assertions to `bun:test` assertions

### Step 5: Migrate `05-secrets-api.pw.ts` (5 tests)

Create `packages/ui/test/api/05-secrets-api.test.ts`:

- Same lifecycle + `runMinimalSetup()` in beforeAll
- Convert `AUTH_HEADERS` usage: for raw endpoint calls, use
  `fetch(url, { headers: { "x-admin-token": ADMIN_TOKEN } })`
- `res.text()` stays the same

### Step 6: Migrate `06-automations-api.pw.ts` (6 tests)

Create `packages/ui/test/api/06-automations-api.test.ts`:

- Same lifecycle + `runMinimalSetup()` in beforeAll
- The `createdId` variable pattern translates directly
- Type annotations on `find()` callbacks stay the same

### Step 7: Migrate `07-channels-api.pw.ts` (3 tests)

Create `packages/ui/test/api/07-channels-api.test.ts`:

- Same lifecycle + `runMinimalSetup()` in beforeAll
- Simple GET assertions

### Step 8: Migrate `08-command-api.pw.ts` (5 tests)

Create `packages/ui/test/api/08-command-api.test.ts`:

- Same lifecycle + `runMinimalSetup()` in beforeAll
- The `test.skip()` calls from Playwright become conditional `return`
  statements or bun:test `it.skipIf()`
- The unauthenticated local request test sends `x-forwarded-for: 127.0.0.1`
  via fetch headers

### Step 9: Migrate `11-container-automation-management-api.pw.ts` (2 tests)

Create `packages/ui/test/api/11-container-automation-management-api.test.ts`:

- Same lifecycle + `runMinimalSetup()` in beforeAll
- Simple GET/POST assertions

---

## Updating Playwright config

### Changes to `packages/ui/playwright.config.ts`

No structural changes needed. The config already uses `testMatch: '**/*.pw.ts'`
and `testDir: 'e2e'`. Once the API `*.pw.ts` files are deleted from `e2e/`,
Playwright will only find the two UI test files.

### Files to delete from `packages/ui/e2e/`

After migration and verification:

```
packages/ui/e2e/01-health-meta.pw.ts
packages/ui/e2e/02-auth.pw.ts
packages/ui/e2e/03-setup-api.pw.ts
packages/ui/e2e/04-stack-api.pw.ts
packages/ui/e2e/05-secrets-api.pw.ts
packages/ui/e2e/06-automations-api.pw.ts
packages/ui/e2e/07-channels-api.pw.ts
packages/ui/e2e/08-command-api.pw.ts
packages/ui/e2e/11-container-automation-management-api.pw.ts
```

### Files to keep in `packages/ui/e2e/` (unchanged)

```
packages/ui/e2e/09-dashboard-ui.pw.ts
packages/ui/e2e/10-setup-wizard-ui.pw.ts
packages/ui/e2e/env.ts                    # still used by UI tests + PW config
packages/ui/e2e/helpers.ts                # still used by UI tests
packages/ui/e2e/start-webserver.cjs       # still used by PW config
packages/ui/e2e/global-teardown.ts        # still used by PW config
packages/ui/playwright.config.ts          # no changes needed
```

---

## Files to create

| File | Purpose |
|---|---|
| `packages/ui/test/api/helpers.ts` | Shared server lifecycle, temp dir, fetch wrappers |
| `packages/ui/test/api/01-health-meta.test.ts` | Health and meta endpoint tests |
| `packages/ui/test/api/02-auth-api.test.ts` | Auth rejection tests |
| `packages/ui/test/api/03-setup-api.test.ts` | Setup wizard API tests |
| `packages/ui/test/api/04-stack-api.test.ts` | Stack spec operation tests |
| `packages/ui/test/api/05-secrets-api.test.ts` | Secrets CRUD tests |
| `packages/ui/test/api/06-automations-api.test.ts` | Automations CRUD tests |
| `packages/ui/test/api/07-channels-api.test.ts` | Channels, installed, snippets tests |
| `packages/ui/test/api/08-command-api.test.ts` | Command endpoint tests |
| `packages/ui/test/api/11-container-automation-management-api.test.ts` | Container + automation management tests |

## Files to delete

| File | Reason |
|---|---|
| `packages/ui/e2e/01-health-meta.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/02-auth.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/03-setup-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/04-stack-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/05-secrets-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/06-automations-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/07-channels-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/08-command-api.pw.ts` | Migrated to bun:test |
| `packages/ui/e2e/11-container-automation-management-api.pw.ts` | Migrated to bun:test |

## Files to modify

| File | Change |
|---|---|
| `packages/ui/package.json` | Add `test:api` script: `bun test test/api/`; update `test` script to include `test:api` |
| `.github/workflows/test-ui.yml` | Add a `bun-api` job that runs `bun test test/api/` in `packages/ui` (no Playwright/Chromium install needed) |
| `package.json` (root) | Optionally add `test:ui:api` script for convenience |

---

## Package.json script changes

### `packages/ui/package.json`

```diff
  "scripts": {
    ...
+   "test:api": "bun test test/api/",
-   "test": "bun run test:unit -- --run && bun run test:e2e",
+   "test": "bun run test:unit -- --run && bun run test:api && bun run test:e2e",
    "test:e2e": "playwright test"
  },
```

### `.github/workflows/test-ui.yml`

Add a new job that does not install Chromium:

```yaml
  bun-api:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
        working-directory: .
      - name: Build SvelteKit app
        run: bun run build
        working-directory: packages/ui
      - name: Run API integration tests
        run: bun test test/api/
        working-directory: packages/ui
```

---

## Migration pattern: Playwright to bun:test cheat sheet

| Playwright | bun:test |
|---|---|
| `import { test, expect } from '@playwright/test'` | `import { describe, expect, it, beforeAll, afterAll } from "bun:test"` |
| `test('name', async ({ request }) => { ... })` | `it('name', async () => { ... })` |
| `test.describe('group', () => { ... })` | `describe('group', () => { ... })` |
| `request.get('/path')` | `fetch(\`\${BASE}/path\`)` or `rawGet('/path')` |
| `request.post('/path', { headers, data })` | `fetch(\`\${BASE}/path\`, { method: 'POST', headers, body: JSON.stringify(data) })` |
| `res.status()` | `res.status` |
| `res.json()` | `res.json()` (same) |
| `res.text()` | `res.text()` (same) |
| `expect(res.status()).toBe(200)` | `expect(res.status).toBe(200)` |
| `test.skip(condition, reason)` | `it.skipIf(condition)('name', ...)` or early `return` |

---

## Verification steps

### 1. Run new bun:test API tests locally

```bash
cd packages/ui
bun run build
bun test test/api/
```

All 56 tests should pass.

### 2. Run each file independently

```bash
cd packages/ui
bun test test/api/01-health-meta.test.ts
bun test test/api/04-stack-api.test.ts
bun test test/api/11-container-automation-management-api.test.ts
```

Each file must pass in isolation (no dependency on other files running first).

### 3. Run remaining Playwright tests

```bash
cd packages/ui
bunx playwright test
```

Only 09 and 10 should run. Both should pass. Confirm the test count dropped
from ~70 to ~14.

### 4. Verify CI workflows

- Push to a branch and confirm the `test-ui` workflow passes.
- The new `bun-api` job should pass without installing Chromium.
- The `playwright` job should pass with only the two UI test files.

### 5. Delete Playwright API files

Only after all new tests pass and CI is green, delete the nine `.pw.ts` API
files from `packages/ui/e2e/`.

### 6. Full regression

```bash
# From repo root
bun run test:ci
```

All existing tests should continue to pass.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| SvelteKit build takes too long per file | Build once in CI before running tests; bun:test `beforeAll` in each file will detect existing `build/` and only start the server |
| Port conflicts if tests run in parallel | Each test file uses a distinct port (13500+) |
| Tests depend on sequential execution | Each file runs its own setup in `beforeAll`; no cross-file dependencies |
| `helpers.ts` duplicates `e2e/env.ts` logic | Intentional -- the two helpers serve different runtimes (Playwright vs bun:test); shared constants (ADMIN_TOKEN) could be extracted to a common module later |
| Removing API tests breaks Playwright coverage reports | The coverage gap is filled by the bun:test suite, which provides equivalent coverage without the Playwright overhead |
