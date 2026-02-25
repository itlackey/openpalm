# Install + Setup Simplification and Reliability Report

## Goal

Make first-run setup predictable and low-friction so users consistently end in a known-good state: **all core containers are running and healthy** (`caddy`, `admin`, `assistant`, `gateway`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`).

---

## Current Flow Review

## 1) What works well today

- The install wrappers are correctly thin and defer behavior to the CLI (`install.sh`, `install.ps1`), which keeps install logic centralized.
- `openpalm install` already has good boundary checks: runtime detection, compose validation, preflight checks, and setup bootstrap artifacts.
- The stack apply boundary is clear: setup input is rendered, validated with `docker compose config`, then written.
- The setup wizard has retry semantics on finalization (`setup.complete`) and gives users an actionable error message.

These are strong architectural choices and should be preserved.

## 2) Current execution model (as implemented)

1. Installer performs preflight and writes bootstrap compose with only `caddy` + `admin`.
2. Installer starts bootstrap services and opens setup UI.
3. Wizard stores profile/provider/access/channel state through `setup.*` commands.
4. Wizard triggers `setup.start_core` in the background after service instance save.
5. Wizard final step triggers `setup.complete`, which:
   - applies stack artifacts,
   - runs compose `up` for core services,
   - marks setup complete.

## 3) Reliability and UX gaps

### A. “Started” does not always mean “ready”

- `setup.complete` currently checks compose command success for `up`, but does not enforce a post-start health convergence gate before returning success.
- This can produce “setup complete” while one or more services are crash-looping or still unhealthy.

### B. Background `setup.start_core` is fire-and-forget

- `setup.start_core` returns immediately with `{ status: 'starting' }` while startup work runs async in a detached block.
- Failures are logged server-side but are not surfaced to the wizard in a structured way.
- Users may advance with a false sense of progress and only discover issues at the end.

### C. Partial-state outcomes are possible

- Core startup in `setup.start_core` iterates service-by-service; partial success is common under intermittent network/image pull issues.
- There is no explicit convergence loop that keeps reconciling to the desired “all core healthy” state.

### D. Preflight/install checks are useful but brittle in some conditions

- Some fatal detection logic relies on warning message matching (daemon/port checks), which can be fragile across runtime versions/localization.
- Installer health wait confirms admin availability, not full-stack eventual readiness.

### E. Setup UX has avoidable complexity for non-technical users

- Startup work is split between wizard middle steps (`setup.start_core`) and finish (`setup.complete`), which creates a dual mental model.
- Users are asked to proceed through steps even while background service startup may be silently failing.

---

## Recommendations (Prioritized)

## Priority 0 — Enforce a hard completion invariant

**Recommendation:** `setup.complete` should return success only when all core containers are running and healthy (or a clear timeout error with diagnostics).

### Proposed behavior

After `applyStack` and compose `up`, run a bounded convergence loop:

- Poll `compose ps --format json` + health endpoints.
- Require:
  - every core container present,
  - container state is `running`,
  - healthcheck status is `healthy` where defined,
  - HTTP health probes pass for gateway/assistant/openmemory/admin.
- Exit success only when criteria are met.
- On timeout/failure, return structured failure payload with:
  - failed services,
  - last known status,
  - top log lines per failed service,
  - suggested next command.

**Why:** This directly satisfies the product promise that setup completion means usable system state.

## Priority 1 — Remove fire-and-forget core startup during wizard

**Recommendation:** Replace `setup.start_core` async background launch with one of these simpler models:

- **Preferred:** remove `setup.start_core` entirely and do all startup in `setup.complete` with progress reporting.
- **Alternative:** keep early pull as optimization but make it explicit as a tracked job with status endpoint and surfaced errors.

**Why:** A single startup boundary reduces race conditions and user confusion.

## Priority 2 — Introduce an explicit “Core Readiness” stage

**Recommendation:** Add a deterministic readiness stage right before final success screen.

### UX shape

- “Applying configuration”
- “Starting core services”
- “Verifying health (this can take 1–3 minutes)”
- show per-service status chips and live logs snippet on failure

**Why:** Transparent progress removes ambiguity and reduces support burden.

## Priority 3 — Use structured preflight failure types (not message parsing)

**Recommendation:** return typed preflight outcomes (`daemon_unavailable`, `port_conflict`, `disk_low`, etc.) and branch on codes.

**Why:** More robust than substring matching; easier to test and localize.

## Priority 4 — Add automatic recovery attempts for common transient failures

**Recommendation:** During convergence, apply limited retries for recoverable states:

- image pull/network transient → retry pull/up for failed service (bounded attempts),
- dependency ordering transient → retry service up once dependencies healthy.

Do **not** add custom orchestration complexity; keep this as a thin compose retry wrapper.

## Priority 5 — Make install idempotency explicit and stateful

**Recommendation:** Write installer metadata marker (version, timestamp, mode) and use that for reinstall/update prompts instead of compose-content string heuristics.

**Why:** reduces false positives/negatives when compose content changes.

---

## Simplified Target Flow (Recommended)

1. `openpalm install`
2. Preflight (typed results, clear action hints)
3. Bootstrap `admin + caddy`
4. Wizard collects minimal required info only
5. User clicks **Finish Setup**
6. Server executes one transaction-like flow:
   - validate + apply stack
   - compose up core set
   - run readiness convergence loop
7. If converged: show success + “Open Workspace”
8. If not converged: show structured failure details + one-click retry

This keeps one compose runner path and one reliable completion boundary.

---

## Implementation Plan

## Phase 1: Reliability boundary hardening

- Add `ensureCoreReady()` utility in admin runtime layer:
  - inputs: service list, timeout, poll interval,
  - checks compose status + endpoint health,
  - returns structured readiness result.
- Call `ensureCoreReady()` from `setup.complete` before `completeSetup()`.
- Return typed error payload (`setup_not_ready`) with failed service diagnostics.

## Phase 2: Startup flow simplification

- Remove `setup.start_core` fire-and-forget path from wizard and command handler.
- Keep optional image pre-pull in installer (or at finalization start) but report progress synchronously.

## Phase 3: UX improvements

- Add readiness progress UI on final step.
- Add “Copy diagnostics” action including compose ps + failed service logs.
- Keep retry button idempotent and safe.

## Phase 4: Test gates

Add/expand automated scenarios:

- Happy path: all core containers healthy after setup.
- Slow startup path: health convergence eventually succeeds.
- One service unhealthy path: setup fails with structured diagnostics.
- Retry path: transient pull failure then success.
- Regression gate: setup cannot report success if any core service is not healthy/running.

---

## Operational Metrics to Track

- Time to first successful setup completion.
- Percent of installs reaching “all core healthy” on first attempt.
- Most common failed core service on first run.
- Retry success rate after initial failure.
- Support tickets tagged “install/setup stuck”.

---

## Expected Outcome

With these changes, setup success semantics become strict and user-aligned:

- Fewer ambiguous “installed but not working” states.
- Clearer user progress and failure recovery.
- Higher probability that every completed setup ends with a fully running core stack.
