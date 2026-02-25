# R05: Delete Fake Contract Tests

## Summary of the Problem

Three files in `test/contracts/` are labeled as contract tests but do not test any actual service contracts (HTTP endpoints, request/response shapes, status codes). They inflate the contract test suite without providing contract-level confidence:

1. **`admin-api.contract.test.ts`** -- Reads `dev/docs/api-reference.md` and asserts that certain endpoint strings appear (or do not appear) in the documentation. This is a doc-string parity check, not a behavioral contract test.

2. **`readme-no-npx.test.ts`** -- Reads `README.md` and asserts it does not contain `npx`/`bunx` references and does contain `curl -fsSL` install instructions. This is a documentation lint check, not a contract test.

3. **`channel-message.contract.test.ts`** -- Defines a `validateChannelMessage` helper function *inside the test file itself*, then tests that helper against hardcoded payloads. It never imports or exercises the actual `ChannelMessage` type's runtime validation, never sends a message to the gateway, and never checks that the gateway accepts or rejects payloads. The type already exists at `packages/lib/src/shared/channel-sdk.ts` and TypeScript's type system already enforces the shape at compile time.

Meanwhile, `setup-wizard-gate.contract.test.ts` in the same directory is an example of a *real* contract test: it starts a live admin server (guarded by `OPENPALM_INTEGRATION=1`), sends HTTP requests, and validates status codes and response shapes. The three fake tests should be brought up to that standard or moved out of the contract test suite.

These fake tests run as part of the `contracts` CI gate in `release.yml` (`bun test --filter contract`), giving a false sense of coverage. They also run via `bun run test:contracts`.

## Current Test Content Analysis

### `admin-api.contract.test.ts` (19 lines)

- Reads `dev/docs/api-reference.md` with `readFileSync`
- Asserts 9 string-inclusion checks (6 `toBe(true)`, 3 `toBe(false)`)
- Checks: `/setup/status`, `/command`, `/state`, `/plugins/install`, `/secrets`, `/connections` (false), `/automations`, `/providers` (false), `/stack/spec` (false)
- **Verdict:** Pure documentation lint. Should be a pre-commit hook or lint script.

### `readme-no-npx.test.ts` (24 lines)

- Reads `README.md`
- Asserts no `npx ` / `npx@` / `bunx ` / `bunx@` strings exist
- Asserts `curl -fsSL` and `install.sh` are present
- **Verdict:** Documentation policy enforcement. Should be a pre-commit hook or lint script.

### `channel-message.contract.test.ts` (38 lines)

- Imports the `ChannelMessage` type from `@openpalm/lib/shared/channel-sdk.ts` (type-only)
- Defines a local `validateChannelMessage()` function in the test file
- Tests the local function against 3 hardcoded payloads
- Never sends anything over HTTP, never contacts the gateway
- **Verdict:** Tests a helper that only exists inside the test. The `ChannelMessage` type is already enforced by TypeScript. Delete entirely or replace with a real gateway contract test.

## Plan

### Phase 1: Move doc-lint checks to a pre-commit hook / lint script

The project already has a hooks infrastructure:
- `package.json` `"prepare"` script sets `git config core.hooksPath dev/hooks`
- `dev/hooks/pre-commit` exists and checks bun.lock parity

**Action:** Create a `dev/scripts/lint-docs.sh` script that contains the documentation checks, and call it from the pre-commit hook. This keeps the checks running but removes them from the contract test suite.

#### `dev/scripts/lint-docs.sh` (new file)

```bash
#!/bin/sh
# Documentation lint checks -- run from pre-commit hook and CI.
# Exit non-zero if documentation invariants are violated.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
EXIT=0

# --- api-reference.md must document key admin endpoints ---
API_REF="$REPO_ROOT/dev/docs/api-reference.md"
if [ -f "$API_REF" ]; then
  for endpoint in "/setup/status" "/command" "/state" "/secrets" "/automations"; do
    if ! grep -qF "$endpoint" "$API_REF"; then
      echo "ERROR: $API_REF missing documentation for $endpoint"
      EXIT=1
    fi
  done
fi

# --- README must not reference npx/bunx install paths ---
README="$REPO_ROOT/README.md"
if [ -f "$README" ]; then
  if grep -qE 'npx |npx@' "$README"; then
    echo "ERROR: README.md references npx (ISSUE-5 violation)"
    EXIT=1
  fi
  if grep -qE 'bunx |bunx@' "$README"; then
    echo "ERROR: README.md references bunx (ISSUE-5 violation)"
    EXIT=1
  fi
  if ! grep -qF 'curl -fsSL' "$README"; then
    echo "ERROR: README.md missing curl install instructions"
    EXIT=1
  fi
  if ! grep -qF 'install.sh' "$README"; then
    echo "ERROR: README.md missing install.sh reference"
    EXIT=1
  fi
fi

exit $EXIT
```

#### `dev/hooks/pre-commit` (modify)

Add a call to the lint-docs script after the existing bun.lock check:

```bash
# --- Documentation lint ---
STAGED_DOCS=$(git diff --cached --name-only -- 'README.md' 'dev/docs/api-reference.md')
if [ -n "$STAGED_DOCS" ]; then
  sh "$(dirname "$0")/../scripts/lint-docs.sh"
fi
```

#### Optional: Add a `lint:docs` npm script

Add to `package.json` scripts:

```json
"lint:docs": "sh dev/scripts/lint-docs.sh"
```

This allows CI to run `bun run lint:docs` independently of the contract test suite.

### Phase 2: Delete the fake contract tests

#### Files to delete

| File | Reason |
|---|---|
| `test/contracts/admin-api.contract.test.ts` | Replaced by `dev/scripts/lint-docs.sh` |
| `test/contracts/readme-no-npx.test.ts` | Replaced by `dev/scripts/lint-docs.sh` |
| `test/contracts/channel-message.contract.test.ts` | Tests a test-local helper, not a real contract |

### Phase 3: Write a real admin API contract test

Replace `admin-api.contract.test.ts` with an actual contract test that starts the admin server and validates endpoint behavior. Model it after `setup-wizard-gate.contract.test.ts`.

#### `test/contracts/admin-api.contract.test.ts` (new file, same name)

The test should be guarded by `OPENPALM_INTEGRATION=1` (same as the setup wizard test) since it requires a running admin server. It should validate:

1. **`GET /health`** -- Returns 200 with `{ ok: true, service: "admin" }`
2. **`GET /setup/status`** -- Returns 200 (when setup not complete) or 401 (when complete and no auth)
3. **`POST /command` without auth** -- Returns 401 with JSON error body
4. **`POST /command` with auth, unknown command** -- Returns 400 with `{ ok: false, error: "unknown_command" }`
5. **`GET /state` without auth** -- Returns 401
6. **`GET /state` with auth** -- Returns 200 with `{ ok: true, data: { setup, spec, secrets, ... } }`
7. **`GET /secrets` without auth** -- Returns 401
8. **`GET /secrets` with auth** -- Returns 200 with `{ ok: true, ... }`
9. **`GET /automations` without auth** -- Returns 401
10. **`GET /automations` with auth** -- Returns 200 with `{ automations: [...] }`
11. **`GET /meta`** -- Returns 200 with version metadata

Skeleton:

```typescript
import { describe, expect, it } from "bun:test";

const ADMIN_BASE = "http://localhost:8100";
const ADMIN_TOKEN = "dev-admin-token";
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

function adminFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${ADMIN_BASE}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
}

function authedFetch(path: string, opts: RequestInit = {}) {
  return adminFetch(path, {
    ...opts,
    headers: { "x-admin-token": ADMIN_TOKEN, ...opts.headers },
  });
}

describe.skipIf(!stackAvailable)("contract: admin API endpoints", () => {
  describe("GET /health", () => {
    it("returns 200 with service identity", async () => {
      const resp = await adminFetch("/health");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; service: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe("admin");
    });
  });

  describe("GET /state (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/state");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth and expected shape", async () => {
      const resp = await authedFetch("/state");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.setup).toBeDefined();
      expect(body.data.spec).toBeDefined();
    });
  });

  describe("POST /command (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "service.status" }),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 400 for unknown command type", async () => {
      const resp = await authedFetch("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "nonexistent.command" }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unknown_command");
    });
  });

  describe("GET /secrets (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/secrets");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with valid auth", async () => {
      const resp = await authedFetch("/secrets");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /automations (auth required)", () => {
    it("returns 401 without auth token", async () => {
      const resp = await adminFetch("/automations");
      expect(resp.status).toBe(401);
    });

    it("returns 200 with automations array", async () => {
      const resp = await authedFetch("/automations");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { automations: unknown[] };
      expect(Array.isArray(body.automations)).toBe(true);
    });
  });
});
```

### Phase 4 (optional): Write a real channel-message contract test

If a real contract test for the channel message flow is desired, it should send an actual HTTP request to the gateway's `/channel/inbound` endpoint and validate the response. This would be guarded by `OPENPALM_INTEGRATION=1`.

This is lower priority since:
- The `ChannelMessage` type is enforced at compile time
- The gateway already has its own unit tests for intake validation (`core/gateway/src/server.test.ts`)
- The `setup-wizard-gate.contract.test.ts` already covers live HTTP contract testing patterns

If implemented, it would look like:

```typescript
import { describe, expect, it } from "bun:test";

const GATEWAY_BASE = "http://localhost:8080";
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";

describe.skipIf(!stackAvailable)("contract: channel inbound", () => {
  it("rejects unsigned payload with 401", async () => {
    const resp = await fetch(`${GATEWAY_BASE}/channel/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "test:1", channel: "test", text: "hi", nonce: "n", timestamp: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
    expect(resp.status).toBe(401);
  });

  it("rejects payload missing required fields with 400", async () => {
    const resp = await fetch(`${GATEWAY_BASE}/channel/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-channel-signature": "invalid" },
      body: JSON.stringify({ channel: "test" }),
      signal: AbortSignal.timeout(5000),
    });
    expect([400, 401]).toContain(resp.status);
  });
});
```

## Step-by-Step Implementation Instructions

### Step 1: Create the lint-docs script

1. Create `dev/scripts/lint-docs.sh` with the content described above
2. Make it executable: `chmod +x dev/scripts/lint-docs.sh`
3. Verify it passes: `sh dev/scripts/lint-docs.sh`

### Step 2: Update the pre-commit hook

1. Edit `dev/hooks/pre-commit` to add the doc-lint call (gated on staged doc files)
2. Verify: stage a README change and run the hook manually

### Step 3: Add the `lint:docs` script to `package.json`

1. Add `"lint:docs": "sh dev/scripts/lint-docs.sh"` to the `scripts` section

### Step 4: Delete the fake contract tests

1. Delete `test/contracts/admin-api.contract.test.ts`
2. Delete `test/contracts/readme-no-npx.test.ts`
3. Delete `test/contracts/channel-message.contract.test.ts`
4. Verify: `bun run test:contracts` should still pass (only `setup-wizard-gate.contract.test.ts` remains, and it skips without `OPENPALM_INTEGRATION=1`)

### Step 5: Write the real admin API contract test

1. Create the new `test/contracts/admin-api.contract.test.ts` with the real HTTP contract test (see Phase 3 above)
2. Verify locally with stack running: `OPENPALM_INTEGRATION=1 bun test --filter contract`
3. Verify without stack: `bun test --filter contract` (should skip gracefully)

### Step 6 (optional): Write the real channel-message contract test

1. Create `test/contracts/channel-inbound.contract.test.ts` (note: renamed to reflect what it actually tests)
2. Guard with `OPENPALM_INTEGRATION=1`

### Step 7: Consider adding lint-docs to CI

Add `bun run lint:docs` to the `unit-tests` job in `release.yml` so the doc checks still run in CI even if someone bypasses the pre-commit hook:

```yaml
unit-tests:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install --frozen-lockfile
    - run: bun run typecheck
    - run: bun run lint:docs
    - run: bun test
```

## Files Summary

### Files to delete

| File | Reason |
|---|---|
| `test/contracts/admin-api.contract.test.ts` | Fake contract test (doc-string check) |
| `test/contracts/readme-no-npx.test.ts` | Fake contract test (README lint) |
| `test/contracts/channel-message.contract.test.ts` | Fake contract test (tests a local helper) |

### Files to create

| File | Purpose |
|---|---|
| `dev/scripts/lint-docs.sh` | Shell script with doc-lint checks (replaces the two deleted test files) |
| `test/contracts/admin-api.contract.test.ts` | Real contract test that hits live admin endpoints |
| `test/contracts/channel-inbound.contract.test.ts` (optional) | Real contract test for gateway channel inbound |

### Files to modify

| File | Change |
|---|---|
| `dev/hooks/pre-commit` | Add doc-lint call when README or api-reference.md are staged |
| `package.json` | Add `"lint:docs"` script |
| `.github/workflows/release.yml` | Add `bun run lint:docs` to unit-tests job (optional but recommended) |

## Verification Steps

1. **Lint script works standalone:**
   ```bash
   sh dev/scripts/lint-docs.sh
   # Should exit 0
   ```

2. **Pre-commit hook triggers on doc changes:**
   ```bash
   echo "test" >> README.md
   git add README.md
   git hook run pre-commit
   # Should run lint-docs checks
   git checkout -- README.md
   ```

3. **Contract tests pass without stack (skip gracefully):**
   ```bash
   bun run test:contracts
   # All tests should skip (OPENPALM_INTEGRATION not set)
   # No failures
   ```

4. **Contract tests pass with stack:**
   ```bash
   bun run dev:up
   OPENPALM_INTEGRATION=1 bun run test:contracts
   # Real HTTP tests should pass against live admin server
   ```

5. **Full test suite still passes:**
   ```bash
   bun test
   # No regressions
   ```

6. **CI pipeline still works:**
   - The `contracts` job in `release.yml` should still pass (tests skip without integration env)
   - The `unit-tests` job should run `lint:docs` if that change is included

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Removing doc-lint tests from CI contract gate | Add `lint:docs` to the `unit-tests` CI job so checks still run |
| Real contract tests require running stack | Guard with `OPENPALM_INTEGRATION=1`; tests skip cleanly in CI without stack |
| Pre-commit hook only runs on staged doc files | CI `lint:docs` step catches anything the hook misses |
| `channel-message.contract.test.ts` deletion removes all channel contract coverage | TypeScript enforces the type at compile time; gateway unit tests cover runtime validation; optional Phase 4 adds a real contract test |
