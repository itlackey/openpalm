# P1-1 Implementation Plan: Enforce Single Orchestrator Lock for Mutating Operations

Date: 2026-03-24
Scope: `P1-1` from `docs/reports/end-to-end-remediation-backlog-2026-03-24.md`

## Goal

Prevent concurrent CLI/admin mutation races (apply, compose mutations, config writes) by introducing one shared lock in `@openpalm/lib` and adopting it consistently in CLI and admin mutation paths.

## Constraints and Principles Alignment

- Security invariant requires one active orchestrator at a time (`docs/technical/authoritative/core-principles.md:59`).
- Control-plane logic belongs in shared lib (`docs/technical/authoritative/core-principles.md:178-187`).
- Keep implementation simple and auditable; avoid distributed/remote lock systems and avoid adding non-essential dependencies.

## Lock Design Choices

### 1) Primitive and storage location

- Use an atomic lock directory created with `mkdir` (`EEXIST` indicates held lock).
- Lock path: `${state.dataDir}/locks/orchestrator.lock`.
  - Shared between host CLI and admin container because both access `OP_HOME/data`.
  - Keeps lock state in service-managed runtime area, not in user config.
- Metadata file inside lock dir: `${state.dataDir}/locks/orchestrator.lock/meta.json`.

Design rationale:

- `mkdir` is atomic and portable in Node/Bun on Linux/macOS.
- A directory lock supports small metadata files and heartbeat updates without replacing the lock inode.

### 2) Metadata schema

Store these fields in `meta.json`:

- `lockVersion`
- `ownerId` (random UUID)
- `operation` (e.g., `cli.update`, `admin.install`, `admin.connections.save`)
- `caller` (`cli`, `ui`, `assistant`, `system`, `test`)
- `pid`
- `hostname`
- `startedAt`
- `heartbeatAt`
- `timeoutMs`

### 3) Acquire/wait behavior

- Add shared helper: `withOrchestratorLock(state, opts, fn)`.
- Default wait timeout: `30_000ms` (overridable via `OP_ORCHESTRATOR_LOCK_TIMEOUT_MS`).
- Poll interval: `250ms`.
- If lock is held:
  - read holder metadata,
  - if healthy heartbeat, wait until timeout,
  - if stale (see below), recover lock and continue.

### 4) Stale lock and recovery

- Heartbeat interval: `5_000ms` while lock is held.
- Stale threshold: `max(3 * heartbeatInterval, 20_000ms)`.
- If stale:
  - move stale lock directory to `${state.dataDir}/locks/stale/orchestrator.lock.<timestamp>.<ownerId>` (best effort),
  - retry atomic acquisition.
- Record stale recovery events through existing audit/logger paths.

### 5) Failure semantics

- New typed error in lib: `OrchestratorLockError` with `code = 'orchestrator_locked'` and details:
  - holder operation/caller/pid/age,
  - lock path,
  - requested operation,
  - timeout.
- CLI behavior: throw with actionable message, exit non-zero.
- Admin behavior: map to HTTP `423 Locked` with `errorResponse(423, 'orchestrator_locked', ...)`.
- Always release in `finally`; heartbeat timer must always be cleared.

### 6) Complexity explicitly avoided

- No Redis/DB/distributed lock service.
- No file descriptor `flock` dependency.
- No multi-lock hierarchy (single global orchestrator lock only).

## Implementation Phases

### Phase A: Add lock utility in `@openpalm/lib`

1) Add new module

- New file: `packages/lib/src/control-plane/orchestrator-lock.ts`
  - Implement:
    - `withOrchestratorLock(state, opts, fn)`
    - `acquireOrchestratorLock(state, opts)`
    - `releaseOrchestratorLock(handle)`
    - `readOrchestratorLockInfo(state)` (for diagnostics/docs/tests)
    - `OrchestratorLockError`

2) Export from package public surface

- Update `packages/lib/src/index.ts`:
  - Add exports near lifecycle/docker sections (`packages/lib/src/index.ts:187-221`).

3) Optional shared type additions

- Update `packages/lib/src/control-plane/types.ts`:
  - Add lock metadata type(s) near other control-plane types (`packages/lib/src/control-plane/types.ts:18-57`).

### Phase B: Integrate lock into lib mutation entry points

Wrap high-level mutating lib operations so callers get protection by default.

- `packages/lib/src/control-plane/lifecycle.ts`
  - `applyInstall` (`:164-166`)
  - `applyUpdate` (`:168-170`)
  - `applyUninstall` (`:172-174`)
  - `applyUpgrade` (`:232-242`)
  - `updateStackEnvToLatestImageTag` (`:193-230`)
- `packages/lib/src/control-plane/setup.ts`
  - `performSetup` (`:134-186`)

Note: low-level write helpers (e.g., `writeSystemEnv`, `writeRuntimeFiles`) remain unlocked primitives to avoid nested lock complexity; lock at orchestration boundaries.

### Phase C: CLI integration

1) Canonical compose mutation path

- `packages/cli/src/lib/cli-compose.ts`
  - Wrap `runComposeWithPreflight` (`:63-89`) in `withOrchestratorLock(...)`.
  - Operation names: `cli.start`, `cli.stop`, `cli.restart`, `cli.update`, etc. inferred from sub-args.

2) Cover install paths that bypass `runComposeWithPreflight`

- `packages/cli/src/commands/install.ts`
  - `deployServices` uses direct `runDockerCompose` (`:103-111`) -> wrap entire pull+up block.
  - `runWizardInstall` direct compose calls (`:257-264`) -> wrap the pull+up block.

3) Confirm command coverage (no missed mutators)

- `packages/cli/src/commands/start.ts:30,37`
- `packages/cli/src/commands/stop.ts:28,34`
- `packages/cli/src/commands/restart.ts:28,34`
- `packages/cli/src/commands/update.ts:15,18`
- `packages/cli/src/commands/uninstall.ts:29`
- `packages/cli/src/commands/rollback.ts:37-39`
- `packages/cli/src/commands/service.ts:47,49`

These are already routed through `runComposeWithPreflight`; once locked there, they are covered.

### Phase D: Admin integration

Use shared wrapper in route handlers so both file mutations and compose mutations are serialized.

1) Add admin helper wrapper

- Update `packages/admin/src/lib/server/helpers.ts`
  - Add `withAdminMutationLock(state, requestId, operation, fn)` near other shared helpers (`packages/admin/src/lib/server/helpers.ts:20-119`).
  - Map `OrchestratorLockError` to `423` response.

2) Wrap lifecycle routes

- `packages/admin/src/routes/admin/install/+server.ts` (`:28-97`)
- `packages/admin/src/routes/admin/update/+server.ts` (`:16-57`)
- `packages/admin/src/routes/admin/uninstall/+server.ts` (`:16-48`)
- `packages/admin/src/routes/admin/upgrade/+server.ts` (`:30-145`)
- `packages/admin/src/routes/admin/containers/pull/+server.ts` (`:17-61`)
- `packages/admin/src/routes/admin/containers/up/+server.ts` (`:18-60`)
- `packages/admin/src/routes/admin/containers/down/+server.ts` (`:18-59`)
- `packages/admin/src/routes/admin/containers/restart/+server.ts` (`:18-59`)

3) Wrap config-mutating routes (non-compose)

- `packages/admin/src/routes/admin/addons/+server.ts` POST (`:84-172`)
- `packages/admin/src/routes/admin/addons/[name]/+server.ts` POST (`:74-165`)
- `packages/admin/src/routes/admin/connections/+server.ts` POST (`:64-153`)
- `packages/admin/src/routes/admin/connections/assignments/+server.ts` POST (`:161-238`)
- `packages/admin/src/routes/admin/memory/config/+server.ts` POST (`:48-95`)
- `packages/admin/src/routes/admin/memory/reset-collection/+server.ts` (POST)
- `packages/admin/src/routes/admin/registry/install/+server.ts` (POST)
- `packages/admin/src/routes/admin/registry/uninstall/+server.ts` (POST)

Why: race condition scope includes file writes in `config/`, `stack/`, `vault/`, and `data/`, not just Docker calls.

## Error Contract

### CLI error text

- Include:
  - operation requested,
  - holder operation and age,
  - retry suggestion,
  - lock path.
- Example: `Another orchestrator operation is in progress (admin.upgrade, 12s). Retry after it completes.`

### Admin HTTP error shape

- Status: `423`
- Envelope via existing `errorResponse(...)`:
  - `error: "orchestrator_locked"`
  - `message: "Another mutating operation is currently in progress"`
  - `details`: holder metadata, `retryAfterSeconds`, `operation`, `requestId`.

## Test Plan

### 1) Lib unit tests (Bun)

- New: `packages/lib/src/control-plane/orchestrator-lock.test.ts`
  - acquire/release happy path
  - concurrent acquire waits then succeeds
  - timeout yields `OrchestratorLockError`
  - stale lock recovery path
  - release in `finally` on thrown error

### 2) Lib integration tests for lifecycle/setup lock wrapping

- Extend:
  - `packages/lib/src/control-plane/setup.test.ts`
  - `packages/admin/src/lib/server/lifecycle.test.ts` (already exercises lib lifecycle calls)
- Add tests that force lock contention and assert second operation fails/blocks as configured.

### 3) CLI tests

- Add/extend:
  - `packages/cli/src/main.test.ts`
  - new `packages/cli/src/lib/cli-compose.lock.test.ts`
- Validate user-facing lock conflict error when a synthetic lock is pre-held.

### 4) Admin tests (Vitest)

- Extend route tests for mutation endpoints (install/update/containers/etc.) to assert:
  - `423` on lock conflict,
  - no partial side effects when lock denied.
- Extend `packages/admin/src/lib/server/docker.test.ts` only if lock handling is applied in docker wrapper layer.

## Docs Updates

1) Architectural rule clarification

- `docs/technical/authoritative/core-principles.md`
  - Strengthen line `59` with concrete lock behavior and conflict semantics.

2) Directory layout

- `docs/technical/directory-structure.md`
  - Add `data/locks/` under current tree around `:66-78`.
  - Document purpose and stale-lock behavior.

3) Runtime and operations

- `docs/operations/manual-compose-runbook.md`
  - Add note in preflight/operations sections (`:71-103`, `:105-171`) warning not to run manual compose concurrently with CLI/admin mutation operations.

4) Troubleshooting

- `docs/troubleshooting.md`
  - Add section for `orchestrator_locked`/HTTP `423` with remediation and stale-lock checks.

5) Env/mount documentation (if env var added)

- `docs/technical/environment-and-mounts.md`
  - Document `OP_ORCHESTRATOR_LOCK_TIMEOUT_MS` if introduced.

## Rollout Sequence

1. Implement lib lock utility + exports.
2. Integrate lifecycle/setup wrappers in lib.
3. Integrate CLI compose/install mutation wrappers.
4. Integrate admin mutation wrappers and `423` mapping.
5. Add tests (lib -> CLI -> admin).
6. Update docs.
7. Run verification:
   - `cd packages/admin && npm run check`
   - `cd core/guardian && bun test`
   - targeted tests for lib/cli/admin lock contention.

## Acceptance Criteria Mapping (P1-1)

- Concurrent mutating operations are serialized/rejected safely:
  - Achieved by shared lock in lib and adoption in CLI/admin mutators.
- No partial writes from race conditions:
  - Achieved by acquisition before mutation, release in finally, and route-level rejection on conflict.
