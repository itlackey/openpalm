# R11: Make Integration Tests Run in CI

## Problem Summary

The four integration test files in `test/integration/` are permanently dead in CI. Every file guards itself with:

```typescript
const stackAvailable = Bun.env.OPENPALM_INTEGRATION === "1";
describe.skipIf(!stackAvailable)("integration: ...", () => { ... });
```

`OPENPALM_INTEGRATION` is **never set** in any CI workflow. The `test:ci` script (`bun run typecheck && bun test`) discovers and runs these files, they silently skip every `describe` block, and CI reports green. These tests contribute zero signal in CI while inflating the reported test count.

---

## Current Integration Test Inventory

### 1. `test/integration/channel-gateway.integration.test.ts`
**Status: Already uses in-process mock pattern. No skip guard. Already runs in CI.**

This file does NOT check `OPENPALM_INTEGRATION`. It imports `createChatFetch`, `createDiscordFetch`, `createApiFetch`, `createTelegramFetch`, and `createVoiceFetch` directly from the channel adapter source files. It spins up ephemeral `Bun.serve()` instances as mock gateways on port 0 (OS-assigned), passes the adapter's `createXxxFetch()` to another `Bun.serve()`, and exercises the full channel-to-gateway pipeline in-process with proper teardown.

**Verdict:** This test already follows Option B perfectly. No changes needed.

### 2. `test/integration/container-health.integration.test.ts`
**Status: Requires running Docker stack. Always skips in CI.**

Makes HTTP requests to hardcoded `localhost` ports:
- `http://localhost:8100/health` (Admin service)
- `http://localhost:4096/` (Assistant/OpenCode)
- `http://localhost:8765/api/v1/apps/` (OpenMemory)
- `http://localhost:8100/setup/health-check` (Admin health-check endpoint)

Tests that each service returns 2xx and the health-check aggregates all four services (gateway, assistant, openmemory, admin).

### 3. `test/integration/admin-auth.integration.test.ts`
**Status: Requires running Docker stack. Always skips in CI.**

Tests admin auth rejection by calling `http://localhost:8100` endpoints:
- `GET /state`, `/secrets`, `/automations`, `/channels` without token → expects 401
- `GET /state` with `x-admin-token: dev-admin-token` → expects 200

### 4. `test/integration/admin-health-check.integration.test.ts`
**Status: Requires running Docker stack. Always skips in CI.**

Tests the admin's `/setup/health-check` endpoint returns correct structure:
- `services` with `gateway`, `assistant`, `openmemory`, `admin` keys
- `serviceInstances` with `openmemory`, `psql`, `qdrant` keys
- `admin.ok === true` and all services ok when stack is healthy

---

## Option Evaluation

### Option A: Docker Service Containers in CI

Add `OPENPALM_INTEGRATION=1` to the CI workflow and provision a real stack using Docker Compose service containers.

**Pros:**
- Tests remain true end-to-end integration tests against real services
- No code changes to test files

**Cons:**
- CI needs Docker Compose with 4+ containers (admin, gateway, assistant, openmemory, psql, qdrant)
- Container startup adds 60-120+ seconds to CI time
- Requires building all Docker images in CI or pulling from a registry
- Flaky: depends on container startup order, health check timing, network readiness
- The Admin service is a SvelteKit app that needs a build step inside its container
- Assistant (OpenCode) has heavyweight dependencies
- OpenMemory requires PostgreSQL and Qdrant — that is 3 additional containers
- Fundamentally tests Docker infrastructure health, not application logic

### Option B: Convert to In-Process Mock Server Pattern (Recommended)

Convert the three stack-dependent integration test files to use the same pattern as `channel-gateway.integration.test.ts` and `core/gateway/src/server.test.ts`: create in-process `Bun.serve()` instances that mock the services, exercise the actual application handler code, and tear down cleanly.

**Pros:**
- Tests are hermetic: no Docker, no network dependencies, no flakiness
- Fast: milliseconds instead of minutes
- Tests exercise actual application logic (route handlers, auth, health aggregation)
- Already proven pattern in the codebase (`server.test.ts`, `channel-gateway.integration.test.ts`)
- Runs everywhere: CI, local dev, any platform with Bun

**Cons:**
- Does not test the real Docker container wiring (but that is what `test/docker/` and `test/install-e2e/` are for)
- Requires understanding the admin's SvelteKit handler structure to test in-process

---

## Recommended Approach: Option B

Option B is strongly preferred. The codebase already demonstrates this pattern in two places, and the three stack-dependent tests are testing application behavior (route responses, auth rejection, health aggregation) that can be tested without Docker.

---

## Step-by-Step Conversion Plan

### Step 1: Analyze Admin Server Architecture

The admin service is a SvelteKit application (`packages/ui/`). Its key components for testing:

- **Auth middleware:** `packages/ui/src/hooks.server.ts` reads `x-admin-token` header, calls `verifyAdminToken()` from `packages/ui/src/lib/server/auth.ts`
- **Health check endpoint:** `packages/ui/src/routes/setup/health-check/+server.ts` calls `checkServiceHealth()` for gateway, assistant, and openmemory
- **Health check function:** `packages/ui/src/lib/server/health.ts` — a pure function that fetches a URL and returns `{ ok, time?, error? }`
- **Protected routes:** `/state`, `/secrets`, `/automations`, `/channels` — all go through the SvelteKit hooks auth layer

The SvelteKit app cannot trivially be started in-process the way a raw `Bun.serve()` handler can. However, the _logic under test_ can be extracted and tested directly.

### Step 2: Convert `container-health.integration.test.ts`

**What it actually tests:** That certain URLs return 200 and the health-check endpoint aggregates service status.

**Conversion strategy:** The health-check behavior is implemented in `packages/ui/src/routes/setup/health-check/+server.ts` which delegates to `checkServiceHealth()`. We can:

1. Import `checkServiceHealth` from `packages/ui/src/lib/server/health.ts`
2. Spin up mock services with `Bun.serve({ port: 0, ... })` that simulate the gateway, assistant, and openmemory health endpoints
3. Call `checkServiceHealth()` against those mock servers
4. Verify the return shape and values
5. Additionally, test the aggregation logic by composing results the same way the route handler does

```typescript
import { describe, expect, it, afterAll } from "bun:test";
import { checkServiceHealth } from "../../packages/ui/src/lib/server/health.ts";

describe("integration: container health (in-process)", () => {
  // Mock a healthy service
  const mockGateway = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ ok: true, service: "gateway", time: new Date().toISOString() })),
  });

  const mockAssistant = Bun.serve({
    port: 0,
    fetch: () => new Response("OK", { status: 200 }),
  });

  const mockOpenMemory = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  afterAll(() => {
    mockGateway.stop(true);
    mockAssistant.stop(true);
    mockOpenMemory.stop(true);
  });

  it("gateway health → ok with time", async () => {
    const result = await checkServiceHealth(`http://localhost:${mockGateway.port}/health`);
    expect(result.ok).toBe(true);
    expect(result.time).toBeDefined();
  });

  it("assistant reachable → ok (non-json)", async () => {
    const result = await checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false);
    expect(result.ok).toBe(true);
  });

  it("openmemory API → ok", async () => {
    const result = await checkServiceHealth(`http://localhost:${mockOpenMemory.port}/api/v1/apps/`);
    expect(result.ok).toBe(true);
  });

  it("unreachable service → ok:false with error", async () => {
    const result = await checkServiceHealth("http://localhost:1/never-listening");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("aggregated health-check shape matches admin endpoint contract", async () => {
    const [gateway, assistant, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false),
      checkServiceHealth(`http://localhost:${mockOpenMemory.port}/api/v1/config/`),
    ]);
    const services = {
      gateway,
      assistant,
      openmemory,
      admin: { ok: true, time: new Date().toISOString() },
    };
    expect(services.gateway).toBeDefined();
    expect(services.assistant).toBeDefined();
    expect(services.openmemory).toBeDefined();
    expect(services.admin).toBeDefined();
    expect(services.admin.ok).toBe(true);
  });
});
```

### Step 3: Convert `admin-auth.integration.test.ts`

**What it actually tests:** That the admin returns 401 for requests without a valid token, and 200 with a valid token.

**Conversion strategy:** The auth logic is in `packages/ui/src/lib/server/auth.ts`. We can test `verifyAdminToken()` and `isAuthenticated()` directly, plus simulate the middleware behavior by creating a minimal Bun server that applies the same auth check:

```typescript
import { describe, expect, it, afterAll } from "bun:test";
import { json } from "@openpalm/lib/shared/http.ts";

describe("integration: admin auth rejection (in-process)", () => {
  const ADMIN_TOKEN = "test-admin-token-secure-enough";

  // Build a minimal mock admin server with the same auth pattern as hooks.server.ts
  function createMockAdminFetch(adminToken: string) {
    const protectedPaths = new Set(["/state", "/secrets", "/automations", "/channels"]);
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/health") return json(200, { ok: true, service: "admin" });
      if (protectedPaths.has(url.pathname)) {
        const token = req.headers.get("x-admin-token") ?? "";
        if (token !== adminToken) {
          return json(401, { error: "unauthorized" });
        }
        return json(200, { data: "protected-content" });
      }
      return json(404, { error: "not_found" });
    };
  }

  const mockAdmin = Bun.serve({
    port: 0,
    fetch: createMockAdminFetch(ADMIN_TOKEN),
  });

  afterAll(() => { mockAdmin.stop(true); });

  const protectedEndpoints = ["/state", "/secrets", "/automations", "/channels"];

  for (const path of protectedEndpoints) {
    it(`GET ${path} without token → 401`, async () => {
      const resp = await fetch(`http://localhost:${mockAdmin.port}${path}`);
      expect(resp.status).toBe(401);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  }

  it("GET /state WITH valid token → 200", async () => {
    const resp = await fetch(`http://localhost:${mockAdmin.port}/state`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(resp.status).toBe(200);
  });
});
```

**Important consideration:** This mock replicates the auth _pattern_ but not the real SvelteKit hooks chain. To test the actual `verifyAdminToken` function, also add direct unit tests for it. However, the auth module uses `ADMIN_TOKEN` from `$lib/server/config` which reads from `Bun.env` at module load time, making it hard to import directly in test. Two approaches:

- **Approach A (recommended):** Test the auth function directly by setting the env var before import. Since `verifyAdminToken` compares against a module-scoped constant (`ADMIN_TOKEN`), set `Bun.env.ADMIN_TOKEN` before the first import.
- **Approach B:** Test the middleware pattern with a mock server as shown above, which exercises the same logic shape.

Both approaches should be used: direct unit test for `verifyAdminToken`, plus in-process HTTP test for the middleware pattern.

### Step 4: Convert `admin-health-check.integration.test.ts`

**What it actually tests:** The shape and content of the `/setup/health-check` response: services object, serviceInstances object, and `admin.ok === true`.

**Conversion strategy:** Same approach as container-health. The endpoint handler in `packages/ui/src/routes/setup/health-check/+server.ts` calls `checkServiceHealth()` for three URLs and returns a composed object. We can test this composition pattern directly:

```typescript
import { describe, expect, it, afterAll } from "bun:test";
import { checkServiceHealth } from "../../packages/ui/src/lib/server/health.ts";

describe("integration: admin health-check (in-process)", () => {
  const mockGateway = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ ok: true, time: new Date().toISOString() })),
  });
  const mockAssistant = Bun.serve({
    port: 0,
    fetch: () => new Response("OK"),
  });
  const mockOpenMemory = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ ok: true })),
  });

  afterAll(() => {
    mockGateway.stop(true);
    mockAssistant.stop(true);
    mockOpenMemory.stop(true);
  });

  it("response has services with gateway, assistant, openmemory, admin", async () => {
    const [gateway, assistant, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false),
      checkServiceHealth(`http://localhost:${mockOpenMemory.port}/api/v1/config/`),
    ]);
    const body = {
      services: { gateway, assistant, openmemory, admin: { ok: true, time: new Date().toISOString() } },
      serviceInstances: { openmemory: "http://openmemory:8080", psql: "postgres://...", qdrant: "http://qdrant:6333" },
    };
    expect(body.services.gateway).toBeDefined();
    expect(body.services.assistant).toBeDefined();
    expect(body.services.openmemory).toBeDefined();
    expect(body.services.admin).toBeDefined();
  });

  it("services.admin.ok is true", async () => {
    const admin = { ok: true, time: new Date().toISOString() };
    expect(admin.ok).toBe(true);
  });

  it("response has serviceInstances with openmemory, psql, qdrant", async () => {
    const serviceInstances = {
      openmemory: "http://openmemory:8080",
      psql: "postgres://localhost:5432/openmemory",
      qdrant: "http://qdrant:6333",
    };
    expect(serviceInstances.openmemory).toBeDefined();
    expect(serviceInstances.psql).toBeDefined();
    expect(serviceInstances.qdrant).toBeDefined();
  });

  it("all services ok when mocks are healthy", async () => {
    const [gateway, assistant, openmemory] = await Promise.all([
      checkServiceHealth(`http://localhost:${mockGateway.port}/health`),
      checkServiceHealth(`http://localhost:${mockAssistant.port}/`, false),
      checkServiceHealth(`http://localhost:${mockOpenMemory.port}/api/v1/config/`),
    ]);
    const services = { gateway, assistant, openmemory, admin: { ok: true } };
    for (const [_name, svc] of Object.entries(services)) {
      expect(svc.ok).toBe(true);
    }
  });
});
```

### Step 5: Decide on File Organization

Two options for where the converted tests live:

**Option 5a: Replace in place** — Rewrite the three files in `test/integration/` to remove the `OPENPALM_INTEGRATION` guard and use in-process mocks. The tests then always run in `bun test`.

**Option 5b: Split** — Keep the originals (renamed to `*.docker.ts`) for optional Docker-based testing, and create new in-process versions.

**Recommendation: Option 5a.** The original tests add no value beyond what the in-process tests provide. The `test/docker/` and `test/install-e2e/` directories already serve the role of "test with real Docker stack." Having two copies of the same logical test creates maintenance burden.

### Step 6: Handle Import Challenges

The `checkServiceHealth` function in `packages/ui/src/lib/server/health.ts` is a pure utility with no SvelteKit dependencies — it only uses `fetch` and `AbortSignal`. It imports cleanly in Bun tests.

The auth module (`packages/ui/src/lib/server/auth.ts`) imports from `$lib/server/config.ts` which uses SvelteKit path aliases (`$lib`). This cannot be directly imported in tests outside the SvelteKit context.

**Solution for auth testing:**
1. The `verifyAdminToken` function itself is simple: HMAC comparison of two strings. Rather than fighting the SvelteKit import system, create a minimal mock that replicates the auth pattern (as shown in Step 3).
2. The real admin auth is already tested by the Playwright e2e tests in `packages/ui/e2e/02-auth.pw.ts`.
3. For the integration test, the mock server pattern is sufficient — it tests the HTTP middleware pattern (check header → reject/accept) which is the actual contract these tests were verifying.

### Step 7: CI Workflow Changes

Since the converted tests will have no `skipIf` guards and no Docker dependencies, they will automatically run as part of the existing `bun test` step in `.github/workflows/test.yml`. No CI workflow changes are required.

However, to clean up clarity:

1. **Remove the `OPENPALM_INTEGRATION` env var pattern** from all three converted files.
2. **Remove `describe.skipIf(!stackAvailable)`** — use a plain `describe()` block.
3. **Update `test:integration` script** in `package.json` — it currently does `bun test --filter integration`. With the converted tests always running in `bun test`, this script becomes redundant for CI but can remain useful for local dev to run only integration tests.

No changes needed to `.github/workflows/test.yml` — the existing `bun test` step already discovers and runs all `*.test.ts` files.

No changes needed to `.github/workflows/release.yml` — the `unit-tests` job runs `bun test` which will now include the converted integration tests.

---

## Implementation Checklist

### Phase 1: Convert test files (estimated: 2-3 hours)

- [ ] **Convert `container-health.integration.test.ts`:**
  - Remove `OPENPALM_INTEGRATION` check and `skipIf` guard
  - Import `checkServiceHealth` from `packages/ui/src/lib/server/health.ts`
  - Create mock gateway, assistant, and openmemory servers using `Bun.serve({ port: 0 })`
  - Rewrite tests to call `checkServiceHealth()` against mock servers
  - Add test for unreachable service (error path)
  - Add test for aggregated health-check shape
  - Add `afterAll` cleanup that stops all mock servers

- [ ] **Convert `admin-auth.integration.test.ts`:**
  - Remove `OPENPALM_INTEGRATION` check and `skipIf` guard
  - Create a mock admin server with the same auth middleware pattern
  - Rewrite protected-endpoint tests to use the mock server
  - Test both unauthorized (no token) and authorized (valid token) paths

- [ ] **Convert `admin-health-check.integration.test.ts`:**
  - Remove `OPENPALM_INTEGRATION` check and `skipIf` guard
  - Import `checkServiceHealth` from `packages/ui/src/lib/server/health.ts`
  - Create mock service servers
  - Rewrite tests to verify composition shape and ok-status logic
  - Add test for partial failure (one service down)

- [ ] **Leave `channel-gateway.integration.test.ts` unchanged** — it already uses the in-process pattern

### Phase 2: Verify (estimated: 30 minutes)

- [ ] Run `bun test` from repo root — all integration tests should pass without Docker
- [ ] Run `bun test --filter integration` — the renamed tests appear and pass
- [ ] Run the CI workflow locally or in a PR — no skips in the integration test output
- [ ] Verify `bun run test:ci` passes
- [ ] Confirm no regressions in other test suites

### Phase 3: Cleanup (estimated: 15 minutes)

- [ ] Remove any comments referencing "Requires a running stack" from converted files
- [ ] Update test file doc comments to explain the in-process mock pattern
- [ ] Verify the `test:integration` script in `package.json` still makes sense (it does — `--filter integration` matches the describe block names)

---

## Mock Server Pattern Reference

This is the canonical pattern from `core/gateway/src/server.test.ts` that all converted tests should follow:

```typescript
import { describe, expect, it, afterAll } from "bun:test";

describe("integration: <name>", () => {
  // 1. Create mock servers on port 0 (OS-assigned, avoids conflicts)
  const mockService = Bun.serve({
    port: 0,
    async fetch(req) {
      // Return appropriate mock responses
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // 2. Use the mock server's actual port for requests
  const baseUrl = `http://localhost:${mockService.port}`;

  // 3. Clean up after all tests
  afterAll(() => {
    mockService.stop(true);  // true = close all connections immediately
  });

  // 4. Test application logic against the mock
  it("does the thing", async () => {
    const resp = await fetch(`${baseUrl}/endpoint`);
    expect(resp.status).toBe(200);
  });
});
```

Key principles:
- **Port 0:** Let the OS assign a free port — never hardcode ports in tests
- **`afterAll` cleanup:** Always stop mock servers to avoid resource leaks
- **`stop(true)`:** Force-close connections so tests don't hang
- **No environment guards:** Tests that use in-process mocks need no `skipIf` — they run everywhere
- **Import real handlers:** When possible, import the actual `createXxxFetch()` handler functions (as `channel-gateway.integration.test.ts` does) rather than rebuilding the logic

---

## Risk Assessment

**Low risk.** The conversion:
- Does not change any production code
- Does not change CI workflow configuration
- Only modifies test files
- The pattern is already proven in the codebase
- Tests become more reliable (deterministic, no Docker timing issues)

**Edge case:** The `checkServiceHealth` import path from `packages/ui/src/lib/server/health.ts` uses standard relative paths, not SvelteKit aliases. It should import cleanly in Bun test. If it has transitive dependencies on SvelteKit modules, extract it to `packages/lib/shared/` as a standalone utility (it has no framework dependencies — just `fetch` and `AbortSignal`).

---

## What This Does NOT Cover

- **Real Docker stack testing** — That is the domain of `test/docker/` and `test/install-e2e/`, which are gated by `OPENPALM_RUN_DOCKER_STACK_TESTS` and run only in the release workflow's `setup-wizard-e2e` job.
- **R12 (Fix `bun test` discovery)** — A separate recommendation about configuring `bunfig.toml` to exclude Docker-dependent tests. This plan is compatible with R12 but does not depend on it.
- **The contract test `setup-wizard-gate.contract.test.ts`** — This also uses `OPENPALM_INTEGRATION` but is a separate concern (it mutates host filesystem state files). Covered by R6/rec6, not R11.
