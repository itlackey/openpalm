# P0-4 Execution Plan - Scheduler Mount Hardening (Least Privilege)

Date: 2026-03-24
Backlog source: `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:99`

## Goal

Harden the `scheduler` service so it mounts only the minimum filesystem paths required for current runtime behavior, removing broad writable access to host `logs/` and `data/`.

Security driver:
- `docs/technical/authoritative/core-principles.md:120` requires per-service data ownership boundaries.
- Review finding calls out scheduler over-broad mounts at `docs/reports/end-to-end-solution-review-2026-03-24.md:86`.

## Current State Inventory (with evidence)

### 1) Current scheduler mounts in Compose

`scheduler` in `.openpalm/stack/core.compose.yml` currently mounts:
- `${OP_HOME}/config:/openpalm/config:ro` at `.openpalm/stack/core.compose.yml:164`
- `${OP_HOME}/logs:/openpalm/logs` at `.openpalm/stack/core.compose.yml:165`
- `${OP_HOME}/data:/openpalm/data` at `.openpalm/stack/core.compose.yml:166`

Only the first mount is functionally required by current code paths (see below).

### 2) Scheduler runtime code path dependencies

Scheduler runtime reads automation YAML only from `config/automations`:
- `packages/scheduler/src/server.ts:28` sets `CONFIG_DIR` to `${OP_HOME}/config`.
- `packages/lib/src/control-plane/scheduler.ts:156` resolves automations from `join(configDir, "automations")`.
- `packages/scheduler/src/scheduler.ts:218` and `packages/scheduler/src/scheduler.ts:250` watch/poll `join(configDir, "automations")`.

Scheduler currently does **not** reference `/openpalm/data` or `/openpalm/logs` in runtime code:
- no matching references in `packages/scheduler/src/*.ts`
- no matching references in `packages/lib/src/control-plane/scheduler.ts` other than `OP_HOME` passthrough for shell env (`packages/lib/src/control-plane/scheduler.ts:244`).

### 3) Existing docs already describe a narrower mount contract

Docs already specify only config mount for scheduler:
- `docs/technical/environment-and-mounts.md:191`
- `docs/technical/directory-structure.md:106`
- `docs/technical/authoritative/foundations.md:255`

This means current compose is the outlier and needs to be aligned to the existing documented contract.

### 4) Test surface touching scheduler filesystem behavior

- `packages/scheduler/src/scheduler.test.ts:208` currently expects watcher startup to create missing `automations/` directory.
- `packages/scheduler/src/server.test.ts:56` sets `OP_HOME` and expects `config/automations` behavior.
- `packages/admin/e2e/scheduler.test.ts:35` validates admin automation API behavior, dependent on scheduler reading config files.

## Implementation Plan

### Step 1 - Compose hardening (primary change)

Update scheduler volumes in `.openpalm/stack/core.compose.yml`:
- Remove `.openpalm/stack/core.compose.yml:165` (`${OP_HOME}/logs:/openpalm/logs`)
- Remove `.openpalm/stack/core.compose.yml:166` (`${OP_HOME}/data:/openpalm/data`)

Keep minimal mount:
- `.openpalm/stack/core.compose.yml:164` (`${OP_HOME}/config:/openpalm/config:ro`)

Optional stricter variant (decide during implementation based on complexity tolerance):
- Replace broad config mount with subtree mount: `${OP_HOME}/config/automations:/openpalm/config/automations:ro`
- This is stricter but requires careful handling of missing directory edge cases.

Recommended default for P0 speed/risk: keep `config` mount as-is, remove only `logs` and `data` mounts.

### Step 2 - Runtime behavior hardening for read-only model

Adjust scheduler watcher behavior to avoid runtime directory creation side effects:
- In `packages/scheduler/src/scheduler.ts:218-221`, stop assuming write access to create `automations/`.
- Replace create-on-missing behavior with fail-closed logging and no crash (or watch-disabled state) when directory is absent.

Why:
- Aligns runtime with least-privilege and read-only config mount.
- Prevents future regressions if mount is narrowed further to `config/automations:ro`.

### Step 3 - Tests

Update unit tests to match read-only/no-mkdir expectation:
- Modify `packages/scheduler/src/scheduler.test.ts:208` test case (currently "should create automations dir if missing").
  - New expectation: scheduler should not throw and should operate with zero jobs / warning path when missing.

Keep and run existing coverage:
- `packages/scheduler/src/server.test.ts` for API behavior under `OP_HOME` config path.
- `packages/admin/e2e/scheduler.test.ts` for stack behavior (when stack tests enabled).

Add regression assertion for mount boundary (choose one):
- Preferred: stack-level check in e2e script (`scripts/dev-e2e-test.sh`) that scheduler container does not have `/openpalm/data` and `/openpalm/logs` bind mounts.
- Alternative: document as manual verification command in this plan if e2e script change is out-of-scope for P0 timeline.

### Step 4 - Documentation sync

Primary docs are already aligned; update drifted operator docs and examples:

1. `docs/managing-openpalm.md`
   - Remove/replace outdated reference to system automations in `~/.openpalm/data/automations/` at `docs/managing-openpalm.md:252`.
   - Keep automations source-of-truth at `~/.openpalm/config/automations/` (`docs/managing-openpalm.md:153`, `docs/managing-openpalm.md:238`).

2. `.openpalm/stack/README.md`
   - Ensure compose command examples include `guardian.env` env-file alongside `stack.env` and `user.env` (`.openpalm/stack/README.md:13-16`, `.openpalm/stack/README.md:21-24`).
   - Keep scheduler description consistent with config-only automation input (`.openpalm/stack/README.md:40`).

3. Optional clarity note in `docs/technical/environment-and-mounts.md`
   - Add explicit scheduler note that it has no `data/` or `logs/` mounts by design (near `docs/technical/environment-and-mounts.md:214-218`).

### Step 5 - Migration and rollout

No data migration is required because scheduler does not persist runtime state to `/openpalm/data` or `/openpalm/logs` today.

Compatibility concerns to handle explicitly:
- User-authored shell automations that implicitly rely on `/openpalm/data` or `/openpalm/logs` paths inside scheduler will break after mount removal.
  - Mitigation: update automation guidance to use API actions (`type: api`) for stack-managed operations or operate on explicitly mounted paths only.
- Missing `config/automations` directory in older/manual installs can cause watcher startup edge cases.
  - Mitigation: rely on directory seeding from `ensureHomeDirs()` (`packages/lib/src/control-plane/home.ts:83`) and make watcher missing-dir behavior non-fatal.

Rollback:
- Revert scheduler volume changes in `.openpalm/stack/core.compose.yml` and recreate stack.
- No file/data restoration needed.

## Change List (Execution Checklist)

- [ ] Update `.openpalm/stack/core.compose.yml` scheduler `volumes:` to remove `logs` and `data` mounts.
- [ ] Update `packages/scheduler/src/scheduler.ts` missing-directory handling to avoid write assumptions.
- [ ] Update `packages/scheduler/src/scheduler.test.ts` expectations for missing automations directory behavior.
- [ ] Update `docs/managing-openpalm.md` stale `data/automations` guidance.
- [ ] Update `.openpalm/stack/README.md` env-file examples (`guardian.env` inclusion).
- [ ] Run verification commands and capture results in PR description.

## Verification Commands

From repo root `/home/founder3/code/github/itlackey/openpalm`:

1) Scheduler/unit-level correctness
```bash
bun test packages/scheduler
```

2) Shared control-plane regressions (automation parsing/actions)
```bash
bun test packages/lib/src/control-plane/scheduler.ts packages/lib/src/control-plane/setup.test.ts
```

3) Admin type/safety checks
```bash
cd packages/admin && npm run check
```

4) Compose render validation (ensures scheduler mounts are narrowed)
```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}" && docker compose --project-name openpalm --env-file "$OP_HOME/vault/stack/stack.env" --env-file "$OP_HOME/vault/user/user.env" --env-file "$OP_HOME/vault/stack/guardian.env" -f "$OP_HOME/stack/core.compose.yml" config
```

5) Runtime mount verification (post-`up -d`)
```bash
docker inspect "$(docker ps --filter name=scheduler --format '{{.ID}}' | head -n 1)" --format '{{json .Mounts}}'
```
Expected: mount list includes config path only; no host bind for `logs` or full `data`.

6) Health verification
```bash
docker compose --project-name openpalm --env-file "$OP_HOME/vault/stack/stack.env" --env-file "$OP_HOME/vault/user/user.env" --env-file "$OP_HOME/vault/stack/guardian.env" -f "$OP_HOME/stack/core.compose.yml" ps
```

Optional stack e2e (if enabled):
```bash
RUN_DOCKER_STACK_TESTS=1 ADMIN_TOKEN=dev-admin-token bun run admin:test:e2e -- scheduler.test.ts
```

## Complexity Callout

Avoid introducing new scheduler-specific data/log directories unless justified by an explicit functional requirement. Current implementation uses in-memory execution logs (`packages/scheduler/src/scheduler.ts:24`) and does not require persistent scheduler writes, so adding new mounts now would add unjustified complexity and weaken least-privilege outcomes.
