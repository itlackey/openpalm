# Rec 6 — Remove the integration test silent-skip problem

## Problem

Three of the four files in `test/integration/` guard their entire test suite with a
runtime fetch probe to `localhost:8100`:

```ts
const stackAvailable = await fetch(`${ADMIN_BASE}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);

describe.skipIf(!stackAvailable)("integration: ...", () => { … });
```

On a CI runner with no running stack the probe always fails, `stackAvailable` is `false`,
and every `describe` block is silently skipped. The job exits 0. Nothing in the output
signals that zero tests ran.

`.github/workflows/release.yml` has a dedicated `integration` job (line 70) that runs
`bun test --filter integration` (line 77) and is listed as a required gate in `needs:`
(line 165). Because the job exits 0 regardless of whether tests ran, it provides no
protection — it is a false gate.

### Affected files

| File | Guard present | What tests do |
|---|---|---|
| `test/integration/container-health.integration.test.ts` | `skipIf(!stackAvailable)` lines 9–13 | Hits real stack endpoints: `/health`, `/`, `/api/v1/apps/`, `/setup/health-check` |
| `test/integration/admin-auth.integration.test.ts` | `skipIf(!stackAvailable)` lines 11–13 | Hits real stack endpoints: 401/200 auth checks on `/state`, `/secrets`, etc. |
| `test/integration/admin-health-check.integration.test.ts` | `skipIf(!stackAvailable)` lines 10–12 | Hits real stack endpoints: `/setup/health-check` |
| `test/integration/channel-gateway.integration.test.ts` | **None** | Uses in-process `Bun.serve` mocks — no real stack needed, runs fine today |

Only the first three files have the problem. `channel-gateway.integration.test.ts` is
already correctly structured and will continue to pass in CI without any changes.

---

## Option evaluation

### Option A — Env-var guard (replace fetch probe with `OPENPALM_INTEGRATION=1`)

Replace the three fetch-probe guards with:

```ts
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";
describe.skipIf(!stackAvailable)("integration: ...", () => { … });
```

Then in `release.yml`, either:
- Set `OPENPALM_INTEGRATION=1` and actually provision a stack (makes the gate real), or
- Remove the `integration` job from `needs:` (honest — the gate does nothing without a stack).

**Pros:** Simple one-line change per file. Keeps the tests co-located with the rest of the
integration suite. Preserves local dev workflow: `OPENPALM_INTEGRATION=1 bun test --filter integration` runs them.

**Cons:** Still silently skips unless someone explicitly provisions a stack in CI. Requires
more CI work (Docker Compose bringup in the job) to make it a real gate.

### Option B — Move to `.docker.ts` tier

Rename the three files to `.docker.ts` and update their guards to use the existing
`OPENPALM_RUN_DOCKER_STACK_TESTS` env-var pattern from `docker-stack.docker.ts:34`.
Drop the `integration` job from `release.yml` entirely (or collapse it to only run
`channel-gateway.integration.test.ts` under `unit-tests`).

**Pros:** Immediately removes the false gate from `release.yml`. Tests are never
accidentally included in `bun test`. Consistent with the pattern already established
for Docker-dependent tests.

**Cons:** Four files to rename and update. `channel-gateway.integration.test.ts` — which
needs no stack — must either stay in `test/integration/` or move to a unit/contract tier.

---

## Chosen option: Option A (env-var guard) with `integration` job removed from `needs:`

**Rationale:**

1. `channel-gateway.integration.test.ts` does not use a fetch probe and does not need a
   running stack. It runs fine today in the `integration` job and should continue to do so.
   Moving it would make it harder to run locally as part of the normal test suite.

2. The three stack-dependent tests are genuine integration tests that belong in
   `test/integration/`. The `.docker.ts` tier is for tests that also build or start
   Docker containers as part of the test itself (`docker-stack.docker.ts` uses
   `docker compose build` and `docker compose up`). The stack-probe tests do not do
   this — they just hit endpoints of an already-running stack.

3. The env-var guard makes the intent explicit and self-documenting. A developer running
   `OPENPALM_INTEGRATION=1 bun test --filter integration` with a local stack gets all
   four files. Without the var, only `channel-gateway` runs (no silent skip, because
   `channel-gateway` has no guard).

4. Removing the `integration` job from `release.yml`'s `needs:` is more honest than
   keeping a gate that always exits 0. If a stack is provisioned in CI in the future,
   the job can be re-added to `needs:` at that point.

**Key difference from raw Option A:** Rather than keeping the vacuous `integration` job in
`needs:`, we remove it. The `channel-gateway` tests move to the `unit-tests` job (or the
`integration` job runs only those and is removed from `needs:`). This makes the CI change
unambiguous.

---

## Implementation steps

### Step 1 — Replace fetch-probe guards in three integration test files

**File:** `test/integration/container-health.integration.test.ts`

- Lines 9–11: remove the top-level `await fetch(...)` probe that assigns `stackAvailable`.
- Line 13: change `describe.skipIf(!stackAvailable)` to `describe.skipIf(Bun.env.OPENPALM_INTEGRATION !== "1")`.

Before (lines 9–13):
```ts
const stackAvailable = await fetch("http://localhost:8100/health", { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);

describe.skipIf(!stackAvailable)("integration: container health", () => {
```

After:
```ts
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

describe.skipIf(!stackAvailable)("integration: container health", () => {
```

---

**File:** `test/integration/admin-auth.integration.test.ts`

- Lines 11–13: remove the fetch probe, replace `stackAvailable` assignment.
- Line 22: the `describe.skipIf` call stays, guard expression changes.

Before (lines 11–13):
```ts
const stackAvailable = await fetch(`${ADMIN_BASE}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);
```

After:
```ts
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";
```

---

**File:** `test/integration/admin-health-check.integration.test.ts`

- Lines 10–12: remove the fetch probe, replace `stackAvailable` assignment.
- Line 14: `describe.skipIf` stays, guard expression changes.

Before (lines 10–12):
```ts
const stackAvailable = await fetch(`${ADMIN_BASE}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(r => r.ok)
  .catch(() => false);
```

After:
```ts
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";
```

---

### Step 2 — Update `release.yml`: remove `integration` from `needs:`, drop the job

**File:** `.github/workflows/release.yml`

**2a.** Delete the `integration` job (lines 70–78):

```yaml
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test --filter integration
```

**2b.** On line 165, remove `integration` from the `needs:` array:

Before:
```yaml
    needs: [unit-tests, integration, contracts, security, ui, docker-build]
```

After:
```yaml
    needs: [unit-tests, contracts, security, ui, docker-build]
```

**Rationale:** `channel-gateway.integration.test.ts` has no skip guard and will continue
to run as part of the regular `unit-tests` job (`bun test` picks up all `.test.ts` files).
The three stack-dependent files now skip when `OPENPALM_INTEGRATION` is unset — they no
longer contribute a false exit-0 pass to the gate.

---

### Step 3 — Verify `channel-gateway.integration.test.ts` runs in `unit-tests`

No file changes needed. Confirm that the `unit-tests` job runs `bun test` (line 68 of
`release.yml`) without a filter, which already picks up
`test/integration/channel-gateway.integration.test.ts` because it has a `.test.ts`
extension and no skip guard.

If `bun test` at the repo root does not traverse `test/` subdirectories, verify using:
```
bun test test/integration/channel-gateway.integration.test.ts
```
If it does not run by default, add an explicit step to the `unit-tests` job or move
the file to a location that `bun test` covers.

---

### Step 4 (optional, future) — Provision a real stack in CI

When there is capacity to provision the stack in CI, restore the integration job:

```yaml
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      OPENPALM_INTEGRATION: "1"
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Start dev stack
        run: bun run dev:up
      - name: Wait for stack
        run: # poll localhost:8100/health until ready or timeout
      - run: bun test --filter integration
      - name: Teardown
        if: always()
        run: bun run dev:down
```

Add `integration` back to `needs:` on the `release` job at that point. Until then,
the three stack tests are guarded behind the env var and do not pollute CI output.

---

## Verification: before vs. after

### Before (current state)

CI output for the `integration` job:
```
$ bun test --filter integration
bun test v1.3.5

test/integration/admin-auth.integration.test.ts:
  skip: integration: admin auth rejection (4 tests skipped)

test/integration/admin-health-check.integration.test.ts:
  skip: integration: admin health-check (5 tests skipped)

test/integration/container-health.integration.test.ts:
  skip: integration: container health (4 tests skipped)

test/integration/channel-gateway.integration.test.ts:
  ✓ chat forwards a full roundtrip payload
  ✓ gateway error propagates to caller
  ✓ discord and telegram produce normalized channel messages
  ✓ api facade forwards chat completions through gateway
  ✓ api facade forwards anthropic messages through gateway

 13 skipped, 5 passed (7ms)
```

Job exits 0. Listed in `needs:`. Looks like a passing gate.

### After (this plan applied)

The `integration` job no longer exists in `release.yml`. The `channel-gateway` tests run
in the `unit-tests` job alongside the rest of `bun test`. CI output for `unit-tests`
includes:

```
test/integration/channel-gateway.integration.test.ts:
  ✓ chat forwards a full roundtrip payload
  ✓ gateway error propagates to caller
  ✓ discord and telegram produce normalized channel messages
  ✓ api facade forwards chat completions through gateway
  ✓ api facade forwards anthropic messages through gateway
```

The three stack-dependent files, when run in isolation by a developer with
`OPENPALM_INTEGRATION` unset, produce a single honest skip line each (not silent — the
skip line is there, but no test infrastructure in `needs:` misrepresents them as a gate).

When run locally with a stack:
```
OPENPALM_INTEGRATION=1 bun test --filter integration
```
All four files run, 18 tests execute against the live stack.

---

## File references

| File | Line(s) | Relevance |
|---|---|---|
| `test/integration/container-health.integration.test.ts` | 9–13 | Fetch probe to remove; `describe.skipIf` guard to update |
| `test/integration/admin-auth.integration.test.ts` | 11–13, 22 | Fetch probe to remove; `describe.skipIf` guard to update |
| `test/integration/admin-health-check.integration.test.ts` | 10–12, 14 | Fetch probe to remove; `describe.skipIf` guard to update |
| `test/integration/channel-gateway.integration.test.ts` | 1–143 | No changes — no fetch probe, no stack dependency, runs in CI today |
| `.github/workflows/release.yml` | 70–78 | `integration` job to delete |
| `.github/workflows/release.yml` | 165 | `needs:` array — remove `integration` |
| `test/docker/docker-stack.docker.ts` | 31–34 | Reference implementation for env-var guard pattern |
