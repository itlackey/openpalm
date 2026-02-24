# Critical Review: Docker Compose Management and Container Lifecycle

This review evaluates how OpenPalm generates Docker Compose artifacts, validates/executes Compose operations, and applies stack changes with rollback/fallback behavior. It focuses on stability, error resistance, and maintainability in setup and ongoing stack modifications.

Primary code paths reviewed:
- `packages/lib/src/admin/stack-apply-engine.ts`
- `packages/lib/src/admin/stack-manager.ts`
- `packages/lib/src/admin/compose-runner.ts`
- `packages/lib/src/admin/stack-generator.ts`
- `packages/lib/src/compose.ts`
- `packages/cli/src/commands/install.ts`

## What is already strong

- The stack has a clear artifact-generation path (`renderPreview` → `renderArtifacts`) and a dedicated apply engine that computes impact before mutating runtime state.
- Apply logic includes rollback attempts and a fallback path that prioritizes restoring admin access (`admin` + `caddy`) when a full rollback fails.
- Service action calls are constrained through an allow-list model (`allowedServiceSet`) rather than accepting arbitrary service names.
- Secret reference validation blocks apply when required secret values are missing.

---

## Recommendations

## 1) Validate the newly generated Compose file before apply

**Why this matters**
- `applyStack()` currently validates the active compose file before writing new artifacts. This validates the previous compose state, not the to-be-applied result.
- If generated Compose is invalid, failures occur mid-apply during service actions instead of being caught up front.

**Evidence**
- `composeConfigValidate()` runs before `manager.renderArtifacts(generated)`.

**Recommendation**
- Render generated artifacts to temp paths.
- Run `docker compose -f <temp-generated-compose> config` to validate.
- Only then atomically promote generated files and execute service actions.

---

## 2) Consolidate Compose command execution into one shared, hardened abstraction

**Why this matters**
- There are two Compose execution layers with different behavior: `packages/lib/src/compose.ts` (CLI flow) and `packages/lib/src/admin/compose-runner.ts` (admin flow). Divergence increases drift risk, subtle bugs, and inconsistent operator behavior.
- `runCompose` has no operation timeout and no error taxonomy. A hung daemon/socket can block lifecycle workflows.

**Recommendation**
- Build one shared Compose runner used by both CLI and admin paths.
- Standardize env-file handling, timeout/retry policy, streamed vs buffered output, and structured errors (`daemon_unreachable`, `image_pull_failed`, `invalid_compose`, `permission_denied`, etc.).
- Add per-command timeout via `AbortController`/timer with bounded retry for transient failures (e.g., network hiccups).

---

## 3) Make artifact writes transactional with two-phase staged apply and lock protection

**Why this matters**
- Artifact write + runtime actions happen in one phase; rollback tries to restore, but partial failures can leave mixed on-disk state.
- `renderArtifacts()` writes multiple files sequentially with no concurrency protection.

**Recommendation**
- Write all generated artifacts to a staging directory (`*.next` files), validate them, then atomically promote via rename/swap.
- Add a stack apply lock file with timeout (single writer semantics) to prevent concurrent apply races.
- Record a deployment transaction ID at commit time for forensic traceability.

---

## 4) Introduce health-gated apply with automatic rollback trigger

**Why this matters**
- Current apply does sequential `up`/`restart` calls, treating command exit success as sufficient. Services can succeed at startup but fail shortly after.
- Failures can cascade to dependent services and produce hard-to-diagnose partial rollouts.

**Recommendation**
- After `up`/`restart`, query `docker compose ps --format json` and require `running` + `healthy` (when healthcheck exists) with per-service timeouts.
- Trigger rollback/fallback when health gate fails, not only on command exit failure.
- Add rollout modes: `safe` (strict health gate) and `fast` (current behavior).

---

## 5) Strengthen fallback mode with a tested "golden recovery bundle"

**Why this matters**
- Fallback to admin+caddy exists, but reliability depends on local fallback artifacts and best-effort commands at failure time.

**Recommendation**
- Package a minimal, versioned recovery compose + caddy bundle with deterministic checksums.
- Validate bundle integrity before use.
- Add a periodic self-test (dry-run validation) to ensure fallback artifacts remain usable after upgrades.

---

## 6) Dependency-aware impact planning and explicit service removal handling

**Why this matters**
- Compose file changes can trigger broad restarts for core services even when changes are isolated.
- Impact derivation adds `up` for new services but does not stop/remove services deleted from spec, leaving stale containers running.

**Recommendation**
- Compute impact from structured diffs (per-service config hash, env hash, mount hash, network hash) and restart only directly affected services plus strict dependents.
- Diff old vs new service sets and execute explicit stop/remove for deleted services.
- For full-stack apply, prefer `docker compose up -d --remove-orphans` to let Compose reconcile create/update/remove lifecycle correctly.

---

## 7) Replace regex YAML service parsing with `docker compose config --services`

**Why this matters**
- Service names are parsed by line-based regex in multiple places (`parseServiceNamesFromComposeFile`, `parseComposeServiceNames`).
- This is fragile for anchors/aliases, comments, and future formatting differences and can silently mis-detect services.

**Recommendation**
- Use `docker compose -f <file> config --services` as the authoritative parser.
- Cache results during a single apply request to avoid repeated shell calls.
- Optionally fall back to a YAML parser library (not regex) for diagnostics only, never for authorization.

---

## 8) Add preflight checks for host/runtime compatibility before apply

**Why this matters**
- Validation uses `compose config`, but apply can still fail due to runtime drift (socket permissions, missing images, volume path issues, port conflicts).

**Recommendation**
- Add a preflight stage before write/apply:
  - Docker socket connectivity and permission test.
  - Port availability checks for to-be-published ports.
  - Disk space and writable mount checks for DATA/STATE/CONFIG.
  - Optional image availability/pull dry-run for changed services.
- Fail early with actionable diagnostics.

---

## 9) Improve dependency contracts and startup readiness for generated services

**Why this matters**
- Some services use `depends_on: condition: service_healthy`, but generated custom services/channels can miss consistent readiness behavior, causing boot-time race conditions.

**Recommendation**
- Standardize healthchecks for all first-class and generated services where possible.
- Enforce dependency contracts in generation (e.g., channels must declare gateway health as a prerequisite).
- Add an optional orchestration step in the apply engine that starts foundational services first, then dependents.

---

## 10) Clarify lifecycle action semantics: separate `stop` from `down`

**Why this matters**
- `composeAction("down", ...)` in the admin compose runner maps to `stop` behavior, not `docker compose down`.
- This naming mismatch misleads maintainers and API consumers and can leave networks/orphans/resources behind.

**Recommendation**
- Rename action to `stop` where that is the intent.
- Reserve `down` for actual `docker compose down` semantics (network cleanup, `--remove-orphans`), restricted to stack-wide operations with explicit confirmation.

---

## 11) Replace string-concatenated Compose generation with typed model + YAML serialization

**Why this matters**
- Compose is rendered by hand-built string blocks.
- This is brittle for indentation, escaping, optional fields, and future Compose schema evolution.
- It also makes policy checks (e.g., enforcing restart policy, healthchecks, network constraints) harder to enforce before write/apply.

**Recommendation**
- Build a typed in-memory Compose object (e.g., `ComposeSpec`) and serialize through a YAML library.
- Add an internal validation step over the object (before serialization) for required guardrails.
- Keep generated output stable with deterministic key ordering.

---

## 12) Introduce compose drift detection and reconciliation reporting

**Why this matters**
- Current flow focuses on generated artifacts, but runtime drift (manual container changes, image tag drift, missing env files) is not continuously reconciled.

**Recommendation**
- Add a periodic "drift report" comparing intended state (spec + generated artifacts) versus runtime (`compose ps`, image digests, env file presence).
- Expose drift in Admin UI with one-click reconcile actions.
- Warn before apply when unreconciled drift is detected.

---

## 13) Expand lifecycle test coverage with failure-injection scenarios

**Why this matters**
- There are tests around compose and stack generation, but stability depends heavily on failure handling paths (validation failure, partial restart failure, rollback failure, socket/runtime variance).

**Recommendation**
- Add targeted tests for:
  - invalid compose output,
  - unknown service action attempts,
  - partial apply failure with rollback success,
  - rollback failure triggering fallback,
  - runtime socket mismatch / daemon unavailable mid-operation.
- Add deterministic mocks around compose runner output and exit codes.

---

## Suggested implementation order (highest ROI first)

1. Validate generated compose pre-apply (#1)
2. Consolidate and harden compose runner (#2)
3. Health-gated apply with rollback trigger (#4)
4. Transactional artifact writes + lock (#3)
5. Strengthen fallback "golden recovery bundle" (#5)
6. Dependency-aware impact planning + service removal handling (#6)
7. Replace regex service parsing with `config --services` (#7)
8. Preflight host/runtime checks (#8)
9. Dependency contracts for generated services (#9)
10. `stop` / `down` semantics cleanup (#10)
11. Typed Compose model + YAML serialization (#11)
12. Compose drift detection and reconciliation reporting (#12)
13. Lifecycle failure-injection test coverage (#13)

## Success metrics to track

- Apply failure rate (before/after).
- Rollback success rate.
- Mean time to recover from failed apply.
- Incidents caused by invalid generated compose.
- Incidents caused by partial/torn stack state.
