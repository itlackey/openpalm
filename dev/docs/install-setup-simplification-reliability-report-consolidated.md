# Install & Setup Simplification + Reliability Report (Consolidated)

> **Last updated:** 2026-02-25 — refreshed against current codebase after recent pull.

## Objective

Make first-run setup predictable and low-friction so users consistently end in a known-good state: **all core containers running and healthy** (`caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`).

Specific goals:

1. Reduce user-facing complexity and decision load.
2. Improve reliability so users consistently end with all core containers running.
3. Preserve OpenPalm's architectural guardrails (single compose runner path, stack validation boundaries, and direct Docker error visibility).

---

## Recommendation Status Summary

| Recommendation | Priority | Status |
|---|---|---|
| Remove overlapping startup code paths | P0 | **OPEN** |
| Add `ensureCoreServicesReady()` health gate | P0 | **OPEN** |
| Make `setup.complete` the only authoritative transition | P1 | **PARTIAL** — marks complete, but no health verification |
| Remove fire-and-forget `setup.start_core` | P1 | **OPEN** |
| Collapse startup entry points to one path | P1 | **OPEN** |
| Core Readiness UX stage | P2 | **OPEN** |
| Structured preflight failure types | P2 | **COMPLETE** — `PreflightCode`/`PreflightIssue`/`PreflightResult` types added, install uses code-based branching |
| Align installer `--port` option in wrappers | P2 | **OPEN** — CLI supports `--port`, wrappers do not |
| Tighten docs for expectation correctness | P2 | **PARTIAL** — `docs/cli.md` is accurate, `README.md` still says "starts all services" |
| Self-healing retry affordances | P3 | **OPEN** |
| Release gate health check | P3 | **PARTIAL** — setup-wizard-e2e job exists but uses stubs |
| Install idempotency metadata | P4 | **OPEN** |

---

## Current State Review

### 1) What works well today

- The install wrappers are correctly thin and defer behavior to the CLI (`install.sh`, `install.ps1`), which keeps install logic centralized. This is the correct shape for maintainability and cross-platform consistency.
- `openpalm install` already has good boundary checks: runtime detection, compose validation, preflight checks, and setup bootstrap artifacts.
- The stack apply boundary is clear: setup input is rendered, validated with `docker compose config`, then written.
- The setup wizard has retry semantics on finalization (`setup.complete`) and gives users an actionable error message.
- **`SetupManager`** (`packages/lib/src/admin/setup-manager.ts`) is a clean, pure state persistence layer with no compose orchestration, no async patterns, and no side effects. All methods (`setAccessScope`, `setServiceInstances`, `completeSetup`, etc.) only mutate and persist `setup-state.json`. This clean separation is a good architectural choice.
- **Compose error classification** exists in `packages/lib/src/compose-runner.ts:5-17` with typed `ComposeErrorCode` values (`daemon_unreachable`, `image_pull_failed`, `permission_denied`, `invalid_compose`, `timeout`, `unknown`) and automatic retry for transient errors.
- **`finishSetup()` in SetupWizard.svelte** now checks `completeResult.ok` and shows user-facing errors with retry guidance (lines 219-227). Previously this advanced unconditionally.
- **`setup.complete` auto-generates `POSTGRES_PASSWORD`** if missing (`packages/ui/src/routes/command/+server.ts:349-357`), preventing compose interpolation failures.
- **A health check endpoint** (`/setup/health-check`) exists and probes gateway, assistant, and openmemory health via HTTP. However, it is a read-only probe, not wired into the completion flow.
- **`createMockRunner()` and DI pattern** in compose-runner.ts enables clean testing without Docker.

These are strong architectural choices and should be preserved.

### 2) Current execution model (as implemented)

Install is split into two operational phases:

- **Phase A (CLI install):** prepares env/paths, writes a setup-only Caddy config and a minimal compose with only `caddy` + `admin`, then boots those two services. This split is good for fast time-to-first-UI, but introduces a handoff risk between "wizard feels available" and "system is actually operational."

- **Phase B (Wizard setup):** persists setup data and eventually executes stack apply + startup for broader core services.

Detailed wizard flow:

1. Installer performs preflight and writes bootstrap compose with only `caddy` + `admin`.
2. Installer starts bootstrap services and opens setup UI.
3. Wizard stores profile/provider/access/channel state through `setup.*` commands.
4. Wizard triggers `setup.start_core` in the background after service instance save (`SetupWizard.svelte:149-153` — comment explicitly says "Fire and forget").
5. Wizard final step triggers `setup.complete`, which:
   - applies stack artifacts,
   - runs compose `up` for core services,
   - marks setup complete.

**Important architectural note:** The setup command names (`setup.start_core`, `setup.complete`, `setup.access_scope`) refer to command types dispatched to the central command handler at `packages/ui/src/routes/command/+server.ts`, NOT methods on `SetupManager`. `SetupManager` is a pure state persistence layer. All compose orchestration and side effects live in the command handler.

Additionally, parallel REST route handlers exist under `packages/ui/src/routes/setup/` that implement similar logic via dedicated endpoints (e.g., `/setup/complete/+server.ts` has its own `CoreStartupServices` constant and compose-up-then-mark-complete pattern).

### 3) Multiple setup commands can mutate/start runtime in overlapping ways

The wizard path currently has several command handlers that can start/restart services:

- **`setup.start_core`** (`+server.ts:205-235`): fire-and-forget IIFE that pulls and starts 6 services, returns immediately with `{ status: 'starting' }`.
- **`setup.access_scope`** (`+server.ts:236-252`): starts caddy (with `.catch(() => {})` error swallowing during initial setup), and post-setup starts caddy + openmemory + assistant.
- **`setup.profile`** (`+server.ts:267`): post-setup restarts assistant with `.catch(() => {})`.
- **`setup.complete`** (`+server.ts:348-363`): applies stack, runs compose up for `SetupCoreServices`, marks complete.
- **`/setup/complete/+server.ts`** (separate route, 55 lines): parallel implementation with its own `CoreStartupServices` constant.

These are fragmented, and not all of them use a strict success contract the user can trust.

---

## Key Friction + Reliability Risks

### R1 — "Started" does not always mean "ready" / Success criteria are UI-centric

- `setup.complete` currently checks compose command success for `up`, but does not enforce a post-start health convergence gate before returning success.
- The install command reports success when setup UI is reachable. That confirms only bootstrap readiness, not full runtime readiness.
- This can produce "setup complete" while one or more services are crash-looping or still unhealthy.

**Impact:** Users can perceive setup success while one or more core containers are failed/restarting.

### R2 — Background `setup.start_core` is fire-and-forget

- `setup.start_core` (`+server.ts:205-235`) returns immediately with `{ status: 'starting' }` while startup work runs in a detached IIFE `(async () => { ... })()`.
- The IIFE pulls 6 services via `Promise.allSettled`, then starts each sequentially with `composeAction('up', svc)`, then restarts caddy.
- Failures are logged server-side (`log.error`) but are not surfaced to the wizard in a structured way.
- The wizard calls this fire-and-forget from `SetupWizard.svelte:149-153` with the comment "Fire and forget — start pulling core services in background". No result is checked.
- Users may advance with a false sense of progress and only discover issues at the end.

**Impact:** Failures are logged but not reflected in command success/failure. Users can advance with hidden drift.

### R3 — `setup.complete` starts services but does not enforce a post-start health gate

`setup.complete` applies stack artifacts and calls compose up on the core set. If `compose up` succeeds syntactically but containers crash shortly after, setup can still be marked complete.

**Impact:** "Completed" state can be false-positive relative to real service health.

### R4 — Runtime start logic is spread across multiple commands

Service start/restart actions exist in:

- CLI install bootstrap startup (`packages/cli/src/commands/install.ts`)
- `setup.start_core` (`packages/ui/src/routes/command/+server.ts:205-235`)
- `setup.access_scope` (`packages/ui/src/routes/command/+server.ts:236-252` and `/setup/access-scope/+server.ts:25-33`)
- `setup.profile` (`packages/ui/src/routes/command/+server.ts:267`)
- `setup.complete` (`packages/ui/src/routes/command/+server.ts:348-363` and `/setup/complete/+server.ts`)

Partial-state outcomes are common: core startup in `setup.start_core` iterates service-by-service; partial success is common under intermittent network/image pull issues. There is no explicit convergence loop that keeps reconciling to the desired "all core healthy" state.

Additionally, core service lists are defined in **four separate locations** that can drift independently:

| Constant | Location | Includes `admin`? |
|---|---|---|
| `CoreServices` | `packages/lib/src/admin/compose-runner.ts:4-7` | YES |
| `SetupCoreServices` | `packages/ui/src/routes/command/+server.ts:49-57` | NO |
| `CoreStartupServices` | `packages/ui/src/routes/setup/complete/+server.ts:15` | NO |
| Inline list in `setup.start_core` | `packages/ui/src/routes/command/+server.ts:208-215` | NO (also excludes `caddy`) |

**Impact:** Harder to reason about idempotency and final desired state; increases edge-case variance. Service list drift compounds the risk.

### R5 — Install script and CLI option model are misaligned for port recovery

CLI install fully supports non-default ingress ports: `--port` is parsed in `packages/cli/src/main.ts:135-140`, validated (1-65535), wired through Caddy config, compose template, `OPENPALM_INGRESS_PORT` env var, and health check URLs. Port conflict errors in install.ts even suggest `Use --port to specify an alternative` (`install.ts:93`).

However, the shell installer wrappers do **not** expose `--port`:
- `install.sh:28-74`: argument parser handles `--runtime`, `--no-open`, `--ref`, `-h/--help` only. Unknown options are rejected.
- `install.ps1:10-15`: `param()` block accepts only `$Runtime`, `$Ref`, `$NoOpen`.

**Impact:** Users hitting port 80 conflicts via the one-liner curl/pwsh install cannot specify an alternative port without dropping to direct CLI invocation.

### R6 — UX copy in top-level docs over-promises startup guarantees

`README.md:50` still says "It starts all services and opens a setup wizard in your browser," while implemented behavior is bootstrap-first (caddy + admin only) and full stack later (via wizard completion).

`docs/cli.md:57-71` correctly describes the 2-phase model, but the README is the primary user-facing document and creates the initial expectation.

Additionally, `README.md:49` says "generates a secure admin password and prints it to your screen" but the actual install.ts now says "temporary admin token" and directs to wizard for password setup — the README is outdated here too.

**Impact:** Expectation mismatch increases support confusion when users see partial startup before setup completion.

### R7 — Preflight/install checks are useful but brittle in some conditions

- Some fatal detection logic relies on warning message matching (daemon/port checks), which can be fragile across runtime versions/localization.
- Installer health wait confirms admin availability, not full-stack eventual readiness.

### R8 — Setup UX has avoidable complexity for non-technical users

- Startup work is split between wizard middle steps (`setup.start_core`) and finish (`setup.complete`), which creates a dual mental model.
- Users are asked to proceed through steps even while background service startup may be silently failing.

---

## Recommendations (Prioritized)

### P0 — Simplify code paths by removing startup duplication (highest simplification ROI)

The current setup code can be materially simplified by **deleting overlapping orchestration branches** and centralizing startup behavior.

#### Code/behavior to remove or collapse

1. Remove the detached IIFE startup block in `setup.start_core` handler (`+server.ts:205-235`) — this is a fire-and-forget async block that pulls and starts services with no result reporting.
2. Remove the fire-and-forget call in `SetupWizard.svelte:149-153` that invokes `setup.start_core`.
3. Remove compose `up` side effects from `setup.access_scope` (`+server.ts:236-252` and `/setup/access-scope/+server.ts:25-33`) — retain scope/env update only.
4. Remove compose `restart` side effect from `setup.profile` (`+server.ts:267`) — retain profile mutation only.
5. Remove repeated per-service startup loops where a single compose action can be used.
6. Remove the parallel `CoreStartupServices` constant in `/setup/complete/+server.ts:15` and use the shared `CoreServices` from `packages/lib/src/admin/compose-runner.ts:4-7`.
7. Remove branch-specific startup messaging that implies success before health reconciliation.

#### Expected simplification gains

- Fewer asynchronous edge cases and race windows.
- Less duplicated compose command handling and error mapping.
- Easier reasoning about setup state transitions (one authoritative completion path).
- Smaller surface area to test and document.

#### Practical target

Keep only two runtime startup moments:

1. **Bootstrap startup:** `caddy` + `admin` from CLI install.
2. **Core startup:** one shared path invoked by `setup.complete` (and explicit retry action).

Everything else should be config mutation only.

> **Conflict resolution note:** Report 1 treated code path simplification as implicit in P1-P2. Report 4 elevated it to P0. Three independent reviewers voted unanimously for P0, reasoning that collapsing overlapping startup paths eliminates a class of race-condition bugs the health gate would merely detect after the fact, and that the project's own architectural rule ("keep one compose runner path") makes this duplication a correctness fix.

---

### P0 — Introduce one explicit "core-ready" reconciliation gate (highest reliability impact)

Add a single reusable orchestration primitive used by both setup completion and any retry action:

`ensureCoreServicesReady({ timeoutMs, requireHealthy })`

**Note:** A point-in-time health check endpoint already exists at `/setup/health-check` (probes gateway, assistant, openmemory via `checkServiceHealth()`). This endpoint can inform the design of the convergence gate but is not a substitute — the gate needs to be a polling loop, not a one-shot check. The existing `ServiceHealthState` type in `compose-runner.ts:147-151` and `ComposeErrorCode` type in `types.ts:18-25` can be reused in the structured result.

#### Contract

1. `compose config` validation passes for current generated compose.
2. `compose up -d` is run for the exact core service set.
3. Poll `compose ps --format json` + health endpoints until every core service is in acceptable state:
   - running + healthy (if healthcheck exists)
   - running (if no healthcheck declared)
   - HTTP health probes pass for gateway/assistant/openmemory/admin.
4. On timeout/failure, return structured diagnostics:
   - failed service names,
   - last known status,
   - top log lines per failed service,
   - actionable command hints / suggested next command.
5. Exit success only when all criteria are met.

#### Why this simplifies

- Converts several loose startup calls into one deterministic success contract.
- Gives users a clear binary outcome: **core ready** vs **core not ready**, with targeted next steps.
- Directly satisfies the product promise that setup completion means usable system state.

#### Architecture fit

- Keeps compose orchestration in one path.
- Continues surfacing Docker errors directly.
- Preserves `applyStack` as render/validate/write boundary.

---

### P1 — Make `setup.complete` the only authoritative transition to "completed"

`setup.complete` should return success only when all core containers are running and healthy (or a clear timeout error with diagnostics).

**Current state:** `setup.complete` (`+server.ts:348-363`) does call `applyStack` and `composeAction('up', [...SetupCoreServices])`, then calls `setupManager.completeSetup()` — but it only checks the compose `up` exit code (`startupResult.ok`), not actual container health. The `completeSetup()` call sets `completedAt` timestamp and `completed=true` unconditionally after compose up returns ok.

Additionally, `/setup/complete/+server.ts` is a parallel implementation with its own service list and similar compose-up-then-mark-complete pattern. This duplication should be collapsed.

#### Required behavior

After `applyStack` and compose `up`, run the bounded convergence loop (`ensureCoreServicesReady`):

- `applyStack` succeeds.
- Core reconciliation gate succeeds.
- Only then set setup state `completed=true`.

#### Failure behavior

- Keep setup state incomplete.
- Return structured failure payload (`setup_not_ready`) with:
  - failed services,
  - last known status,
  - top log lines per failed service,
  - exact recommended recovery command(s).

---

### P1 — Remove fire-and-forget core startup during wizard

Remove `setup.start_core` entirely and do all startup in `setup.complete` with progress reporting.

Keep optional image pre-pull in installer (or at finalization start) but report progress synchronously. If profiling later shows pull time is painful, an explicit tracked job alternative can be added as a deliberate, scoped optimization.

> **Conflict resolution note:** Report 1 preferred full removal but offered a "tracked job" alternative. Report 4 preferred converting to synchronous-with-progress. Three independent reviewers voted unanimously for full removal (Option A), reasoning that keeping early startup adds real complexity (tracked jobs, status endpoints, error surfacing) for marginal latency benefit during a one-time setup flow where users already expect to wait, and that thin wrappers shouldn't invent their own async job orchestration.

---

### P1 — Collapse startup entry points to one runtime path

Keep bootstrap startup in CLI install (`caddy` + `admin`) for fast wizard access, but for full core startup use a single internal function invoked by:

- `setup.complete` (authoritative)
- optional retry action in UI ("Retry core startup")

Avoid ad hoc startup side effects in `setup.access_scope` except where strictly needed for ingress changes.

#### Code simplification detail

Internally, this should become a single service orchestration function in the admin/compose layer (e.g., `reconcileCoreRuntime`) used by all full-stack startup callers. Existing ad hoc compose calls in setup command handlers can then be removed rather than wrapped.

---

### P2 — Introduce an explicit "Core Readiness" stage in UX

Add a deterministic readiness stage right before the final success screen.

#### UX shape

- "Applying configuration"
- "Starting core services"
- "Verifying health (this can take 1-3 minutes)"
- Show per-service status chips / checklist with real-time service statuses
- Show live logs snippet on failure
- If one service fails, surface concise reason + "Retry failed services" button

---

### P2 — Use structured preflight failure types (not message parsing)

Return typed preflight outcomes (`daemon_unavailable`, `port_conflict`, `disk_low`, etc.) and branch on codes.

**Current state:** Compose-level error classification already exists (`ComposeErrorCode` in `packages/lib/src/types.ts:18-25` with values like `daemon_unreachable`, `image_pull_failed`, etc.), and `packages/lib/src/compose-runner.ts:5-17` classifies errors and retries transient ones. However, the **preflight layer** (`packages/lib/src/preflight.ts`) returns `PreflightWarning` objects with freeform `message`/`detail` strings, not typed codes. Install detection logic in `install.ts` still relies on message substring matching for daemon/port checks.

**Recommendation:** Extend the typed error code pattern from compose-runner to the preflight layer. Return typed results (`daemon_unavailable`, `port_conflict`, `disk_low`) and branch on codes.

**Why:** More robust than substring matching; easier to test and localize.

---

### P2 — Align installer options with recovery reality

Expose `--port` in `install.sh` and PowerShell installer wrappers so users can recover from port 80 conflicts without learning internal CLI details.

**Current state:** The CLI fully implements `--port` (`packages/cli/src/main.ts:135-140`, `install.ts:59`, `preflight.ts:126-129`). Port conflict errors already suggest `Use --port to specify an alternative` (`install.ts:93`). But `install.sh:28-74` and `install.ps1:10-15` do not accept or pass through `--port`, and reject unknown options as errors.

Also: `docs/cli.md:44-47` lists install options but omits `--port`. Add it there too.

Also print this remediation directly in port-conflict errors from the wrapper scripts.

---

### P2 — Tighten docs for expectation correctness

Update README and CLI docs language from "starts all services" to:

- installer starts bootstrap services (`admin`, `caddy`),
- wizard completion applies and verifies core runtime services.

**Current state:** `docs/cli.md:57-71` already accurately describes the 2-phase model. However:
- `README.md:50` still says "It starts all services and opens a setup wizard."
- `README.md:49` says "generates a secure admin password" but install.ts now says "temporary admin token."

This preserves trust and reduces perceived flakiness.

---

### P3 — Add self-healing retry affordances without hiding root errors

In setup UI:

- Provide "Retry failed core services" action that reruns the same reconciliation gate.
- Keep Docker stderr visible in expandable diagnostics.
- Add "Copy diagnostics" action including compose ps + failed service logs.
- Keep retry button idempotent and safe.
- Do **not** auto-mask repeated failures with silent retries.

> **Conflict resolution note:** Report 1 recommended automatic recovery attempts for common transient failures (bounded auto-retries for pull/network/dependency issues). Report 4 explicitly opposed silent auto-retries and recommended user-initiated retry only with full error visibility. Three independent reviewers voted unanimously against auto-retries, citing the project's architectural rule to "surface Docker errors directly; avoid custom recovery/orchestration systems" and the risk of masking real configuration errors as transient failures.

---

### P3 — Add release gate checks for "all core containers running"

Add one install/setup smoke assertion that blocks release unless post-setup `compose ps` confirms healthy/running core services.

**Current state:** A `setup-wizard-e2e` job exists in `.github/workflows/release.yml:161-180` that runs `test/install-e2e/happy-path.docker.ts` against a Docker-built admin container. This exercises the full wizard happy path through `setup.complete` returning `completed: true`. However, it uses busybox stubs for non-admin services, so it cannot verify real container health. The functional wizard path is tested; the full-stack health convergence gate is not.

**Remaining work:** Add a full-stack variant (or extend the existing job) that boots all core images and verifies `compose ps` reports healthy/running for each. This should be part of release CI and local pre-release checklist.

---

### P4 — Make install idempotency explicit and stateful

Write installer metadata marker (version, timestamp, mode) and use that for reinstall/update prompts instead of compose-content string heuristics.

**Why:** Reduces false positives/negatives when compose content changes.

---

## Code Removal Opportunities (Concrete Targets)

### C1) Remove fire-and-forget startup branch in setup flow

- **Current complexity:** asynchronous background startup in setup command path can succeed/fail independently of returned API status.
- **Simplification action:** replace with synchronous reconciliation call or delete endpoint if not necessary.
- **Net result:** fewer hidden failure modes and fewer support-only log breadcrumbs.

### C2) Remove incremental startup side effects from non-terminal setup commands

- **Current complexity:** non-terminal commands perform partial runtime orchestration (restart/up) in addition to state mutation.
- **Simplification action:** restrict non-terminal setup commands to state/env/spec updates only.
- **Net result:** command handlers become straightforward CRUD-style mutations with clear responsibility boundaries.

### C3) Remove repeated service lists spread across commands/docs/tests

- **Current complexity:** core service arrays are declared in **four separate locations** that can drift independently:
  - `CoreServices` in `packages/lib/src/admin/compose-runner.ts:4-7` (includes `admin`)
  - `SetupCoreServices` in `packages/ui/src/routes/command/+server.ts:49-57` (excludes `admin`)
  - `CoreStartupServices` in `packages/ui/src/routes/setup/complete/+server.ts:15` (excludes `admin`)
  - Inline list in `setup.start_core` handler `+server.ts:208-215` (excludes `admin` and `caddy`)
- **Simplification action:** define one canonical core service constant in shared compose/admin layer and import everywhere. Derive startup-specific sublists (e.g., "core minus admin") from the canonical list.
- **Net result:** single-source-of-truth for readiness checks, UI status, retries, and tests.

### C4) Remove wrapper/CLI option divergence

- **Current complexity:** wrappers hide valid CLI recovery options (e.g., alternate ingress port).
- **Simplification action:** support the same key install options in wrappers as CLI install.
- **Net result:** one mental model for install behavior, fewer conditional docs branches.

### C5) Remove doc language that implies full runtime startup during bootstrap

- **Current complexity:** docs describe outcomes that don't match execution phases.
- **Simplification action:** standardize wording around bootstrap vs full-runtime reconciliation.
- **Net result:** fewer "product bug vs expectation bug" reports.

---

## Architectural Simplification Principles (to guide implementation)

1. **Single writer for runtime state transitions:** setup completion path owns runtime convergence.
2. **Command handlers should either mutate config or orchestrate runtime, not both (except setup.complete).**
3. **Prefer deleting branches to adding flags.** If two branches differ only by timing/reporting, consolidate to one.
4. **Keep failure surfaces explicit and raw:** propagate compose stderr with light structure, avoid hidden recovery loops.
5. **Make health convergence a first-class primitive, not ad hoc polling in multiple places.**

These principles keep the architecture aligned with the project's existing "thin wrapper over compose" intent while reducing long-term maintenance cost.

---

## Simplified Target Flow (Recommended)

1. **`openpalm install`**
2. **Preflight** (typed results, clear action hints)
3. **Bootstrap** `admin + caddy`
4. **Wizard** collects minimal required info only (profile, providers, channels, access scope - config mutation only)
5. **User clicks "Finish Setup"**
6. **Server executes one transaction-like flow:**
   - validate + apply stack (`applyStack`: render/validate/write)
   - compose up core set
   - run readiness convergence loop (`ensureCoreServicesReady`: up + health reconciliation)
   - mark setup complete
7. **If converged:** show success + "Open Workspace" with explicit "Core services running" confirmation and per-service status
8. **If not converged:** show structured failure details + one-click retry

This keeps one compose runner path and one reliable completion boundary. Net effect: one clear transition from configuration to verified runtime.

---

## Implementation Plan

### Phase 1: Reliability boundary hardening + code path simplification (high confidence, low disruption)

1. Add `ensureCoreReady()` / `ensureCoreServicesReady()` utility in admin runtime / compose layer (`packages/lib/src/admin/compose-runner.ts`):
   - inputs: service list, timeout, poll interval, `requireHealthy` flag
   - leverage existing `ServiceHealthState` type and `/setup/health-check` endpoint pattern
   - leverage existing `ComposeErrorCode` classification from `packages/lib/src/compose-runner.ts`
   - checks compose status + endpoint health
   - returns structured readiness result
2. Wire checker into `setup.complete` (`packages/ui/src/routes/command/+server.ts:348-363`) and gate `completeSetup()` on readiness success.
3. Return typed error payload (`setup_not_ready`) with failed service diagnostics from setup complete.
4. Remove `setup.start_core` handler (`+server.ts:205-235`) and the fire-and-forget call in `SetupWizard.svelte:149-153`.
5. Remove startup side effects from non-terminal setup commands:
   - `setup.access_scope` (`+server.ts:236-252` and `/setup/access-scope/+server.ts:25-33`)
   - `setup.profile` (`+server.ts:267`)
6. Collapse `/setup/complete/+server.ts` to use the same backend function as the command handler, or remove the parallel implementation.
7. Consolidate core service constants to one canonical list from `packages/lib/src/admin/compose-runner.ts:4-7`.

### Phase 2: UX improvements + simplification

6. Add readiness progress UI on final step (per-service status chips, live logs on failure).
7. Add "Retry core startup" UI action using same backend function (`reconcileCoreRuntime`).
8. Add "Copy diagnostics" action including compose ps + failed service logs.
9. Keep retry button idempotent and safe.
10. Keep optional image pre-pull in installer but report progress synchronously.
11. Consolidate core service constant usage to one shared source.

### Phase 3: Wrapper/docs/release hardening

12. Add `--port` passthrough support in `install.sh:28-74` and `install.ps1:10-15` wrappers.
13. Add `--port` to `docs/cli.md:44-47` install options section.
14. Update `README.md:49-50` wording: change "starts all services" to bootstrap semantics, change "admin password" to "admin token."
15. Extend `setup-wizard-e2e` job in `.github/workflows/release.yml:161-180` to verify core container health post-setup (or add a parallel full-stack variant).

### Phase 4: Test gates

Build on the existing test infrastructure (in-process mock servers via `Bun.serve({ port: 0 })`, dynamic port allocation via `test/helpers/docker-compose-port.ts`, Docker test exclusion via `bunfig.toml`).

Add/expand automated scenarios:

- Happy path: all core containers healthy after setup.
- Slow startup path: health convergence eventually succeeds.
- One service unhealthy path: setup fails with structured diagnostics.
- Retry path: transient pull failure then user-initiated retry succeeds.
- Regression gate: setup cannot report success if any core service is not healthy/running.
- Extend `command-setup-flow.test.ts` (currently 19 lines, string-matching only) with behavioral tests using mock compose runners.

---

## Acceptance Criteria

A setup run is considered successful only if all are true:

1. `applyStack` returns success.
2. `docker compose config` succeeds for generated compose.
3. Core services (`caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`) are running; healthchecked services report healthy within timeout.
4. HTTP health probes pass for gateway/assistant/openmemory/admin.
5. Setup state is marked complete only after #1-#4.
6. On failure, UI/CLI display exact failing services and direct retry commands.

---

## Operational Metrics to Track

- Time to first successful setup completion.
- Percent of installs reaching "all core healthy" on first attempt.
- Most common failed core service on first run.
- Retry success rate after initial failure.
- Support tickets tagged "install/setup stuck".

---

## Expected Outcome

With these changes, OpenPalm setup becomes:

- **Simpler:** fewer startup code paths, fewer ambiguous states, and fewer overlapping orchestration branches.
- **More reliable:** completion tied to actual core runtime health, not just command dispatch or compose exit code.
- **More user-friendly:** transparent progress, better remediation, and fewer "looks done but isn't running" outcomes.
- **Higher first-run success rate:** every completed setup ends with a fully running core stack, or users have clear diagnostics and a one-click retry path.

---

## Appendix: Recent Improvements (context for implementors)

The following improvements have landed since the original reports were written and are relevant context for implementation:

1. **`finishSetup()` error handling** (`SetupWizard.svelte:219-227`): Now checks `completeResult.ok` and shows user-facing error message. Previously advanced unconditionally.
2. **Auto-generate `POSTGRES_PASSWORD`** (`+server.ts:349-357`): `setup.complete` generates password if missing, preventing compose interpolation failures.
3. **Compose error classification** (`compose-runner.ts:5-17`): `ComposeErrorCode` types with automatic retry for transient errors (`daemon_unreachable`, `image_pull_failed`).
4. **Health check endpoint** (`/setup/health-check`): Point-in-time HTTP probes for gateway/assistant/openmemory. Not wired into completion flow but provides a pattern.
5. **`createMockRunner()` DI pattern** (`compose-runner.ts:94`): Clean dependency injection for testing without Docker.
6. **SetupManager validation** (`setup-manager.ts:67-81`): Guards against corrupt/invalid state files.
7. **Setup-wizard E2E in CI** (`.github/workflows/release.yml:161-180`): Functional wizard test against Docker-built admin, using busybox stubs for other services.
8. **CI test infrastructure** (`.plans/tasks.json`): 17 test reliability tasks (R01-R17) completed, covering test isolation, discovery, parameterization, DI, dynamic ports, and Playwright optimization.
9. **Anthopic API key no longer required** (commit `1ae2e15`): Setup wizard no longer requires Anthropic API key, reducing first-run friction.
