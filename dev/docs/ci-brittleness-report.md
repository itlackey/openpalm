# CI & Test Brittleness Report

**Date:** 2026-02-22
**Scope:** Full review of git history, GitHub Actions runs, workflow definitions, test infrastructure, and dependency configuration.

---

## Executive Summary

The OpenPalm CI/CD pipeline has a systemic brittleness problem. Of the last ~100 commits, **45.8% are fix commits** -- a 9.5:1 fix-to-feature ratio. Every release (v0.0.6 through v0.2.5) triggered at least one fix commit; no release was clean. The publish pipelines (Docker images, CLI) failed at a **75% rate** across releases v0.2.1-v0.2.5. The root causes fall into 7 categories, detailed below with specific recommendations.

---

## 1. The Numbers

### Commit Composition (last 100 non-merge commits)

| Category | Count | % |
|----------|-------|---|
| Fix | 38 | 45.8% |
| Uncategorized/chore | 32 | 38.6% |
| Release | 5 | 6.0% |
| Refactor | 4 | 4.8% |
| Feature | 4 | 4.8% |

### CI Failure Rates by Workflow

| Workflow | Runs | Failures | Rate |
|----------|------|----------|------|
| test | 72 | 23 | 32% |
| Publish Docker images | 8 | 6 | 75% |
| publish-cli | 8 | 6 | 75% |
| Release | 8 | 1 | 13% |

### Worst Push-Fix-Push Cycles

- **v0.2.1 release:** 3 consecutive fix commits to stabilize (bun-types, 36 test failures, Docker-dependent test skip)
- **v0.2.2 → v0.2.3:** 8 consecutive fix commits (longest streak) across every subsystem
- **v0.0.6:** Release + fixes committed twice with different hashes (branch management confusion)
- **CLI publishing:** Same root cause (`workspace:` protocol) broke publishing 3 separate times

---

## 2. Root Cause Analysis

### Root Cause A: Tests That Cannot Run in CI

**Impact: Most frequent CI failure. Blocks all downstream jobs.**

The `docker-stack.test.ts` tests build Docker containers and check health endpoints. These were included in the `bun test` run in CI, where no Docker daemon exists. The test file even has a comment saying it shouldn't be included, but the filter pattern didn't exclude it.

**Evidence:**
- Runs 22286308355, 22286185716, 22283589721 all fail at `docker-stack.test.ts:201,302,319`
- Assertions like `Expected: true, Received: false` on container health checks
- All downstream jobs (integration, contracts, security, ui) are skipped because `needs: unit` fails

**What makes this brittle:**
- Test categorization relies on filename patterns matched by `--filter` regex
- Easy to add a test file that accidentally matches/doesn't match the filter
- No explicit mechanism to declare "this test requires Docker"
- Tests that need infrastructure should be in a separate CI job with the right environment

**Files involved:**
- `test/docker/docker-stack.test.ts`
- `.github/workflows/test.yml` (filter patterns in unit job)

---

### Root Cause B: Dockerfile Build Context Mismatches

**Impact: Broke every Docker image publish from v0.2.1 through v0.2.5.**

The gateway Dockerfile uses `COPY core/gateway/opencode/ ...` which requires the repo root as build context. But the publish workflow originally set `context: "./core/gateway"`, causing the path to resolve as `./core/gateway/core/gateway/opencode/` (doesn't exist).

Similarly, the assistant Dockerfile was modified to use `addgroup`/`adduser` for non-root users, which conflicted with the existing `bun` user at UID 1000 in the base image.

**What makes this brittle:**
- Dockerfile `COPY` paths are relative to build context, which is set in the workflow, not the Dockerfile
- No local validation of Docker builds before push (the pre-push checklist doesn't include `docker build`)
- Changes to Dockerfiles are not tested by the `test` workflow at all
- The feedback loop is: push tag → wait for CI → see failure → fix → push new tag

**Files involved:**
- `core/gateway/Dockerfile`
- `core/assistant/Dockerfile`
- `.github/workflows/publish-images.yml`

---

### Root Cause C: Local Tests Don't Catch What CI Catches (and Vice Versa)

**Impact: Changes pass locally but fail in CI, or tests silently skip in CI giving false confidence.**

Three distinct problems here:

1. **TypeScript `skipLibCheck`:** After the v0.2.1 release, `bun run typecheck` failed because `bun-types` declarations conflicted with library types. This only manifests with specific TS/Bun version combinations and wasn't caught locally.

2. **Silent test skipping:** Integration tests use `.skipIf(!stackAvailable)` to conditionally skip when the Docker stack isn't running. In CI, these always skip silently -- there's no indication in the CI output that entire test suites were skipped.

3. **Environment variable pollution:** Tests mutate `Bun.env` and `process.env` globally without proper restoration. If a test fails mid-execution, the environment remains polluted for subsequent tests. This creates ordering-dependent flakiness.

**What makes this brittle:**
- No parity between local and CI environments
- No CI step that reports "X tests were skipped" as a warning
- No test isolation -- env var mutations leak between tests

**Files involved:**
- `packages/lib/src/admin/automations.test.ts` (mutates `Bun.env.CRON_DIR` without restore)
- `core/assistant/extensions/plugins/openmemory-http.test.ts` (shallow env copy doesn't delete added keys)
- `test/integration/*.test.ts` (all use `skipIf`)

---

### Root Cause D: The CLI Publishing Pipeline Has a Recurring Architectural Bug

**Impact: Same bug fixed 3 times. CLI publish broken for 5 consecutive releases.**

Bun workspaces use `"@openpalm/lib": "workspace:*"` in `package.json`. When publishing to npm, this `workspace:` protocol isn't recognized by the npm registry. Each fix addressed the symptom differently (bundling, rewriting, sed replacement) rather than solving it architecturally.

**What makes this brittle:**
- The `workspace:` protocol is a development convenience that's incompatible with publishing
- Each fix is a patch at a different layer (build step, workflow step, package.json)
- No integration test verifies the CLI can be installed from npm after publishing

**Files involved:**
- `packages/cli/package.json`
- `.github/workflows/publish-cli.yml`

---

### Root Cause E: Race Conditions and Timing Assumptions in Tests

**Impact: Intermittent failures that are hard to reproduce.**

Tests throughout the codebase use fixed timeouts, hardcoded ports, and timing-sensitive assertions:

| Pattern | Location | Risk |
|---------|----------|------|
| 100ms rate-limit window with 50ms buffer | `core/gateway/src/rate-limit.test.ts:12-20` | Fails under CPU load |
| Random port range 18100-19099 | `core/admin/src/admin-e2e.test.ts:85` | Collides with dev stack |
| 40 retries × 250ms = 10s max for server startup | `core/admin/src/admin-e2e.test.ts:117` | Too short for slow CI |
| 30s deadline for Docker stack health | `admin/ui/tests/global-setup.ts:28` | Too short for cold start |
| Inconsistent timeouts in same test (10s, 30s, 130s) | `admin/ui/tests/setup-wizard.ui.playwright.ts` | Confusing, fragile |
| `proc.kill()` not awaited before `rmSync` | `core/admin/src/admin-e2e.test.ts:128` | EBUSY on cleanup |
| `server.stop()` not awaited | Multiple gateway/channel tests | Port not released |
| `globalThis.fetch` replaced without try/finally guarantee | `core/gateway/src/assistant-client.test.ts:84` | Leaks mock |

---

### Root Cause F: Stale Lock File and Version Drift

**Impact: CI may install different dependency versions than local development.**

| Issue | Detail |
|-------|--------|
| `bun.lock` shows v0.2.5 | Source `package.json` files show v0.2.6 |
| Assistant uses Bun 1.1.42 | All other services use Bun 1.3.5 |
| `opencode-ai@latest` in assistant Dockerfile | Unpinned -- different version on every build |
| Playwright 1.40 in admin | Playwright 1.58 in packages/ui |
| Webhook channel at 0.2.0 | Other channels at 0.2.6 |
| `@types/node: "^24"` | Major-only range, wide drift possible |
| No `bunfig.toml` | No standardized Bun behavior across versions |

---

### Root Cause G: No CI Workflow Safeguards

**Impact: Race conditions, silent failures, and no protection against concurrent runs.**

| Issue | Detail |
|-------|--------|
| No `concurrency` blocks | Multiple release/publish workflows can run simultaneously |
| No retry for `git push` | Network failure between tag push and commit push leaves repo inconsistent |
| No retry for Docker Hub login/push | Transient network failure = entire publish fails |
| jq errors suppressed with `2>/dev/null` | Malformed registry data passes validation silently |
| Manifest creation doesn't verify arch images exist | Partial multi-arch images published if one arch fails |
| CLI bundle not tested before npm publish | Broken CLI can reach users |
| No timeout on image builds or E2E tests | Jobs can hang indefinitely |
| Component list hardcoded in 3+ workflow files | Adding a service requires editing multiple workflows |

---

## 3. Recommendations

### Priority 1: Stop Tests From Failing in CI (Immediate)

#### 1a. Properly gate environment-dependent tests

Don't rely on filename filter patterns. Use explicit environment checks at the top of test files:

```typescript
// test/docker/docker-stack.test.ts
import { describe } from "bun:test";

const DOCKER_AVAILABLE = await checkDockerDaemon();
describe.skipIf(!DOCKER_AVAILABLE)("docker stack", () => { ... });
```

And in CI, report skipped test suites as a visible warning:

```yaml
# .github/workflows/test.yml
- name: Run unit tests
  run: bun test 2>&1 | tee test-output.txt
- name: Check for skipped suites
  run: |
    SKIPPED=$(grep -c "skipped" test-output.txt || true)
    if [ "$SKIPPED" -gt 0 ]; then
      echo "::warning::$SKIPPED test suites were skipped (missing environment)"
    fi
```

#### 1b. Separate test jobs by environment requirements

```yaml
unit:        # No external deps, fast (bun run test:ci)
ui:          # Bun-based Playwright tests (bun run test:ui)
docker:      # Docker daemon + image builds (bun run test:docker)
```

Each job should only contain tests that can actually run in its environment. UI tests should be hermetic and not depend on Docker. Docker tests should live in `test/docker/*.docker.ts` so `bun test` stays hermetic by default.

#### 1c. Fix test isolation

Every test that mutates `Bun.env` or `process.env` should save and restore in `beforeEach`/`afterEach`:

```typescript
let savedEnv: Record<string, string | undefined>;
beforeEach(() => { savedEnv = { ...Bun.env }; });
afterEach(() => {
  for (const key of Object.keys(Bun.env)) {
    if (!(key in savedEnv)) delete Bun.env[key];
    else Bun.env[key] = savedEnv[key];
  }
});
```

---

### Priority 2: Make Dockerfiles Testable Before Push (This Week)

#### 2a. Add a Docker build validation step to the test workflow

```yaml
docker-build:
  runs-on: ubuntu-latest
  strategy:
    matrix:
      service: [gateway, admin, assistant, chat, discord, telegram, voice, webhook]
  steps:
    - uses: actions/checkout@v4
    - name: Validate Docker build
      run: docker build --target production -f ${{ matrix.service }}/Dockerfile . --no-cache --progress=plain
```

This catches `COPY` path errors, missing files, and build failures **before** a release tag is pushed.

#### 2b. Pin all base image versions

```dockerfile
# Instead of:
FROM oven/bun:1.3.5
# Use digest pinning:
FROM oven/bun:1.3.5@sha256:<digest>
```

And unify the assistant service to the same Bun version as everything else.

#### 2c. Pin `opencode-ai` to a specific version

```dockerfile
# Instead of:
RUN bun add -g opencode-ai@latest
# Use:
ARG OPENCODE_VERSION=0.5.2
RUN bun add -g opencode-ai@${OPENCODE_VERSION}
```

---

### Priority 3: Fix the CLI Publishing Architecture (This Week)

#### 3a. Solve the `workspace:` protocol problem once

Add a pre-publish build step that produces a standalone, publishable package:

```json
// packages/cli/package.json
{
  "scripts": {
    "prepublish": "bun build src/main.ts --outfile dist/openpalm.js --target bun --external none"
  },
  "files": ["dist/"],
  "main": "dist/openpalm.js"
}
```

The bundle resolves all `workspace:` imports at build time. The published package has zero workspace dependencies.

#### 3b. Add a smoke test before npm publish

```yaml
- name: Smoke test bundled CLI
  run: |
    node .npm-publish/dist/openpalm.js --version
    node .npm-publish/dist/openpalm.js --help
```

---

### Priority 4: Add CI Workflow Safeguards (This Sprint)

#### 4a. Add concurrency controls

```yaml
# In every workflow file:
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true  # for test workflow
  # cancel-in-progress: false  # for publish workflows
```

#### 4b. Add retry logic for network operations

```yaml
- name: Push to Docker Hub
  uses: nick-fields/retry@v3
  with:
    max_attempts: 3
    timeout_minutes: 30
    command: docker buildx build --push ...
```

Or use shell retries:

```bash
for i in 1 2 3; do
  git push origin HEAD && break
  echo "Push failed, retrying in $((i * 2))s..."
  sleep $((i * 2))
done
```

#### 4c. Validate manifests after creation

```bash
docker buildx imagetools inspect "${IMAGE}:latest" | grep -q "linux/amd64" || exit 1
docker buildx imagetools inspect "${IMAGE}:latest" | grep -q "linux/arm64" || exit 1
```

#### 4d. Add timeouts to all jobs

```yaml
jobs:
  unit:
    timeout-minutes: 10
  integration:
    timeout-minutes: 15
  ui:
    timeout-minutes: 20
  publish:
    timeout-minutes: 45
```

---

### Priority 5: Synchronize Versions and Dependencies (This Sprint)

#### 5a. Regenerate `bun.lock` and enforce it

```bash
rm bun.lock && bun install
# Commit the regenerated lock file
```

Add to CI:
```yaml
- run: bun install --frozen-lockfile
```

And to pre-commit hooks:
```bash
# .husky/pre-commit
bun install --frozen-lockfile --dry-run || {
  echo "bun.lock is out of sync. Run: bun install"
  exit 1
}
```

#### 5b. Unify versions across workspaces

Either use a single version for all workspaces (simplest) or explicitly define version relationships. The current state (some at 0.2.0, some at 0.2.6) creates confusion about what's been updated.

#### 5c. Create a `bunfig.toml`

```toml
[install]
frozen = true

[test]
timeout = 10000
```

---

### Priority 6: Fix Test Timing and Port Issues (This Sprint)

#### 6a. Use `port: 0` everywhere

Replace all hardcoded/random port assignments with Bun's auto-assign:

```typescript
// Instead of:
const port = 18100 + Math.floor(Math.random() * 1000);
// Use:
const server = Bun.serve({ port: 0, fetch: ... });
const port = server.port;
```

#### 6b. Use exponential backoff for health checks

```typescript
async function waitForHealth(url: string, maxMs = 30_000): Promise<boolean> {
  const start = Date.now();
  let delay = 100;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
  return false;
}
```

#### 6c. Always await async cleanup

```typescript
afterAll(async () => {
  proc?.kill();
  await proc?.exited;  // Wait for process to actually exit
  rmSync(tmpDir, { recursive: true, force: true });
});
```

---

### Priority 7: Deduplicate Workflow Configuration (Next Sprint)

#### 7a. Single source of truth for component list

Create a JSON file that all workflows reference:

```json
// .github/components.json
{
  "images": [
    {"name": "assistant", "context": "./core/assistant", "dockerfile": "core/assistant/Dockerfile"},
    {"name": "gateway", "context": ".", "dockerfile": "core/gateway/Dockerfile"},
    ...
  ]
}
```

Workflows read from this file:
```yaml
- name: Load component matrix
  id: matrix
  run: echo "matrix=$(cat .github/components.json | jq -c '.images')" >> "$GITHUB_OUTPUT"
```

#### 7b. Extract common workflow patterns into composite actions

```yaml
# .github/actions/retry-push/action.yml
inputs:
  command:
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        for i in 1 2 3 4; do
          ${{ inputs.command }} && exit 0
          sleep $((2 ** i))
        done
        exit 1
```

---

## 4. Suggested Implementation Order

| Week | Action | Expected Impact |
|------|--------|-----------------|
| 1 | Gate docker tests, fix test isolation, add Docker build validation to CI | Eliminates most frequent unit test failures |
| 1 | Pin opencode-ai version, unify Bun versions, regenerate bun.lock | Reproducible builds |
| 1 | Fix CLI pre-publish bundle with smoke test | CLI publish stops breaking |
| 2 | Add concurrency controls and timeouts to all workflows | Prevents conflicting runs |
| 2 | Add retry logic for network operations (push, Docker Hub, npm) | Resilience to transient failures |
| 2 | Fix port allocation and health check timing | Eliminates intermittent test failures |
| 3 | Deduplicate component lists into shared config | Easier to add/modify services |
| 3 | Add manifest validation and artifact checksums | Catches incomplete releases |
| 3 | Report skipped tests as CI warnings | Visibility into actual test coverage |

---

## 5. Metrics to Track

After implementing these changes, track:

1. **Fix-to-feature ratio** -- Target: < 1:3 (currently 9.5:1)
2. **Clean release rate** -- Target: > 90% (currently 0%)
3. **CI pass rate on first push** -- Target: > 80% (currently ~50%)
4. **Skipped test count in CI** -- Target: trending down toward 0
5. **Time from push to green CI** -- Track p50 and p95
