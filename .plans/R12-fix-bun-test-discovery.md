# Implementation Plan: R12 -- Fix `bun test` Discovery

## Problem

Running bare `bun test` at the repo root discovers **all 69 test files** -- including
Docker-dependent tests, live-stack integration tests, and self-contained unit tests alike.
There is no `bunfig.toml` include/exclude configuration to control what `bun test`
discovers. The `test:ci` script (`bun run typecheck && bun test`) also runs everything.

### Why this matters

1. **Docker tests attempt to run** -- The two `.docker.ts` files
   (`test/docker/docker-stack.docker.ts`, `test/install-e2e/happy-path.docker.ts`) import
   from `bun:test` and are discovered even though they lack the `.test.ts` suffix. Without
   `OPENPALM_RUN_DOCKER_STACK_TESTS=1` they skip, but they still load and appear in output.

2. **Integration tests load unnecessarily** -- The 3 live-stack integration tests
   (`admin-health-check`, `container-health`, `admin-auth`) use `describe.skipIf()` to
   guard on `OPENPALM_INTEGRATION === "1"`, but they still get discovered, loaded, and
   reported as skipped. This adds noise and slows down the run.

3. **`test:unit` uses fragile negation** -- The current script
   `bun test --filter '!(integration|contract|security|compose|ui)'` is a deny-list that
   must be updated every time a new test category is added.

4. **One naming inconsistency** -- `test/contracts/readme-no-npx.test.ts` is a contract
   test but does not follow the `*.contract.test.ts` naming convention, so it is not
   discovered by `bun test --filter contract`.

5. **`test:compose` is a ghost** -- `bun test --filter compose` matches no test files
   in the current tree. There are no `*.compose.test.ts` files. The only compose-related
   tests are in `packages/cli/test/compose.test.ts`, which is a unit test.

---

## Current Configuration

### `bunfig.toml`

```toml
[test]
timeout = 15000

[install]
# Ensure reproducible installs
frozen = true
```

No `preload`, no `include`/`exclude` patterns.

### `package.json` test scripts

| Script | Command | Notes |
|---|---|---|
| `test` | `bun test` | Discovers everything |
| `test:unit` | `bun test --filter '!(integration\|contract\|security\|compose\|ui)'` | Fragile deny-list |
| `test:integration` | `bun test --filter integration` | Matches `.integration.test.ts` |
| `test:contracts` | `bun test --filter contract` | Matches `.contract.test.ts` |
| `test:security` | `bun test --filter security` | Matches `.security.test.ts` |
| `test:compose` | `bun test --filter compose` | Matches nothing currently |
| `test:compose:ui` | `bun test --filter e2e-ui.compose` | Matches nothing currently |
| `test:docker` | `OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/docker/docker-stack.docker.ts` | Explicit path |
| `test:install:smoke` | `OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts` | Explicit path |
| `test:ui` | `cd packages/ui && bunx playwright test` | Playwright, not Bun |
| `test:ci` | `bun run typecheck && bun test` | Runs everything |

---

## Complete Test File Inventory (69 files)

### Docker tests (2 files) -- require Docker daemon + env var

These files use `bun:test` imports but have a `.docker.ts` suffix (not `.test.ts`). Bun
still discovers them because it scans for `bun:test` imports.

| File | Guard |
|---|---|
| `test/docker/docker-stack.docker.ts` | `OPENPALM_RUN_DOCKER_STACK_TESTS=1` |
| `test/install-e2e/happy-path.docker.ts` | `OPENPALM_RUN_DOCKER_STACK_TESTS=1` |

### Integration tests requiring live stack (3 files) -- need `OPENPALM_INTEGRATION=1` + `dev:up`

| File | Guard |
|---|---|
| `test/integration/admin-health-check.integration.test.ts` | `describe.skipIf` on `OPENPALM_INTEGRATION` |
| `test/integration/container-health.integration.test.ts` | `describe.skipIf` on `OPENPALM_INTEGRATION` |
| `test/integration/admin-auth.integration.test.ts` | `describe.skipIf` on `OPENPALM_INTEGRATION` |

### Integration test that is self-contained (1 file) -- uses Bun.serve() stubs

| File | Notes |
|---|---|
| `test/integration/channel-gateway.integration.test.ts` | No Docker needed; stubs HTTP servers with `Bun.serve()` |

### Contract tests requiring live stack (1 file)

| File | Guard |
|---|---|
| `test/contracts/setup-wizard-gate.contract.test.ts` | `describe.skipIf` on `OPENPALM_INTEGRATION` |

### Self-contained contract tests (3 files)

| File | Notes |
|---|---|
| `test/contracts/admin-api.contract.test.ts` | Pure file reads |
| `test/contracts/channel-message.contract.test.ts` | Pure file reads |
| `test/contracts/readme-no-npx.test.ts` | **Naming inconsistency** -- should be `.contract.test.ts` |

### Security tests (2 files) -- self-contained

| File | Notes |
|---|---|
| `test/security/hmac.security.test.ts` | Pure functions |
| `test/security/input-bounds.security.test.ts` | Pure functions |

### Unit tests (57 files) -- all self-contained

**`packages/lib/src/admin/` (13 files):**
- `stack-spec.test.ts`
- `stack-generator.test.ts`
- `stack-dynamic.test.ts`
- `stack-manager.test.ts`
- `stack-apply-engine.test.ts`
- `compose-runner.test.ts`
- `setup-manager.test.ts`
- `runtime-env.test.ts`
- `cron.test.ts`
- `automations.test.ts`
- `automation-history.test.ts`
- `schemas/schemas.test.ts`

**`packages/lib/src/shared/` (3 files):**
- `crypto.test.ts`
- `channel-sdk.test.ts`
- `admin-client.test.ts`

**`packages/lib/src/embedded/state/` (1 file):**
- `openmemory-pin.test.ts`

**`packages/cli/test/` (12 files):**
- `main.test.ts`
- `compose.test.ts`
- `install.test.ts`
- `install-methods.test.ts`
- `uninstall-extensions.test.ts`
- `domain-commands.test.ts`
- `admin-command.test.ts`
- `paths.test.ts`
- `runtime.test.ts`
- `detect-providers.test.ts`
- `management-commands.test.ts`
- `tokens.test.ts`
- `env.test.ts`
- `assets.test.ts`

**`packages/cli/src/commands/` (5 files):**
- `install-port.test.ts`
- `install-channel-net.test.ts`
- `install-admin-fallback.test.ts`
- `install-password.test.ts`
- `install-report-url.test.ts`

**`packages/ui/src/` (5 files):**
- `lib/components/quick-links.test.ts`
- `lib/components/profile-step.test.ts`
- `lib/components/security-step.test.ts`
- `lib/components/complete-step.test.ts`
- `routes/command/command-password.test.ts`
- `routes/opencode/proxy-timeout.test.ts`

**`channels/` (8 files):**
- `chat/server.test.ts`
- `discord/server.test.ts`
- `telegram/server.test.ts`
- `voice/server.test.ts`
- `webhook/server.test.ts`
- `api/server.test.ts`
- `mcp/server.test.ts`
- `a2a/server.test.ts`

**`core/gateway/src/` (7 files):**
- `server.test.ts`
- `channel-intake.test.ts`
- `assistant-client.test.ts`
- `nonce-cache.test.ts`
- `audit.test.ts`
- `channel-security.test.ts`
- `rate-limit.test.ts`

**`core/assistant/extensions/plugins/` (1 file):**
- `openmemory-http.test.ts`

**`dev/` (1 file):**
- `version.test.ts`

---

## Proposed Solution

### Strategy: Use `bunfig.toml` include/exclude patterns

Bun's test runner supports glob patterns in `bunfig.toml` to control which files are
discovered. This is the simplest, most reliable approach:

- **Default `bun test`** should run only unit tests, contract tests, and security tests
  (everything self-contained).
- **Docker tests and live-stack integration tests** should be excluded from default
  discovery and only run via their explicit scripts.
- **Named scripts** (`test:integration`, `test:security`, etc.) remain for targeted runs.

### What to exclude from default discovery

Only exclude files that **cannot run without external infrastructure**:

| Pattern | Files matched | Reason to exclude |
|---|---|---|
| `test/docker/**` | 1 `.docker.ts` file | Requires Docker daemon |
| `test/install-e2e/**` | 1 `.docker.ts` file | Requires Docker daemon |
| `test/integration/admin-*.integration.test.ts` | 2 files | Requires live stack |
| `test/integration/container-health.integration.test.ts` | 1 file | Requires live stack |
| `test/contracts/setup-wizard-gate.contract.test.ts` | 1 file | Requires live stack |

Total excluded: **5 files** (2 Docker + 3 live-stack).

Everything else (62 self-contained tests + the self-contained
`channel-gateway.integration.test.ts` + self-contained contracts) should remain in
default discovery.

---

## Step-by-Step Implementation

### Step 1: Rename `readme-no-npx.test.ts` to follow naming convention

**File:** `test/contracts/readme-no-npx.test.ts`
**Rename to:** `test/contracts/readme-no-npx.contract.test.ts`

This file is a contract test but lacks the `.contract.test.ts` suffix. Renaming it
ensures `bun test --filter contract` discovers it, and keeps the naming convention
consistent.

```bash
git mv test/contracts/readme-no-npx.test.ts test/contracts/readme-no-npx.contract.test.ts
```

No import changes needed -- no other file imports from this test file.

### Step 2: Update `bunfig.toml` to exclude infrastructure-dependent tests

**File:** `bunfig.toml`

Add include and exclude patterns to the `[test]` section. Bun uses glob patterns
relative to the project root.

```toml
[test]
timeout = 15000

# Default discovery: run all self-contained tests.
# Docker and live-stack tests are excluded and run via dedicated scripts.
exclude = [
  "test/docker/**",
  "test/install-e2e/**",
]

[install]
# Ensure reproducible installs
frozen = true
```

**Design decision:** We exclude only the Docker test directories. The live-stack
integration tests already have `describe.skipIf()` guards, so they are safe to discover
(they skip gracefully). But the Docker `.docker.ts` files should be excluded because:
- They do not follow the `.test.ts` naming convention
- They are heavyweight (build containers, 30-60s runtime)
- They have their own dedicated scripts (`test:docker`, `test:install:smoke`)
- Excluding them from default discovery prevents accidental timeouts in CI

The live-stack integration tests and the `setup-wizard-gate.contract.test.ts` are left
in default discovery because their `skipIf` guards work correctly. They show as "skipped"
which is acceptable and informative.

### Step 3: Simplify the `test:unit` script

**File:** `package.json`

The current `test:unit` script uses a fragile deny-list filter:
```
bun test --filter '!(integration|contract|security|compose|ui)'
```

Replace it with an approach that simply excludes the test/ directory (which contains
integration, contract, security, and Docker tests) and uses the packages/channels/core
tree for unit tests only:

```json
"test:unit": "bun test packages/ channels/ core/ dev/"
```

This is an allow-list of directories. It naturally excludes everything in `test/`
(integration, contract, security, Docker) and only runs the unit tests co-located with
source code.

### Step 4: Clean up dead scripts

**File:** `package.json`

Remove or fix scripts that match nothing:

| Script | Current | Action |
|---|---|---|
| `test:compose` | `bun test --filter compose` | Remove (matches nothing) |
| `test:compose:ui` | `bun test --filter e2e-ui.compose` | Remove (matches nothing) |

If compose-related E2E tests are planned for the future, the scripts can be re-added
when the test files exist. Dead scripts create confusion.

### Step 5: Update `test:ci` to be explicit about what it runs

**File:** `package.json`

The current `test:ci` runs `bun run typecheck && bun test`. With the `bunfig.toml`
exclusions from Step 2, bare `bun test` will already exclude Docker tests. This is
the desired behavior for CI -- Docker tests run in a separate CI job.

No change needed to `test:ci`. The `bunfig.toml` exclusions take effect automatically.

---

## Files Changed

| File | Action | Description |
|---|---|---|
| `bunfig.toml` | **Modify** | Add `exclude` patterns for Docker test directories |
| `package.json` | **Modify** | Simplify `test:unit`, remove dead `test:compose` scripts |
| `test/contracts/readme-no-npx.test.ts` | **Rename** | `readme-no-npx.test.ts` -> `readme-no-npx.contract.test.ts` |

### Files that do NOT need changes

| File | Reason |
|---|---|
| All test files (contents) | No code changes; only `bunfig.toml` controls discovery |
| `.github/workflows/release.yml` | Uses `bun test` which respects `bunfig.toml` |
| `.github/workflows/test-ui.yml` | Uses Playwright, not `bun test` |
| Integration test files | `skipIf` guards are already correct |
| Docker test files | Already have env var guards; now also excluded from discovery |

---

## Proposed `bunfig.toml` (complete)

```toml
[test]
timeout = 15000

# Default discovery: run all self-contained tests.
# Docker and live-stack tests are excluded and run via dedicated scripts
# (test:docker, test:install:smoke).
exclude = [
  "test/docker/**",
  "test/install-e2e/**",
]

[install]
# Ensure reproducible installs
frozen = true
```

## Proposed `package.json` test scripts (diff)

```diff
-    "test:unit": "bun test --filter '!(integration|contract|security|compose|ui)'",
+    "test:unit": "bun test packages/ channels/ core/ dev/",
     "test:integration": "bun test --filter integration",
     "test:contracts": "bun test --filter contract",
     "test:security": "bun test --filter security",
     "test:ui": "cd packages/ui && bunx playwright test",
-    "test:compose": "bun test --filter compose",
-    "test:compose:ui": "bun test --filter e2e-ui.compose",
     "test:ci": "bun run typecheck && bun test",
```

---

## Verification Steps

### 1. Verify default `bun test` excludes Docker tests

```bash
# Run bare bun test and confirm Docker tests are NOT in the output
bun test 2>&1 | grep -c "docker-stack\|happy-path"
# Expected: 0 matches
```

### 2. Verify Docker tests still run via their dedicated scripts

```bash
# These should still work when Docker is available
bun run test:docker
bun run test:install:smoke
```

### 3. Verify `test:unit` runs only unit tests

```bash
# Should run tests from packages/, channels/, core/, dev/ only
bun run test:unit 2>&1 | grep -c "integration\|contract\|security\|docker"
# Expected: 0 matches (no integration/contract/security/docker tests)
```

### 4. Verify `test:integration` still works

```bash
# Should find integration tests (they will skip without OPENPALM_INTEGRATION)
bun run test:integration
# Expected: 4 files discovered (3 live-stack + 1 self-contained)
```

### 5. Verify `test:contracts` picks up the renamed file

```bash
bun run test:contracts
# Expected: includes readme-no-npx.contract.test.ts in the output
```

### 6. Verify `test:security` is unchanged

```bash
bun run test:security
# Expected: 2 files (hmac.security.test.ts, input-bounds.security.test.ts)
```

### 7. Verify `test:ci` works correctly

```bash
bun run test:ci
# Expected: typecheck passes, then bun test runs with Docker tests excluded
```

### 8. Count total files in default discovery

```bash
# Before: 69 files discovered by bare bun test
# After: 67 files (69 - 2 Docker files excluded)
bun test --dry-run 2>&1 | wc -l
# Or simply run and count the file lines in output
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `bunfig.toml` exclude patterns not supported by Bun version | Low | High | Bun 1.0+ supports `exclude` in `[test]`. Verify with `bun --version`. |
| Renaming `readme-no-npx.test.ts` breaks something | Very low | Low | No other file imports it. Git tracks the rename. |
| Removing `test:compose` scripts breaks CI | Very low | Low | No CI workflow references these scripts. They match no files today. |
| New test categories added without updating `test:unit` | Low | Low | The allow-list approach (`packages/ channels/ core/ dev/`) naturally includes new unit tests in those directories. Only new top-level `test/` categories would need attention, and those are rare (integration, contract, security are the established set). |
| `channel-gateway.integration.test.ts` runs in default discovery despite being "integration" | N/A | None | This file is self-contained (uses `Bun.serve()` stubs). Running it in default discovery is correct behavior. It has no `skipIf` guard because it doesn't need one. |

---

## Summary

This plan makes three focused changes:

1. **`bunfig.toml`** -- Exclude the 2 Docker test directories from default discovery,
   so bare `bun test` and `test:ci` no longer load heavyweight Docker tests.

2. **`package.json`** -- Replace the fragile deny-list `test:unit` filter with a simple
   directory allow-list; remove two dead scripts that match no files.

3. **File rename** -- Rename `readme-no-npx.test.ts` to `readme-no-npx.contract.test.ts`
   to fix the naming inconsistency so `test:contracts` discovers it.

Total effort: ~15 minutes. Zero production code changes. Zero risk of test behavior
changes (only discovery changes).
