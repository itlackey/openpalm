# Install & Setup Simplification + Reliability Report (Consolidated)

## Objective

Make first-run setup predictable and low-friction so users consistently end in a known-good state: **all core containers running and healthy** (`caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`).

Specific goals:

1. Reduce user-facing complexity and decision load.
2. Improve reliability so users consistently end with all core containers running.
3. Preserve OpenPalm's architectural guardrails (single compose runner path, stack validation boundaries, and direct Docker error visibility).

---

## Current State Review

### 1) What works well today

- The install wrappers are correctly thin and defer behavior to the CLI (`install.sh`, `install.ps1`), which keeps install logic centralized. This is the correct shape for maintainability and cross-platform consistency.
- `openpalm install` already has good boundary checks: runtime detection, compose validation, preflight checks, and setup bootstrap artifacts.
- The stack apply boundary is clear: setup input is rendered, validated with `docker compose config`, then written.
- The setup wizard has retry semantics on finalization (`setup.complete`) and gives users an actionable error message.

These are strong architectural choices and should be preserved.

### 2) Current execution model (as implemented)

Install is split into two operational phases:

- **Phase A (CLI install):** prepares env/paths, writes a setup-only Caddy config and a minimal compose with only `caddy` + `admin`, then boots those two services. This split is good for fast time-to-first-UI, but introduces a handoff risk between "wizard feels available" and "system is actually operational."

- **Phase B (Wizard setup):** persists setup data and eventually executes stack apply + startup for broader core services.

Detailed wizard flow:

1. Installer performs preflight and writes bootstrap compose with only `caddy` + `admin`.
2. Installer starts bootstrap services and opens setup UI.
3. Wizard stores profile/provider/access/channel state through `setup.*` commands.
4. Wizard triggers `setup.start_core` in the background after service instance save.
5. Wizard final step triggers `setup.complete`, which:
   - applies stack artifacts,
   - runs compose `up` for core services,
   - marks setup complete.

### 3) Multiple setup commands can mutate/start runtime in overlapping ways

The wizard path currently has several commands that can start/restart services (`setup.start_core`, `setup.access_scope`, `setup.complete`). These are useful but fragmented, and not all of them use a strict success contract the user can trust.

---

## Key Friction + Reliability Risks

### R1 — "Started" does not always mean "ready" / Success criteria are UI-centric

- `setup.complete` currently checks compose command success for `up`, but does not enforce a post-start health convergence gate before returning success.
- The install command reports success when setup UI is reachable. That confirms only bootstrap readiness, not full runtime readiness.
- This can produce "setup complete" while one or more services are crash-looping or still unhealthy.

**Impact:** Users can perceive setup success while one or more core containers are failed/restarting.

### R2 — Background `setup.start_core` is fire-and-forget

- `setup.start_core` returns immediately with `{ status: 'starting' }` while startup work runs async in a detached block.
- Failures are logged server-side but are not surfaced to the wizard in a structured way.
- Users may advance with a false sense of progress and only discover issues at the end.

**Impact:** Failures are logged but not reflected in command success/failure. Users can advance with hidden drift.

### R3 — `setup.complete` starts services but does not enforce a post-start health gate

`setup.complete` applies stack artifacts and calls compose up on the core set. If `compose up` succeeds syntactically but containers crash shortly after, setup can still be marked complete.

**Impact:** "Completed" state can be false-positive relative to real service health.

### R4 — Runtime start logic is spread across multiple commands

Service start/restart actions exist in:

- CLI install bootstrap startup
- `setup.start_core`
- `setup.access_scope`
- `setup.complete`

Partial-state outcomes are common: core startup in `setup.start_core` iterates service-by-service; partial success is common under intermittent network/image pull issues. There is no explicit convergence loop that keeps reconciling to the desired "all core healthy" state.

**Impact:** Harder to reason about idempotency and final desired state; increases edge-case variance.

### R5 — Install script and CLI option model are slightly misaligned for advanced recovery

CLI install supports non-default ingress ports (`options.port`), but the shell installer help/argument parser does not expose `--port`.

**Impact:** Users hitting port 80 conflicts cannot use the default one-liner path to recover without dropping to direct CLI invocation.

### R6 — UX copy in top-level docs over-promises startup guarantees

README "What happens" currently says installer "starts all services," while implemented behavior is bootstrap-first and full stack later.

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

1. Remove detached startup side effects from `setup.start_core` (or remove endpoint entirely if redundant).
2. Remove non-essential service startup calls from `setup.access_scope` (retain scope/env update only).
3. Remove repeated per-service startup loops where a single compose action can be used.
4. Remove branch-specific startup messaging that implies success before health reconciliation.

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

**Why:** More robust than substring matching; easier to test and localize.

---

### P2 — Align installer options with recovery reality

Expose `--port` in `install.sh` and PowerShell installer wrappers so users can recover from port 80 conflicts without learning internal CLI details.

Also print this remediation directly in port-conflict errors.

---

### P2 — Tighten docs for expectation correctness

Update README and CLI docs language from "starts all services" to:

- installer starts bootstrap services (`admin`, `caddy`),
- wizard completion applies and verifies core runtime services.

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

This should be part of release CI and local pre-release checklist.

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

- **Current complexity:** core service arrays are declared/used in multiple places and can drift.
- **Simplification action:** define one canonical core service constant in shared compose/admin layer and import everywhere.
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

1. Add `ensureCoreReady()` / `ensureCoreServicesReady()` utility in admin runtime / compose layer:
   - inputs: service list, timeout, poll interval, `requireHealthy` flag
   - checks compose status + endpoint health
   - returns structured readiness result
2. Wire checker into `setup.complete` and gate completion state on success (`completeSetup()` called only after readiness confirmed).
3. Return typed error payload (`setup_not_ready`) with failed service diagnostics from setup complete.
4. Remove or refactor `setup.start_core` background orchestration (remove fire-and-forget path from wizard and command handler).
5. Remove startup side effects from non-terminal setup commands (`setup.access_scope` etc.).

### Phase 2: UX improvements + simplification

6. Add readiness progress UI on final step (per-service status chips, live logs on failure).
7. Add "Retry core startup" UI action using same backend function (`reconcileCoreRuntime`).
8. Add "Copy diagnostics" action including compose ps + failed service logs.
9. Keep retry button idempotent and safe.
10. Keep optional image pre-pull in installer but report progress synchronously.
11. Consolidate core service constant usage to one shared source.

### Phase 3: Wrapper/docs/release hardening

12. Add `--port` passthrough support in `install.sh` and PowerShell wrappers.
13. Update README + CLI docs wording for bootstrap vs full-stack semantics.
14. Enforce core-health post-setup smoke test in release gate (release CI + local pre-release checklist).

### Phase 4: Test gates

Add/expand automated scenarios:

- Happy path: all core containers healthy after setup.
- Slow startup path: health convergence eventually succeeds.
- One service unhealthy path: setup fails with structured diagnostics.
- Retry path: transient pull failure then user-initiated retry succeeds.
- Regression gate: setup cannot report success if any core service is not healthy/running.

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
