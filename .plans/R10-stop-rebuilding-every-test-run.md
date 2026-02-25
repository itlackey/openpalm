# Implementation Plan: R10 -- Stop Rebuilding on Every Test Run

## Problem

Every Playwright E2E test run triggers a full `vite build` of the SvelteKit UI
before serving the built artifact. This happens because `start-webserver.cjs`
unconditionally runs `bun run build` (a synchronous `spawnSync`) as its first
action, then starts the Node server from `build/index.js`.

The build takes significant time (SvelteKit + Vite + adapter-node + Bun/YAML
shim transforms + SSR bundling) and is wasted when:

- Source files have not changed since the last build
- Multiple sequential Playwright runs happen during local development
- CI already has a clean checkout where nothing has changed between build and test

This adds unnecessary latency to both local iteration and CI pipeline duration.

---

## Current Build Chain Analysis

### File flow

```
playwright.config.ts
  └── webServer.command = "node e2e/start-webserver.cjs"
        └── start-webserver.cjs
              ├── spawnSync("bun", ["run", "build"])    ← UNCONDITIONAL full build
              │     └── vite build (SvelteKit adapter-node)
              │           └── writes to packages/ui/build/
              └── spawn("bun", ["build/index.js"])      ← starts production server
```

### Key files

| File | Role |
|---|---|
| `packages/ui/e2e/start-webserver.cjs` | Orchestrates build + serve; the rebuild problem lives here |
| `packages/ui/e2e/start-webserver-for-ci.mjs` | Thin wrapper that calls `start-webserver.cjs` with `webServerEnv()` env vars; used nowhere in CI currently |
| `packages/ui/playwright.config.ts` | Playwright config; `webServer.command` points to `start-webserver.cjs` |
| `packages/ui/e2e/env.ts` | Provides `PORT`, `ADMIN_TOKEN`, and `webServerEnv()` for the test server |
| `packages/ui/package.json` | `"build": "vite build"`, `"dev": "vite dev"`, `"preview": "vite preview"` |
| `packages/ui/svelte.config.js` | SvelteKit config with `adapter-node` |
| `packages/ui/vite.config.ts` | Vite config with custom plugins (bunShim, yamlTextImport) and SSR settings |
| `.github/workflows/test-ui.yml` | CI workflow with `playwright` job; runs `bun run test:ui` |
| `.github/workflows/release.yml` | Release workflow; calls `test-ui.yml` via `workflow_call` |
| `package.json` (root) | `"test:ui": "cd packages/ui && bunx playwright test"` |

### CI execution path (`.github/workflows/test-ui.yml`, playwright job)

```
1. actions/checkout@v4
2. oven-sh/setup-bun@v2
3. bun install --frozen-lockfile
4. bunx playwright install --with-deps chromium
5. bun run test:ui
     └── cd packages/ui && bunx playwright test
           └── playwright reads playwright.config.ts
                 └── webServer.command = "node e2e/start-webserver.cjs"
                       └── spawnSync("bun", ["run", "build"])   ← THE PROBLEM
                       └── spawn("bun", ["build/index.js"])
```

There is no separate build step; the build is embedded inside the test server
startup script. Every test run rebuilds from scratch.

---

## Option Evaluation

### Option A: Pre-build in CI, serve from existing artifact

**Approach:** Add an explicit `bun run build` step in CI before Playwright runs.
Modify `start-webserver.cjs` to skip the build when a `SKIP_BUILD` env var is
set (or when `build/index.js` already exists).

**Pros:**
- Build is explicit and visible in CI logs (separate step with its own timing)
- Build artifact could be cached across workflow runs using `actions/cache`
- Playwright job only pays the build cost once even if retried
- Simple to implement: one env var check in `start-webserver.cjs`

**Cons:**
- Requires CI workflow change (add a step)
- Local developers must remember to either build first or rely on the fallback
- Two code paths (skip vs. build) need to both work correctly

### Option B: Use Vite dev mode for local test runs

**Approach:** Change the webServer command to run `vite dev` (or `bun run dev`)
instead of building and serving from `build/`. Use an env var or separate
Playwright config to switch modes.

**Pros:**
- Fastest local feedback loop (no build step at all; Vite HMR)
- Matches how developers already work (`bun run dev`)
- No build artifacts to manage

**Cons:**
- Dev mode behavior differs from production (adapter-node): SSR rendering,
  module resolution, error handling all differ
- Vite dev server startup is itself non-trivial with the custom plugins
  (bunShim, yamlTextImport, SSR noExternal settings)
- Tests may pass in dev mode but fail in production mode (false confidence)
- Playwright `webServer.port` readiness detection works differently with Vite dev
- The existing E2E tests test the production-built artifact, which is what gets
  deployed in Docker. Switching to dev mode changes what is being tested.

### Option C: Cache the build and only rebuild on source changes

**Approach:** Modify `start-webserver.cjs` to check whether the existing
`build/` directory is newer than all source files. Skip the build if so.

**Pros:**
- Fully automatic: no env vars, no CI changes
- Works identically for local devs and CI
- Still tests the production build artifact

**Cons:**
- File timestamp comparison is fragile (git checkout resets mtimes)
- Implementing a reliable "source changed?" check is complex
- In CI, fresh checkout always has uniform timestamps, making mtime unreliable
- Would need a hash-based approach (e.g., hash `src/` tree and compare to stored hash),
  which adds complexity for marginal benefit over Option A

---

## Recommended Approach: Option A (pre-build + skip flag)

Option A is the best fit for this project because:

1. **Simplicity** -- One env var and a 3-line guard in `start-webserver.cjs`. The
   project guidelines explicitly prioritize simplicity.
2. **Tests the real artifact** -- Unlike Option B, the E2E tests still run against
   the production adapter-node build, matching what ships in Docker.
3. **CI optimization is explicit** -- A visible `bun run build` step in the
   workflow makes build time measurable and cacheable. No magic heuristics.
4. **Local dev gets a bonus** -- Developers who run `bun run build` once can then
   run `SKIP_BUILD=1 bunx playwright test` repeatedly without rebuilding. Those
   who do not set the flag get the current behavior (safe default).
5. **No fragile heuristics** -- Unlike Option C, there is no timestamp/hash
   comparison that can silently go wrong.

Additionally, we incorporate the best part of Option C by adding an optional
`actions/cache` step for the `build/` directory in CI, keyed on a hash of
the source files. This means CI only rebuilds when source actually changes.

---

## Step-by-Step Implementation

### Step 1: Modify `start-webserver.cjs` to support `SKIP_BUILD`

**File:** `packages/ui/e2e/start-webserver.cjs`

Replace the unconditional build with a conditional check:

```javascript
const { spawnSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

// Skip build if SKIP_BUILD is set and build/index.js already exists.
// This lets CI pre-build once and run Playwright without rebuilding.
const skipBuild = process.env.SKIP_BUILD === "1" && existsSync("build/index.js");

if (!skipBuild) {
	const buildResult = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
	if (buildResult.status !== 0) {
		process.exit(buildResult.status);
	}
}

const server = spawn("bun", ["build/index.js"], { stdio: "inherit" });
const stopServer = () => {
	if (!server.killed) server.kill("SIGTERM");
};
process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);
server.on("exit", (code) => {
	process.off("SIGINT", stopServer);
	process.off("SIGTERM", stopServer);
	process.exit(code ?? 1);
});
```

Key design decisions:
- `SKIP_BUILD=1` alone is not enough; `build/index.js` must also exist. This
  prevents a broken run if someone sets the env var without building first.
- If `SKIP_BUILD` is unset or `build/index.js` is missing, the current behavior
  is preserved exactly. This is the safe default.
- No changes to `start-webserver-for-ci.mjs` are needed; it delegates to
  `start-webserver.cjs` which now respects the env var.

### Step 2: Update the CI workflow to pre-build

**File:** `.github/workflows/test-ui.yml`

Add a build step before the Playwright run in the `playwright` job, and pass
`SKIP_BUILD=1` to the test command so the webserver script skips rebuilding:

```yaml
  playwright:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
        working-directory: .
      - run: bunx playwright install --with-deps chromium
        working-directory: packages/ui

      # Pre-build the UI once; Playwright webserver will reuse this artifact
      - name: Build UI
        run: bun run build
        working-directory: packages/ui

      - name: Run Playwright tests
        run: bun run test:ui
        env:
          SKIP_BUILD: "1"

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: packages/ui/playwright-report/
          retention-days: 7
```

Changes:
- New step "Build UI" runs `bun run build` in `packages/ui/`
- Existing `bun run test:ui` step gets `SKIP_BUILD: "1"` env var
- Test timeout stays at 15 minutes (build step is now separate and visible)

### Step 3 (Optional): Add build caching in CI

For additional CI speedup on PRs where the UI source has not changed, add a
cache step keyed on the source hash. This is optional and can be added later.

```yaml
      # Cache the Vite build output
      - name: Cache UI build
        id: ui-build-cache
        uses: actions/cache@v4
        with:
          path: packages/ui/build
          key: ui-build-${{ hashFiles('packages/ui/src/**', 'packages/ui/svelte.config.js', 'packages/ui/vite.config.ts', 'packages/lib/src/**') }}

      - name: Build UI
        if: steps.ui-build-cache.outputs.cache-hit != 'true'
        run: bun run build
        working-directory: packages/ui
```

This caches `packages/ui/build/` and only rebuilds when source files change.
The cache key includes `packages/lib/src/**` because the UI imports from
`@openpalm/lib` via aliases in `svelte.config.js`.

### Step 4: Update `webServerEnv()` to pass through `SKIP_BUILD`

**File:** `packages/ui/e2e/env.ts`

The `webServerEnv()` function returns a fixed set of env vars for the webserver
process. Since `start-webserver.cjs` reads `process.env.SKIP_BUILD` directly
(not from the webServerEnv map), and Playwright's `webServer.env` is merged
with `process.env` by default via the `env` spread, no change is strictly
required here.

However, if `webServerEnv()` is used to fully replace the environment (which
`start-webserver-for-ci.mjs` does with `{ ...process.env, ...webServerEnv() }`),
then `SKIP_BUILD` from the outer `process.env` will naturally be inherited.

**No changes needed** to `env.ts`.

---

## Files to Modify

| File | Change |
|---|---|
| `packages/ui/e2e/start-webserver.cjs` | Add `SKIP_BUILD` + `build/index.js` existence check to skip the `bun run build` call |
| `.github/workflows/test-ui.yml` | Add explicit "Build UI" step; add `SKIP_BUILD: "1"` env to the Playwright step |

### Files that do NOT need changes

| File | Reason |
|---|---|
| `packages/ui/playwright.config.ts` | `webServer.command` stays the same; the skip logic is inside `start-webserver.cjs` |
| `packages/ui/e2e/start-webserver-for-ci.mjs` | Delegates to `start-webserver.cjs`; inherits `SKIP_BUILD` from `process.env` |
| `packages/ui/e2e/env.ts` | `SKIP_BUILD` flows through `process.env` naturally |
| `packages/ui/package.json` | No script changes needed |
| `.github/workflows/release.yml` | Calls `test-ui.yml` via `workflow_call`; inherits the fix automatically |
| `package.json` (root) | `test:ui` script unchanged |

---

## Verification Steps

### 1. Verify the skip works locally

```bash
cd packages/ui

# First run: build normally
bun run build
ls build/index.js   # confirm artifact exists

# Second run: skip build, confirm Playwright starts without rebuilding
SKIP_BUILD=1 bunx playwright test
# In the output, you should NOT see Vite build output (no "vite build" banner)
```

### 2. Verify fallback works when build is missing

```bash
cd packages/ui

rm -rf build/

# Even with SKIP_BUILD=1, if build/index.js is missing, it should rebuild
SKIP_BUILD=1 bunx playwright test
# Should see Vite build output because build/index.js did not exist
```

### 3. Verify default behavior is unchanged

```bash
cd packages/ui

# Without SKIP_BUILD, behavior is identical to before
bunx playwright test
# Should see Vite build output (the unconditional build)
```

### 4. Verify CI workflow

After pushing the changes, check the `test-ui` workflow run:

- The "Build UI" step should show Vite build output and complete successfully
- The "Run Playwright tests" step should NOT show Vite build output
- The "Run Playwright tests" step should show Playwright running tests directly
- Total wall time for the playwright job should decrease (build time moves to
  a separate visible step, but is no longer repeated if tests are retried)

### 5. Verify release workflow

Trigger a manual release workflow run (or wait for the next PR merge) and
confirm the `ui` job (which calls `test-ui.yml`) still passes. The
`workflow_call` trigger inherits the updated job definition automatically.

### 6. Measure improvement

Compare the "Run Playwright tests" step duration before and after the change.
The build portion (typically 10-30 seconds depending on runner) should
disappear from the Playwright step. The total job time may not change much
(the build still runs, just in a separate step), but the key wins are:

- **Visibility:** Build time is now separately measurable
- **Cacheability:** With the optional Step 3, the build step can be skipped
  entirely on PRs that do not touch UI source
- **Local DX:** Developers running Playwright repeatedly save the build time
  on every run after the first

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `SKIP_BUILD=1` used without prior build | Low | Guard checks `existsSync("build/index.js")` before skipping |
| Stale build artifact used in local dev | Medium | Developer responsibility; same as any build cache. Without `SKIP_BUILD`, behavior is unchanged |
| CI cache returns stale artifact (Step 3) | Low | Cache key includes all source file hashes; any change invalidates |
| `start-webserver-for-ci.mjs` breaks | Low | It already inherits `process.env`; `SKIP_BUILD` flows through naturally |
