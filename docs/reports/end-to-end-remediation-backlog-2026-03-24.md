# End-to-End Remediation Backlog

Date: 2026-03-24  
Source report: `docs/reports/end-to-end-solution-review-2026-03-24.md`

## Planning Notes

- Priority model: `P0` (urgent security/contract), `P1` (stability/consistency), `P2` (complexity reduction).
- Scope is implementation backlog only; no architecture expansion beyond current principles.
- Prefer shared control-plane implementation in `@openpalm/lib` and thin consumers.

## P0 (Do First)

### P0-1: Unify channel secret source of truth and runtime wiring

Priority: P0  
Risk: Critical

Problem:

- Secret storage and compose resolution are split between `stack.env` and `guardian.env`, causing contract drift and potential HMAC breakage.

Primary files:

- `packages/lib/src/control-plane/config-persistence.ts`
- `.openpalm/stack/core.compose.yml`
- `docs/technical/environment-and-mounts.md`

Implementation tasks:

1. Add a lib-level channel secret backend API (read/write/rotate) targeting `vault/stack/guardian.env`.
2. Update `buildEnvFiles()` to include `vault/stack/guardian.env` in deterministic order.
3. Stop writing `CHANNEL_*_SECRET` to `stack.env` except temporary migration support.
4. Add one-time migration logic from existing `stack.env` channel keys into `guardian.env`.
5. Ensure compose env-file assembly is only driven by shared lib paths (no script-level fallback path).

Acceptance criteria:

- New channel secret writes land in `guardian.env` only.
- Compose invocation paths (CLI/admin) resolve channel secrets consistently.
- Existing installs with `CHANNEL_*_SECRET` in `stack.env` migrate without manual edits.

---

### P0-2: Fix channel secret env variable names in addon overlays

Priority: P0  
Risk: High

Problem:

- Several overlays define `CHANNEL_SECRET`, but channels SDK expects `CHANNEL_<NAME>_SECRET`.

Primary files:

- `.openpalm/stack/addons/chat/compose.yml`
- `.openpalm/stack/addons/api/compose.yml`
- `.openpalm/stack/addons/discord/compose.yml`
- `.openpalm/stack/addons/slack/compose.yml`

Implementation tasks:

1. Replace `CHANNEL_SECRET` entries with channel-specific expected names.
2. Add integration tests validating channel startup fails/succeeds based on correct env key.

Acceptance criteria:

- All shipped channels read secrets from correctly named env vars.
- No startup failures due to missing secret env names when secrets exist.

---


## P1 (Stabilize Platform Behavior)

### P1-1: Enforce single orchestrator lock for mutating operations

Priority: P1  
Risk: High

Problem:

- CLI/admin can race on apply/mutation operations with no shared lock.

Primary files:

- `packages/lib/src/control-plane` (new lock utility)
- CLI/admin mutation entrypoints

Implementation tasks:

1. Add shared lock file mechanism in lib for mutating operations.
2. Wrap lifecycle/apply/write paths in lock acquisition/release.
3. Add timeout and actionable lock conflict errors.

Acceptance criteria:

- Concurrent mutating operations are serialized or rejected safely.
- No partial writes from race conditions.

---

### P1-2: Consolidate compose arg/env-file assembly into shared lib

Priority: P1  
Risk: High

Problem:

- Compose command construction differs across script/CLI/admin paths.

Decision:

- Delete `.openpalm/stack/start.sh` instead of maintaining script parity.

Primary files:

- `packages/cli/src/lib/cli-compose.ts`
- admin docker wrappers
- `packages/lib/src/control-plane` (new canonical builder)

Implementation tasks:

1. Create one canonical compose argument builder in lib.
2. Migrate CLI/admin to that builder.
3. Delete `.openpalm/stack/start.sh` and remove references/usages.
4. Update docs/runbooks to only reference supported CLI/admin orchestration paths.

Acceptance criteria:

- `docker compose` invocations are consistent across all entrypoints.
- `docker compose` invocations are consistent across all supported entrypoints.
- Env file order and file set are deterministic.

---

### P1-3: Standardize stack spec parsing and remove legacy ad-hoc YAML parsing

Priority: P1  
Risk: High

Problem:

- Legacy script parsing diverges from lib-enforced v2 spec model.

Primary files:

- `packages/lib/src/control-plane/stack-spec.ts`
- CLI/admin call sites using stack spec resolution

Implementation tasks:

1. Make all addon resolution go through lib parser output.
2. Delete legacy shell parsing path (via removal of `.openpalm/stack/start.sh`).
3. Add compatibility handling/migration for legacy shapes as needed.

Acceptance criteria:

- Same `stack.yaml` yields same addon set in all orchestration paths.

---

### P1-5: Delete `.openpalm/stack/start.sh` and clean drift surface

Priority: P1
Risk: High
Status: **Completed** (2026-03-24)

Problem:

- `start.sh` duplicates orchestration, compose preflight behavior, env-file handling, and stack parsing, creating drift risk.

Primary files:

- `.openpalm/stack/start.sh` (deleted)
- Docs and runbooks that reference it

Implementation tasks:

1. ~~Remove `.openpalm/stack/start.sh` from repository.~~ Done — file is absent.
2. ~~Remove references in docs/scripts/tests.~~ Done — no active operator docs or source files reference deleted path.
3. ~~Ensure supported operator workflows use CLI/admin/lib-backed commands only.~~ Done — all compose orchestration goes through `@openpalm/lib` backed CLI/admin paths.

Acceptance criteria:

- `start.sh` no longer exists. ✓
- No docs direct users to deleted script. ✓
- CI/tests pass without script-based path. ✓ (guardrail test + CI assertion added)

---


## P2 (Complexity Reduction and Maintainability)

### P2-1: Decompose guardian server monolith

Priority: P2  
Risk: Medium

Problem:

- `core/guardian/src/server.ts` is high complexity in a security-critical service.

Primary files:

- `core/guardian/src/server.ts`

Implementation tasks:

1. Split into modules (`signature`, `replay`, `rate-limit`, `assistant-forward`, `audit`).
2. Preserve behavior with snapshot/regression tests.

Acceptance criteria:

- No behavior drift in existing guardian tests.
- Reduced FTA score and clearer ownership boundaries.

---

### P2-2: Refactor CLI setup wizard high complexity file

Priority: P2  
Risk: Medium

Problem:

- `packages/cli/src/setup-wizard/wizard.js` has very high FTA score.

Implementation tasks:

1. Split into state model, prompts, validators, and output renderers.
2. Keep external CLI behavior unchanged.

Acceptance criteria:

- Wizard remains functionally equivalent.
- Significant complexity drop and improved testability.

---

### P2-3: Move admin registry sync/discovery into shared lib

Priority: P2  
Risk: Medium

Problem:

- Registry orchestration exists in admin-only module instead of shared control-plane.

Primary files:

- `packages/admin/src/lib/server/registry-sync.ts`
- `packages/lib/src/control-plane` (new registry module)

Implementation tasks:

1. Extract clone/pull/discovery functions into lib.
2. Convert admin routes to consume shared module.
3. Add lib tests covering branch/url validation and discovery behavior.

Acceptance criteria:

- Registry behavior is reusable and consistent across consumers.

## Suggested Execution Order

1. P0-1 and P0-2 together (same secret contract surface).
2. P1-1, P1-2, P1-3 as a control-plane consistency tranche.
3. P1-5 policy and drift hardening.
4. P2 maintainability work.

## Verification Checklist Per Batch

- `cd packages/admin && npm run check`
- `cd core/guardian && bun test`
- Targeted tests for channel startup, guardian ingress, and scheduler behavior.
- Validate compose resolution with canonical env-file list and addon overlays.

## Definition of Done

- All P0 items completed and merged.
- No unresolved critical/high findings from the 2026-03-24 end-to-end report.
- Docs and runtime behavior consistent on secrets, mounts, and orchestration paths.
