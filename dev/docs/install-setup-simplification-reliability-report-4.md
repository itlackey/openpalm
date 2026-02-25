# Install & Setup Simplification + Reliability Report

## Objective

Review the current install/setup flow and recommend changes that:

1. Reduce user-facing complexity and decision load.
2. Improve reliability so users consistently end with all **core containers running**.
3. Preserve OpenPalm’s architectural guardrails (single compose runner path, stack validation boundaries, and direct Docker error visibility).

---

## Current State (What the flow does today)

### 1) Installer wrapper + CLI bootstrap model is directionally good

The shell installers are intentionally thin and delegate logic to `openpalm install`. This is the correct shape for maintainability and cross-platform consistency.

### 2) Install is split into two operational phases

- **Phase A (CLI install):** prepares env/paths, writes a setup-only Caddy config and a minimal compose with only `caddy` + `admin`, then boots those two services.
- **Phase B (Wizard setup):** persists setup data and eventually executes stack apply + startup for broader core services.

This split is good for fast time-to-first-UI, but introduces a handoff risk between “wizard feels available” and “system is actually operational.”

### 3) Multiple setup commands can mutate/start runtime in overlapping ways

The wizard path currently has several commands that can start/restart services (`setup.start_core`, `setup.access_scope`, `setup.complete`). These are useful but fragmented, and not all of them use a strict success contract the user can trust.

---

## Key Friction + Reliability Risks

## R1 — Success criteria are UI-centric, not stack-health-centric

The install command reports success when setup UI is reachable. That confirms only bootstrap readiness, not full runtime readiness.

**Impact:** Users can perceive setup success while one or more core containers are failed/restarting.

## R2 — `setup.start_core` is fire-and-forget and non-blocking

Core pulls/starts in `setup.start_core` run in a detached async block and return `status: "starting"` immediately.

**Impact:** Failures are logged but not reflected in command success/failure. Users can advance with hidden drift.

## R3 — `setup.complete` starts services but does not enforce a post-start health gate

`setup.complete` applies stack artifacts and calls compose up on the core set. If `compose up` succeeds syntactically but containers crash shortly after, setup can still be marked complete.

**Impact:** “Completed” state can be false-positive relative to real service health.

## R4 — Runtime start logic is spread across multiple commands

Service start/restart actions exist in:

- CLI install bootstrap startup
- `setup.start_core`
- `setup.access_scope`
- `setup.complete`

**Impact:** Harder to reason about idempotency and final desired state; increases edge-case variance.

## R5 — Install script and CLI option model are slightly misaligned for advanced recovery

CLI install supports non-default ingress ports (`options.port`), but the shell installer help/argument parser does not expose `--port`.

**Impact:** Users hitting port 80 conflicts cannot use the default one-liner path to recover without dropping to direct CLI invocation.

## R6 — UX copy in top-level docs over-promises startup guarantees

README “What happens” currently says installer “starts all services,” while implemented behavior is bootstrap-first and full stack later.

**Impact:** Expectation mismatch increases support confusion when users see partial startup before setup completion.

---

## Recommendations (Prioritized)

## P0 — Simplify code paths by removing startup duplication (highest simplification ROI)

Beyond reliability, the current setup code can be materially simplified by **deleting overlapping orchestration branches** and centralizing startup behavior.

### Code/behavior to remove or collapse

1. Remove detached startup side effects from `setup.start_core` (or remove endpoint entirely if redundant).
2. Remove non-essential service startup calls from `setup.access_scope` (retain scope/env update only).
3. Remove repeated per-service startup loops where a single compose action can be used.
4. Remove branch-specific startup messaging that implies success before health reconciliation.

### Expected simplification gains

- Fewer asynchronous edge cases and race windows.
- Less duplicated compose command handling and error mapping.
- Easier reasoning about setup state transitions (one authoritative completion path).
- Smaller surface area to test and document.

### Practical target

Keep only two runtime startup moments:

1. **Bootstrap startup:** `caddy` + `admin` from CLI install.
2. **Core startup:** one shared path invoked by `setup.complete` (and explicit retry action).

Everything else should be config mutation only.

---

## P0 — Introduce one explicit "core-ready" reconciliation gate (highest impact)

Add a single reusable orchestration primitive used by both setup completion and any early-start path:

`ensureCoreServicesReady({ timeoutMs, requireHealthy })`

### Contract

1. `compose config` validation passes for current generated compose.
2. `compose up -d` is run for the exact core service set.
3. Poll `compose ps` until every core service is in acceptable state:
   - running + healthy (if healthcheck exists)
   - running (if no healthcheck declared)
4. On timeout/failure, return structured diagnostics (failed service names + last status snippets + actionable command hints).

### Why this simplifies

- Converts several loose startup calls into one deterministic success contract.
- Gives users a clear binary outcome: **core ready** vs **core not ready**, with targeted next steps.

### Architecture fit

- Keeps compose orchestration in one path.
- Continues surfacing Docker errors directly.
- Preserves `applyStack` as render/validate/write boundary.

---

## P1 — Make `setup.complete` the only authoritative transition to “completed”

Adjust semantics so setup completion is marked only after `ensureCoreServicesReady` succeeds.

### Required behavior

- `applyStack` succeeds.
- Core reconciliation gate succeeds.
- Only then set setup state `completed=true`.

### Failure behavior

- Keep setup state incomplete.
- Return explicit failing services and exact recommended recovery command(s).

---

## P1 — Convert `setup.start_core` from detached async to tracked progress

Replace background fire-and-forget with one of:

- synchronous execution with streamed progress and explicit result; or
- job model with persisted progress + poll endpoint + terminal success/failure state.

The simplest path is synchronous with bounded timeout and progressive logs.

---

## P1 — Collapse startup entry points to one runtime path

Keep bootstrap startup in CLI install (`caddy` + `admin`) for fast wizard access, but for full core startup use a single internal function invoked by:

- `setup.complete` (authoritative)
- optional retry action in UI (“Retry core startup”)

Avoid ad hoc startup side effects in `setup.access_scope` except where strictly needed for ingress changes.

### Code simplification detail

Internally, this should become a single service orchestration function in the admin/compose layer (e.g., `reconcileCoreRuntime`) used by all full-stack startup callers. Existing ad hoc compose calls in setup command handlers can then be removed rather than wrapped.

---

## P2 — Add an install-time "final verification" mode (default on)

After wizard completion callback, run a final verification pass that confirms all core services are up before showing “setup complete.”

### UX behavior

- Show checklist with real-time service statuses.
- If one service fails, surface concise reason + “Retry failed services” button.

---

## P2 — Align installer options with recovery reality

Expose `--port` in `install.sh` and PowerShell installer wrappers so users can recover from port 80 conflicts without learning internal CLI details.

Also print this remediation directly in port-conflict errors.

---

## P2 — Tighten docs for expectation correctness

Update README and CLI docs language from “starts all services” to:

- installer starts bootstrap services (`admin`, `caddy`),
- wizard completion applies and verifies core runtime services.

This preserves trust and reduces perceived flakiness.

---

## P3 — Add self-healing retry affordances without hiding root errors

In setup UI:

- Provide “Retry failed core services” action that reruns the same reconciliation gate.
- Keep Docker stderr visible in expandable diagnostics.
- Do not auto-mask repeated failures with silent retries.

---

## P3 — Add release gate checks specifically for “all core containers running”

Add one install/setup smoke assertion that blocks release unless post-setup `compose ps` confirms healthy/running core services.

This should be part of release CI and local pre-release checklist.

---

## Code Removal Opportunities (Concrete Targets)

This section focuses specifically on code and behavior we can delete to reduce complexity.

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

- **Current complexity:** docs describe outcomes that don’t match execution phases.
- **Simplification action:** standardize wording around bootstrap vs full-runtime reconciliation.
- **Net result:** fewer “product bug vs expectation bug” reports.

---

## Architectural Simplification Principles (to guide implementation)

1. **Single writer for runtime state transitions:** setup completion path owns runtime convergence.
2. **Command handlers should either mutate config or orchestrate runtime, not both (except setup.complete).**
3. **Prefer deleting branches to adding flags.** If two branches differ only by timing/reporting, consolidate to one.
4. **Keep failure surfaces explicit and raw:** propagate compose stderr with light structure, avoid hidden recovery loops.
5. **Make health convergence a first-class primitive, not ad hoc polling in multiple places.**

These principles keep the architecture aligned with the project’s existing “thin wrapper over compose” intent while reducing long-term maintenance cost.

---

## Target End-State Flow (Simplified)

1. **Install command:** preflight + env/artifact seed + bootstrap compose (`admin`, `caddy`) + admin readiness.
2. **Wizard steps:** collect profile, providers, channels, access scope (config only).
3. **Finish setup:**
   - `applyStack` (render/validate/write)
   - `ensureCoreServicesReady` (up + health reconciliation)
   - mark setup complete
4. **Result page:** explicit “Core services running” confirmation with per-service status.

Net effect: one clear transition from configuration to verified runtime.

---

## Suggested Implementation Sequence

## Phase 1 (High confidence, low disruption)

1. Introduce reusable core readiness checker in compose/admin layer.
2. Wire checker into `setup.complete` and gate completion state on success.
3. Return richer structured errors from setup complete.
4. Remove or refactor `setup.start_core` background orchestration.
5. Remove startup side effects from non-terminal setup commands.

## Phase 2 (UX and simplification)

6. Add “Retry core startup” UI action using same backend function.
7. Consolidate core service constant usage to one shared source.

## Phase 3 (wrapper/docs/release hardening)

8. Add `--port` passthrough support in shell wrappers.
9. Update README + CLI docs wording for bootstrap vs full-stack semantics.
10. Enforce core-health post-setup smoke test in release gate.

---

## Acceptance Criteria

A setup run is considered successful only if all are true:

1. `applyStack` returns success.
2. `docker compose config` succeeds for generated compose.
3. Core services (`caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`) are running; healthchecked services report healthy within timeout.
4. Setup state is marked complete only after #1–#3.
5. On failure, UI/CLI display exact failing services and direct retry commands.

---

## Expected Outcome

If these changes are implemented, OpenPalm setup becomes:

- **Simpler:** fewer startup code paths and fewer ambiguous states.
- **More reliable:** completion tied to actual core runtime health, not just command dispatch.
- **More user-friendly:** better remediation and fewer “looks done but isn’t running” outcomes.
