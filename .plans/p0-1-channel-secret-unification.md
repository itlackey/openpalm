# P0-1 Implementation Plan: Unify Channel Secret Source of Truth and Runtime Wiring

## Goal

Move channel HMAC secret lifecycle to `vault/stack/guardian.env` as the canonical source while keeping install/update/apply flows deterministic, backward-compatible during migration, and aligned across lib/CLI/admin/docs/scripts.

## Current-State Touchpoints (code/docs/tests/scripts)

### Runtime and control-plane code

- `packages/lib/src/control-plane/config-persistence.ts:69-76` - `buildEnvFiles()` currently returns only `stack.env` and `user.env`.
- `packages/lib/src/control-plane/config-persistence.ts:81-108` - `writeSystemEnv()` writes `CHANNEL_<NAME>_SECRET` into `stack.env`.
- `packages/lib/src/control-plane/config-persistence.ts:208-217` - `loadPersistedChannelSecrets()` reads channel secrets from `stack.env`.
- `packages/lib/src/control-plane/config-persistence.ts:229-246` - `writeRuntimeFiles()` generates channel secrets and persists them via `writeSystemEnv()` (currently `stack.env`).
- `packages/lib/src/control-plane/secrets.ts:109-130` - `ensureSecrets()` creates `stack.env` and `user.env`, but not `guardian.env`.
- `packages/lib/src/control-plane/docker.ts:81-85` - compose args include all `envFiles` passed in, so `buildEnvFiles()` is the main source of truth.
- `packages/lib/src/control-plane/lifecycle.ts:129-150` and `lifecycle.ts:268-273` - all preflight and service-resolution compose paths consume `buildEnvFiles()`.
- `packages/lib/src/control-plane/rollback.ts:16-19` - rollback already includes both `vault/stack/stack.env` and `vault/stack/guardian.env`.

### Compose and runtime contract docs

- `.openpalm/stack/core.compose.yml:122-124` and `core.compose.yml:132-136` - guardian already loads and mounts `guardian.env`.
- `docs/technical/environment-and-mounts.md:42-48` - docs already state 3 env files should be passed to compose.
- `docs/technical/environment-and-mounts.md:340` - currently still lists `CHANNEL_<NAME>_SECRET` under stack variables (contract drift).
- `docs/technical/authoritative/core-principles.md:105` and `core-principles.md:249` - authoritative doc still references channel HMAC secrets in `stack.env`/either location (needs explicit alignment decision).

### CLI/admin orchestration consumers

- `packages/cli/src/lib/cli-compose.ts:24-33` and `cli-compose.ts:67-83` - consumes `buildEnvFiles()` for compose args and preflight.
- `packages/admin/src/lib/server/docker.ts:38-50` - admin wrappers consume upstream `envFiles`; no custom env-file construction.
- `packages/admin/src/routes/admin/*` uses `buildEnvFiles()` broadly (install/update/upgrade/uninstall/addons routes).

### Tests currently tied to old behavior

- `packages/admin/src/lib/server/config-persistence.test.ts:152-198` - `buildEnvFiles()` tests expect max two files.
- `packages/admin/src/lib/server/config-persistence.test.ts:225-279` - channel secret generation/preservation asserted against `stack.env`.
- `packages/cli/src/install-flow.test.ts:332-340` and `install-flow.test.ts:367-372` - manual compose preflight omits guardian env file.
- `packages/admin/e2e/channel-guardian-pipeline.test.ts:35` and `channel-guardian-pipeline.test.ts:69-114` - seeds `CHANNEL_E2ETEST_SECRET` in `.dev/.../stack.env`.

### Scripts and runbooks with env-file drift

- `scripts/dev-setup.sh:145-185` - generates channel secrets into `stack.env`.
- `scripts/dev-e2e-test.sh:181-182`, `197-198`, `279-280` - compose calls omit `guardian.env`.
- `scripts/test-tier.sh:81-82` - compose invocation omits `guardian.env`.
- `scripts/upgrade-test.sh:148-149`, `326-327`, `350-351` - compose ordering/files inconsistent and omits guardian file in places.
- `scripts/iso/files/bin/openpalm-bootstrap.sh:46-47` - compose invocation omits guardian file.
- `docs/operations/manual-compose-runbook.md:55-63` and repeated command blocks - examples omit guardian file.
- `.openpalm/README.md:55-62`, `.openpalm/stack/README.md:11-16`, `.openpalm/vault/README.md:10-27` - docs still model two env-file flow and no explicit guardian secret file ownership.
- Channel package docs currently point channel secrets to `stack.env`:
  - `packages/channel-chat/README.md:22`
  - `packages/channel-api/README.md:23`
  - `packages/channel-voice/README.md:22`
  - `packages/channel-discord/README.md:18`
  - `packages/channel-slack/README.md:18`

## Implementation Phases

### Phase 0 - Define invariant and migration guardrails

1. Lock the canonical invariant in code comments and tests:
   - Channel HMAC secrets live in `vault/stack/guardian.env`.
   - `stack.env` remains for system/runtime/provider config only.
2. Keep compatibility window explicit:
   - Read legacy channel secrets from `stack.env` for migration only.
   - Write new/rotated channel secrets to `guardian.env` only.
3. Keep complexity low:
   - No new datastore.
   - No new orchestration path.
   - Reuse existing env parsing/merge helpers in `packages/lib/src/control-plane/env.ts`.

### Phase 1 - Add lib-level channel secret backend API

Target: new module in shared lib, e.g. `packages/lib/src/control-plane/channel-secrets.ts`.

1. Add typed API:
   - `readChannelSecrets(state): Record<string, string>` from `guardian.env`.
   - `writeChannelSecrets(state, updates)` merge/persist to `guardian.env`.
   - `rotateChannelSecret(state, channelName, length?)`.
   - `migrateLegacyChannelSecrets(state): { migrated: string[]; skipped: string[] }`.
2. Enforce deterministic key format:
   - Regex: `^CHANNEL_([A-Z0-9_]+)_SECRET$`.
   - Normalize channel ids to addon naming conventions (lowercase, `_`/`-` normalization strategy documented in module).
3. Ensure file bootstrap + permissions:
   - If missing, create `vault/stack/guardian.env` with managed header and `0600` mode.
   - Add helper call in `ensureSecrets()` (`packages/lib/src/control-plane/secrets.ts:109-130`).
4. Export backend from `packages/lib/src/index.ts` (new exports near existing secrets exports at `index.ts:73-104`).

### Phase 2 - Rewire runtime persistence and env-file assembly

1. Update `buildEnvFiles()` in `packages/lib/src/control-plane/config-persistence.ts:69-76`:
   - Return deterministic order: `stack.env` -> `user.env` -> `guardian.env`.
   - Keep `existsSync` filtering.
2. Refactor `writeSystemEnv()` in `config-persistence.ts:81-108`:
   - Stop accepting/writing channel secrets into `stack.env`.
   - Keep only system-managed runtime keys.
3. Replace `loadPersistedChannelSecrets()` usage (`config-persistence.ts:208-217`) with new channel backend reads from `guardian.env`.
4. Update `writeRuntimeFiles()` (`config-persistence.ts:229-246`):
   - Generate missing secrets for enabled channel addons.
   - Persist generated + existing secrets via `writeChannelSecrets()`.
   - Keep capability/env writing to `stack.env` unchanged.

### Phase 3 - Add one-time migration from legacy `stack.env`

1. Implement idempotent migration in new backend module:
   - Source: `vault/stack/stack.env` channel keys.
   - Destination: `vault/stack/guardian.env`.
   - Rule: destination wins on key conflict (do not overwrite existing guardian secret).
2. Call migration during lifecycle write path before new secret generation:
   - Suggested insertion in `writeRuntimeFiles()` before addon-secret generation.
3. Temporary compatibility behavior:
   - Keep legacy keys in `stack.env` during P0/P1 compatibility window (do not auto-delete in this phase).
   - Ensure compose interpolation still resolves from guardian file because it is last in `buildEnvFiles()` order.
4. Add migration logging (non-secret metadata only):
   - count of migrated keys
   - count of skipped conflicts

### Phase 4 - Update tests (lib, admin, CLI, e2e)

1. Update and extend lib/admin config persistence tests:
   - `packages/admin/src/lib/server/config-persistence.test.ts:152-198` -> expect 3-file env list and order.
   - `packages/admin/src/lib/server/config-persistence.test.ts:225-279` -> assert channel secrets are in `guardian.env`, not `stack.env`.
2. Add migration tests:
   - New tests under `packages/lib/src/control-plane/` (prefer colocated file, e.g. `channel-secrets.test.ts`).
   - Cases: fresh install, legacy-only, mixed, conflict, idempotent rerun.
3. Update CLI install-flow tests:
   - `packages/cli/src/install-flow.test.ts:332-340` and `:367-372` -> include third env file.
4. Update guardian pipeline e2e:
   - `packages/admin/e2e/channel-guardian-pipeline.test.ts:35` and `:69-114` -> seed/restore `.dev/vault/stack/guardian.env` instead of `stack.env`.
5. Keep regression checks that `guardian.env` is a regular file:
   - `packages/cli/src/main.test.ts:173-177` remains relevant.

### Phase 5 - Update scripts and operational runbooks

1. Dev script updates:
   - `scripts/dev-setup.sh:145-185` -> generate channel secrets into `vault/stack/guardian.env`.
   - Ensure compose command examples in scripts pass `guardian.env` as third `--env-file`.
2. E2E/automation scripts:
   - `scripts/dev-e2e-test.sh` compose invocations at `:181-182`, `:197-198`, `:279-280`.
   - `scripts/test-tier.sh:81-82`.
   - `scripts/upgrade-test.sh` compose invocations where env files are assembled.
   - `scripts/iso/files/bin/openpalm-bootstrap.sh:46-47`.
3. Docs alignment:
   - `docs/operations/manual-compose-runbook.md` - add `guardian.env` to every canonical command and secret rotation section.
   - `.openpalm/README.md`, `.openpalm/stack/README.md`, `.openpalm/vault/README.md` - update env-file model and vault structure.
   - Channel package READMEs (chat/api/voice/discord/slack) - move “system-managed HMAC secret” location to `guardian.env`.
   - `docs/technical/environment-and-mounts.md:340` - remove channel secret row from stack.env variable table; keep it only under guardian section.

### Phase 6 - Optional cleanup phase (post-stabilization)

1. After at least one release cycle, remove legacy `CHANNEL_*_SECRET` entries from `stack.env` during explicit maintenance command or controlled migration step.
2. Add a targeted cleanup utility command only if needed; otherwise keep no-op compatibility reads to avoid unnecessary complexity.

## Verification Plan

Run after implementation, in order:

1. Type and unit/integration checks:
   - `cd packages/admin && npm run check`
   - `cd packages/lib && bun test`
   - `cd packages/cli && bun test`
2. Targeted tests for this change:
   - `cd packages/lib && bun test src/control-plane/*channel*test*`
   - `cd packages/admin && bun test src/lib/server/config-persistence.test.ts`
   - `cd packages/cli && bun test src/install-flow.test.ts`
3. Compose resolution validation (representative):
   - `docker compose --project-name openpalm -f .openpalm/stack/core.compose.yml --env-file .openpalm/vault/stack/stack.env --env-file .openpalm/vault/user/user.env --env-file .openpalm/vault/stack/guardian.env config --quiet`
4. Runtime sanity:
   - rotate/add one channel secret through new backend path;
   - verify guardian sees update via `GUARDIAN_SECRETS_PATH` behavior;
   - verify channel requests still sign/verify successfully.

## Safety Checks and Rollback

1. Pre-change safety checks:
   - confirm both files exist or can be created with `0600`.
   - snapshot current env files before first migration write.
2. In-change safeguards:
   - migration is additive only; never overwrite existing `guardian.env` keys.
   - no secret values in logs/test snapshots.
3. Rollback paths:
   - automated: existing rollback snapshot includes both files (`packages/lib/src/control-plane/rollback.ts:16-19`).
   - manual: restore `vault/stack/stack.env` and `vault/stack/guardian.env` from backup snapshot and rerun apply/install lifecycle.
4. Failure criteria to stop rollout:
   - compose preflight fails due to unresolved `CHANNEL_*_SECRET`.
   - guardian rejects known-good signed request after migration.

## Risks and Open Questions

1. Authoritative doc mismatch risk:
   - `docs/technical/authoritative/core-principles.md:105` currently states channel HMAC in `stack.env`, while runtime/docs/backlog target `guardian.env`.
   - Resolution: include explicit approved update to authoritative wording as part of this P0 or obtain owner sign-off for deferred doc correction.
2. Duplicate key precedence during migration window:
   - If same key exists in both files with different values, compose precedence must be deterministic.
   - Resolution: keep `guardian.env` last in `buildEnvFiles()` and codify “guardian wins” in tests.
3. Script drift risk:
   - Multiple helper scripts hardcode two `--env-file` flags.
   - Resolution: update all script invocations in same PR; add grep-based CI check for compose commands missing guardian env file.
4. Secret backend boundary confusion:
   - Existing `secrets.ts`/`secret-backend.ts` model assumes stack.env as secret sink.
   - Resolution: keep channel-secret API separate from generic secret backend to avoid broad refactor in P0; revisit unification later only if justified.
5. E2E flake risk due to file inode update patterns:
   - Existing e2e tests use truncate/write to preserve inode semantics for bind mounts.
   - Resolution: keep same truncate+write behavior when moving test secret seeding from `stack.env` to `guardian.env`.

## Execution Checklist (ready to implement)

- [ ] Add `channel-secrets` lib module + exports.
- [ ] Ensure `guardian.env` bootstrap in `ensureSecrets()`.
- [ ] Rewire `config-persistence.ts` to write/read channel secrets via guardian backend only.
- [ ] Add idempotent legacy migration from `stack.env` -> `guardian.env`.
- [ ] Expand tests (buildEnvFiles order, migration, runtime secret persistence, CLI compose args).
- [ ] Update scripts to pass third env file and seed channel secrets in guardian file.
- [ ] Update docs/runbooks/readmes to remove `stack.env` HMAC references.
- [ ] Run verification commands and capture before/after compose preflight proof.
