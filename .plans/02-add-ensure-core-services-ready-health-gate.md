# Implementation Plan: Add `ensureCoreServicesReady()` Health Gate (P0)

## Objective

Make `setup.complete` succeed only when the core runtime is actually converged (running + healthy where supported), while preserving architecture constraints:

- thin wrapper over Docker Compose,
- single orchestration path for setup completion,
- direct Docker error visibility (no opaque recovery layer).

Primary reference: `dev/docs/install-setup-simplification-reliability-report-consolidated.md:207`.

## Current Baseline (integration anchors)

- Core service list exists in `packages/lib/src/admin/compose-runner.ts:4` and is the best canonical source.
- `setup.complete` currently does `applyStack` + `composeAction('up')` + `completeSetup()` without readiness convergence in `packages/ui/src/routes/command/+server.ts:348`.
- Parallel completion path duplicates behavior in `packages/ui/src/routes/setup/complete/+server.ts:15`.
- Existing point-in-time health probe route exists at `packages/ui/src/routes/setup/health-check/+server.ts:13` using `checkServiceHealth` from `packages/ui/src/lib/server/health.ts:1`.
- `applyStack` already enforces render/validate/write boundary with `docker compose config` in `packages/lib/src/admin/stack-apply-engine.ts:14`.

## Proposed API and Contract

### New orchestration primitive

Add a reusable function in shared lib admin layer:

- `packages/lib/src/admin/core-readiness.ts:1`

```ts
export type EnsureCoreServicesReadyOptions = {
  services?: string[];
  timeoutMs?: number;        // default: 180_000
  pollIntervalMs?: number;   // default: 2_000
  requireHealthy?: boolean;  // default: true
  logTailLines?: number;     // default: 80
  runner?: ComposeRunner;    // DI for tests
  checkHttp?: (service: HttpProbeTarget) => Promise<HttpProbeResult>; // DI for tests
};

export async function ensureCoreServicesReady(
  options?: EnsureCoreServicesReadyOptions
): Promise<EnsureCoreServicesReadyResult>;
```

### Success criteria (hard contract)

`ensureCoreServicesReady()` returns `{ ok: true }` only when all are true:

1. `runner.configValidate()` succeeds.
2. `runner.action('up', coreServices)` succeeds.
3. `runner.ps()` indicates every target service is running.
4. If healthcheck exists and `requireHealthy=true`, service health is `healthy`.
5. HTTP probes pass for `admin`, `gateway`, `assistant`, `openmemory`.

### Failure contract

On non-convergence or compose failure, return `{ ok: false, code: 'setup_not_ready', diagnostics }` and include raw compose stderr and service logs in diagnostics. Do not swallow/replace Docker errors.

## Data Structures

Define in `packages/lib/src/admin/core-readiness.ts:1` (or adjacent `types` file if needed):

```ts
type CoreServiceProbe = {
  name: string;
  composeStatus: string;      // from compose ps state/status
  composeHealth?: string|null;
  http?: { ok: boolean; error?: string; statusCode?: number };
  ready: boolean;
};

type CoreReadinessDiagnostics = {
  code: 'setup_not_ready' | 'compose_config_failed' | 'compose_up_failed';
  composeErrorCode?: ComposeErrorCode;
  elapsedMs: number;
  attempts: number;
  failedServices: string[];
  services: CoreServiceProbe[];
  compose: {
    configStderr?: string;
    upStderr?: string;
  };
  logs: Record<string, string>; // tail output keyed by service
  suggestedCommands: string[];
};

type EnsureCoreServicesReadyResult =
  | { ok: true; services: CoreServiceProbe[]; elapsedMs: number; attempts: number }
  | { ok: false; code: 'setup_not_ready'; diagnostics: CoreReadinessDiagnostics };
```

Notes:

- Reuse `ServiceHealthState` from `packages/lib/src/admin/compose-runner.ts:147`.
- Reuse `ComposeErrorCode` from `packages/lib/src/types.ts:18` and map compose failures consistently.

## Polling / Retry / Timeout Behavior

### Algorithm

1. Validate compose (`runner.configValidate()`).
2. Start target services via one `runner.action('up', services)` call.
3. Poll loop until timeout:
   - call `runner.ps()` each iteration,
   - evaluate per-service readiness rules,
   - run HTTP probes for `admin/gateway/assistant/openmemory`,
   - exit early on full convergence.
4. On timeout or persistent unhealthy state:
   - collect `runner.logs(service, logTailLines)` for failed services only,
   - return structured diagnostics + next-step commands.

### Defaults

- `timeoutMs = 180000`
- `pollIntervalMs = 2000`
- `requireHealthy = true`
- `logTailLines = 80`

### Retry stance

- No hidden compose retry loops beyond existing compose-runner behavior in `packages/lib/src/compose-runner.ts:77`.
- Polling is convergence checking, not custom orchestration recovery.
- Keep Docker stderr visible in returned payload.

## Diagnostics Payload (wire contract)

Return from `setup.complete` on readiness failure:

```json
{
  "ok": false,
  "code": "setup_not_ready",
  "error": "core services did not become ready before timeout",
  "details": {
    "failedServices": ["gateway"],
    "services": [
      {
        "name": "gateway",
        "composeStatus": "running",
        "composeHealth": "starting",
        "http": { "ok": false, "error": "status 503" },
        "ready": false
      }
    ],
    "logs": {
      "gateway": "<tail output>"
    },
    "compose": {
      "upStderr": "<raw docker stderr>"
    },
    "suggestedCommands": [
      "docker compose ps",
      "docker compose logs gateway --tail 80"
    ],
    "elapsedMs": 180000,
    "attempts": 90
  }
}
```

## Integration Points

1. `setup.complete` command path
   - Replace direct `composeAction('up', [...SetupCoreServices])` usage in `packages/ui/src/routes/command/+server.ts:359` with `ensureCoreServicesReady()`.
   - Gate `setupManager.completeSetup()` at `packages/ui/src/routes/command/+server.ts:362` on readiness success only.

2. Remove/merge duplicate completion endpoint behavior
   - Collapse duplicate orchestration in `packages/ui/src/routes/setup/complete/+server.ts:15` to call the same shared setup completion helper used by `/command`.
   - Remove local `CoreStartupServices` constant and import canonical list from lib (`CoreServices` in `packages/lib/src/admin/compose-runner.ts:4`) or a new shared derived list.

3. Health probe reuse
   - Reuse URL resolution pattern from `packages/ui/src/routes/setup/health-check/+server.ts:22` and `packages/ui/src/lib/server/health.ts:1`.
   - Avoid duplicate probe logic in multiple handlers.

4. Remove competing startup path
   - Delete `setup.start_core` branch in `packages/ui/src/routes/command/+server.ts:205`.
   - Remove fire-and-forget caller in `packages/ui/src/lib/components/SetupWizard.svelte:149`.

## Concrete Implementation Steps

### Code

1. Add readiness module and types
   - Create `packages/lib/src/admin/core-readiness.ts:1` with `ensureCoreServicesReady()` + result/diagnostic types.
   - Use `createComposeRunner`/`ComposeRunner` from `packages/lib/src/admin/compose-runner.ts:46`.

2. Keep canonical service source centralized
   - Continue using `CoreServices` from `packages/lib/src/admin/compose-runner.ts:4`.
   - Add helper for setup-target list if needed (e.g., include `admin` in health checks, but do not restart it unnecessarily).

3. Add shared setup completion service in UI server layer
   - Create `packages/ui/src/lib/server/setup-completion.ts:1` encapsulating:
     - POSTGRES password bootstrap logic currently duplicated in `packages/ui/src/routes/command/+server.ts:349` and `packages/ui/src/routes/setup/complete/+server.ts:29`.
     - `applyStack` call (`packages/lib/src/admin/stack-apply-engine.ts:22`).
     - `ensureCoreServicesReady` call.
     - `syncAutomations` + `setupManager.completeSetup()` only on readiness success.

4. Wire both endpoints to shared completion service
   - Update `packages/ui/src/routes/command/+server.ts:348`.
   - Update `packages/ui/src/routes/setup/complete/+server.ts:17`.

5. Remove non-authoritative startup side effects
   - Delete `setup.start_core` handler in `packages/ui/src/routes/command/+server.ts:205`.
   - Remove `setup.start_core` client call from `packages/ui/src/lib/components/SetupWizard.svelte:149`.

### Docs

6. Document new API contract + failure payload
   - Update `dev/docs/api-reference.md:33` with `setup.complete` success/failure schema including `code: setup_not_ready` and diagnostics fields.
   - Add operational troubleshooting notes to `docs/troubleshooting.md:1` for interpreting readiness diagnostics and running suggested commands.

7. Record architecture alignment
   - Append implementation note in `dev/docs/install-setup-simplification-reliability-report-consolidated.md:451` linking this plan’s completion criteria and confirming single orchestration path.

### Tests

8. Unit tests for readiness gate (lib)
   - Add `packages/lib/src/admin/core-readiness.test.ts:1` using `createMockRunner` from `packages/lib/src/admin/compose-runner.ts:94`.
   - Cases:
     - converges with healthy services,
     - timeout with partial health,
     - compose config failure,
     - compose up failure with propagated stderr.

9. Command route behavior tests (UI)
   - Replace string-matching tests in `packages/ui/src/routes/command/command-setup-flow.test.ts:1` with behavioral tests that mock readiness results and assert:
     - `setup.complete` returns success only after readiness ok,
     - `setup.complete` returns `setup_not_ready` diagnostics on failure,
     - `setup.start_core` is not accepted (unknown command or removed path).

10. Wizard sequencing test update
   - Extend `packages/ui/src/lib/components/setup-wizard-order.test.ts:6` to assert no client call to `setup.start_core` remains.

11. Docker E2E coverage
   - Extend `test/install-e2e/happy-path.docker.ts:379` to assert readiness diagnostics shape when intentionally forcing one service unhealthy (separate test block or sibling file).
   - Keep existing happy-path completion assertion and add post-complete service-state verification where feasible.

### Scripts / CI

12. Add explicit install readiness test script
   - Add `test:install:readiness` script in `package.json:20` to run new readiness-focused install E2E test.

13. Add release gate job usage
   - Update `.github/workflows/release.yml:161` to run readiness-focused install E2E variant (in addition to current happy-path stub test or as replacement once stable).

## Validation Strategy

### Happy path

- Preconditions: compose valid, all core services reachable and healthy.
- Expected:
  - `setup.complete` returns `ok: true`,
  - `setup-state.json` marked completed after readiness success only (`packages/lib/src/admin/setup-manager.ts:151`),
  - no diagnostics payload returned.

### Timeout/failure path

- Simulate one service never becoming healthy (mock `runner.ps()` and/or HTTP probe failures).
- Expected:
  - `setup.complete` returns `ok: false`, `code: setup_not_ready`,
  - includes failed services, compose stderr, per-service log tails, and suggested commands,
  - setup state remains incomplete.

### Partial health path

- Simulate subset converged (e.g., `postgres/qdrant` healthy, `gateway` running but unhealthy).
- Expected:
  - readiness gate keeps polling until timeout,
  - final diagnostics identify only non-ready services,
  - ready services are still listed in diagnostics with `ready: true` for operator context.

## Architecture Guardrails Checklist

- Single runtime orchestration path: both `/command` and `/setup/complete` call one shared completion function.
- Thin compose wrapper preserved: compose interactions remain via existing runner APIs (`config`, `up`, `ps`, `logs`).
- Direct Docker errors preserved: raw stderr included in failure diagnostics; no hidden fallback orchestrator.
- Stack boundary preserved: `applyStack` continues as render/validate/write before startup/readiness.

## Rollout Notes

- Land behind implementation in one PR with docs + tests so contract and behavior stay in sync.
- Keep defaults conservative (`180s` timeout) and configurable via function options for tests and future tuning.
