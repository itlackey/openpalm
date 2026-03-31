# Issue #300 - Password manager

> Current repo alignment: the nested vault layout is already in place (`vault/user/user.env`, `vault/stack/stack.env`), reusable secrets logic lives in `packages/lib/src/control-plane/`, and admin-side OpenCode provider auth routes already exist. This plan should be read as follow-on cleanup/normalization work against that implementation, not as a description of the old flat-vault or XDG state.

## Scope

- Implement the 0.10.0 password-manager work for roadmap phases 0-4: Varlock hardening, ADMIN_TOKEN / ASSISTANT_TOKEN split, provider-agnostic secret backend support, plaintext and `pass` backends, and admin secrets APIs.
- Treat the `~/.openpalm/vault/` model as a hard prerequisite: `vault/user/user.env` is the assistant-readable hot-reload file, `vault/stack/stack.env` is system-managed, and no non-admin container gets full vault access.
- Keep all reusable control-plane logic in `packages/lib/` first; admin, CLI, and scheduler should only consume thin wrappers per the shared-library rule.
- Keep the token split explicit in both docs and implementation: the system must enforce a distinct admin credential and assistant credential everywhere. If the repo retains `OP_ADMIN_TOKEN` as the concrete env var name for compatibility, treat that as the admin token implementation detail rather than a separate third token concept.

## Dependencies and sequencing

- Depends on the nested vault contract already established in the repo: `~/.openpalm/vault/user/user.env` + `~/.openpalm/vault/stack/stack.env` and the mount contract from `docs/technical/core-principles.md`.
- Unblocks issue #304 because the admin OpenCode instance uses `ADMIN_TOKEN`, while the assistant continues to use `ASSISTANT_TOKEN`.
- Should follow the direction in `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md`, but implementation details must be normalized to the current repo layout and the lib-first rule.
- Some older planning text still centers on XDG paths, `secrets.env`, `stack.env`, and admin-only auth assumptions, but the current repo has already moved substantially beyond that. Remaining work is now normalization and follow-up refactoring rather than a first landing of the vault model.

## Phase breakdown

### Phase 0 - Foundations and hardening

- Normalize any remaining legacy flat-vault assumptions in shared helpers to the nested vault layout. In current code, `packages/lib/src/control-plane/secrets.ts` already seeds `vault/user/user.env` and `vault/stack/stack.env`, while some validation/detection helpers still reference flat schema names under `state.vaultDir`.
- Keep vault creation and write helpers in `packages/lib/src/control-plane/` creating `vault/` with `0o700` and writing `vault/user/user.env` and `vault/stack/stack.env` with `0o600`.
- Keep the two-file seed path in `ensureSecrets()`: user-managed values into `vault/user/user.env`, system-managed values into `vault/stack/stack.env`, with matching schema files for Varlock validation.
- Generate or refresh `assets/redact.env.schema` from the active vault schemas during build or release prep so runtime redaction stays aligned with `@sensitive` declarations. The current containers already copy a static file in `core/admin/Dockerfile:103`, `core/assistant/Dockerfile:107`, `core/guardian/Dockerfile:48`, and `core/memory/Dockerfile:52`.
- Verify guardian and memory remain wrapped by `varlock run`; if the redaction source changes, update only the schema generation/input path, not the runtime security posture.

### Phase 1 - Auth token split

- Extend shared state to track `assistantToken` in `packages/lib/src/control-plane/types.ts` and initialize it from `vault/stack/stack.env` during state creation.
- Keep secret seeding so the admin credential and `ASSISTANT_TOKEN` are always distinct and persisted in `vault/stack/stack.env` alongside `MEMORY_AUTH_TOKEN`; preserve compatibility aliases only if needed during migration from older installs.
- Replace the current admin-only request helper flow in `packages/admin/src/lib/server/helpers.ts:66` with token-aware helpers: `identifyCallerByToken()`, `requireAuth()`, retained `requireAdmin()`, and actor derivation based on the presented token instead of self-reported headers.
- Migrate route authorization by category:
  - Keep `requireAdmin()` for setup, install/uninstall/upgrade, secrets APIs, and any route that mutates system-level secrets or lifecycle.
  - Move operational routes to `requireAuth()` so assistant tools can keep using the admin API without receiving the admin credential. The current route tree still uses `requireAdmin()` broadly across `packages/admin/src/routes/admin/**`.
- Update compose and runtime env wiring so assistant gets `ASSISTANT_TOKEN`, admin can validate both tokens, guardian no longer depends on the admin credential for assistant-bound traffic, and scheduler/authenticated automation uses the correct token for the API surface it calls.
- Update assistant-side tooling and any admin-tools fetch helpers so the `x-admin-token` header carries `ASSISTANT_TOKEN` for normal operations, preserving header compatibility while changing credential semantics.
- Add upgrade-time backfill logic so older installs missing `ASSISTANT_TOKEN` are patched safely into `vault/stack/stack.env` during startup or migration.

### Phase 2 - Secret backend abstraction and plaintext backend

- Add lib-owned backend contracts under `packages/lib/src/control-plane/`, following the roadmap design for `SecretBackend`, core env-to-secret mappings, dynamic component secret registration, backend detection, and backend reset utilities.
- Implement backend detection from vault schemas and optional provider config, defaulting to `PlaintextBackend` when no encrypted provider is configured.
- Implement `PlaintextBackend` in `packages/lib/`, not admin, even if admin is the first consumer. It should:
  - route writes between `vault/user/user.env` and `vault/stack/stack.env`,
  - preserve the assistant hot-reload contract for user secrets,
  - support list/write/generate/remove without ever returning decrypted secret values through the API,
  - validate key classification for system keys, user keys, and dynamic component secrets.
- Move or replace current direct env mutation helpers so they become backend-aware rather than plaintext-only patchers.
- Define the canonical routing/mapping layer for:
  - core secrets (`OP_ADMIN_TOKEN`, `ASSISTANT_TOKEN`, `MEMORY_AUTH_TOKEN`, `OPENCODE_SERVER_PASSWORD`, provider keys),
  - component secrets (`openpalm/component/<instance-id>/...`),
  - ad-hoc secrets (`openpalm/custom/...`).
- Ensure no backend method returns secret values; runtime reads should continue to come from Varlock/env resolution only.

### Phase 3 - `pass` backend and setup tooling

- Keep `PassBackend` in shared lib (`packages/lib/src/control-plane/secret-backend.ts`) using `execFile`/spawn only, consistent with the no-shell-interpolation rule in the architecture docs.
- Implement strict entry-name validation to prevent traversal or malformed `pass` paths before every list/write/generate/remove/rename operation.
- Add provider config support for `~/.openpalm/data/secrets/provider.json` so backend selection is explicit and future providers remain pluggable.
- Update `core/admin/Dockerfile:68` to install `pass` in the admin runtime image because only admin should have full vault access and backend write capabilities.
- Add or maintain a `scripts/pass-init.sh` bootstrap that initializes the install-scoped pass store under `~/.openpalm/data/secrets/pass-store/`, writes provider config, and stays aligned with the current `--gpg-id` / `--prefix` flags and `provider.json` shape.
- Update setup and developer scripts to understand the new vault/provider model:
  - first-run setup should offer plaintext by default with encrypted `pass` as opt-in,
  - dev setup should seed `.dev/vault/user/user.env` and `.dev/vault/stack/stack.env` instead of old flat env files.
- Add pass-backed vault schema templates and a swap mechanism so Varlock read behavior changes by schema/provider configuration rather than consumer-specific code paths.

### Phase 4 - Secrets API, audit logging, and component lifecycle integration

- Add admin-only routes for `GET/POST/DELETE /admin/secrets` and `POST /admin/secrets/generate`, backed by shared lib backend detection and validation helpers.
- Ensure API responses expose metadata only: entry names, provider, capabilities, scope, and operation status. They must never return decrypted secret values.
- Extend audit coverage for secrets operations using the shared append path in `packages/lib/src/control-plane/audit.ts:8`, but store logs in the new `logs/admin-audit.jsonl` location mandated by `docs/technical/core-principles.md:75` rather than the current `stateDir/audit` path.
- Include deterministic actor/caller attribution in audit events so admin-token requests, assistant-token requests, CLI calls, and startup/migration tasks are distinguishable.
- Integrate secret lifecycle into component or instance operations:
  - register `@sensitive` fields from component `.env.schema` files,
  - provision or require values at instance creation time,
  - remove backend entries and deregister mappings on instance deletion,
  - keep this logic in `packages/lib/` so it is reusable by #301 component flows.
- Add admin audit retrieval changes if needed so secrets events appear in the combined audit feed without exposing values. The current audit route is in `packages/admin/src/routes/admin/audit/+server.ts:47`.
- Document how this API is the privileged path — the admin OpenCode instance (#304) has direct access via ADMIN_TOKEN, while the assistant remains unable to call secrets endpoints directly.

## Code workstreams

### Shared library and control-plane placement

- Create or extend lib modules for vault path resolution, secret backend contracts, backend registry, plaintext backend, pass backend, component secret registration, and migration helpers.
- Keep `packages/admin/src/lib/server/control-plane.ts:1` as a thin barrel/re-export layer only; do not place independent backend or secrets lifecycle logic there.
- Add lib tests for backend behavior, auth-related state loading, and migration helpers so consumers do not duplicate control-plane tests.

### Admin API and auth surface

- Refactor request helpers in `packages/admin/src/lib/server/helpers.ts:15` to distinguish admin and assistant callers without weakening existing timing-safe comparison behavior.
- Update server startup in `packages/admin/src/hooks.server.ts:32` so secret seeding, migration backfills, and schema generation happen in the right order before artifact staging.
- Review every route currently using `requireAdmin()` and classify it as admin-only or operational auth. The `grep` results under `packages/admin/src/routes/admin/` are the migration checklist seed.

### Compose, mounts, and runtime env wiring

- Keep compose and runtime env references aligned with `.openpalm/stack/core.compose.yml` and `.openpalm/stack/addons/admin/compose.yml`.
- Ensure assistant mounts only `vault/user/user.env` read-only, admin mounts the full vault read-write, and other services receive secrets only through compose substitution.
- Keep guardian-only ingress and assistant isolation intact while swapping auth tokens and secret sources.

### Scripts and operational tooling

- Add `scripts/pass-init.sh`.
- Update install/setup/dev scripts to seed or migrate vault files, provider config, and token split.
- Add any schema-generation script needed to build `assets/redact.env.schema` from vault schemas.

## Docs workstreams

- Update technical docs to reflect the finalized vault layout, auth split, and secrets backend behavior once implementation stabilizes.
- Add operator-facing docs for:
  - plaintext default behavior,
  - opting into `pass`,
  - token semantics (`OP_ADMIN_TOKEN` vs `ASSISTANT_TOKEN`),
  - backup/restore expectations for vault files and pass store data,
  - limitations and deferred UI/migration work.
- Add release and upgrade notes covering the split from legacy flat env files to `vault/user/user.env` / `vault/stack/stack.env`.

## Tests

- Add lib unit tests for vault path creation, file permissions, backend detection, plaintext routing, pass entry-name validation, and component secret registration/deregistration.
- Add admin route tests for `requireAuth()` vs `requireAdmin()`, token identity derivation, secrets endpoint authorization failures, and audit entry generation.
- Add migration tests for older installs missing `ASSISTANT_TOKEN` or still using legacy env files.
- Add integration coverage for compose/env assembly so assistant receives only user secrets and admin receives the full vault.
- Add script-level verification for `scripts/pass-init.sh` and redact-schema generation if those scripts become part of CI or release workflows.

## Migration and deferred scope

- Migration in 0.10.0 should cover token backfill and safe transition to the vault/two-file model; full migration tooling for existing plaintext installs is still deferred per roadmap phase 7.
- Password-manager UI is deferred to 0.11.0; issue #300 in 0.10.0 ships backend, auth, API, and operational plumbing only.
- Connections refactor remains deferred to 0.11.0, so any connection-profile secret references added now should be minimal and forward-compatible rather than a full redesign.
- If filesystem refactor and #300 land in separate PRs, this issue should depend on the filesystem PR and carry explicit follow-up tasks for any remaining path rewrites.

## Acceptance criteria

- Vault files and directories are created with the required permissions and validated through Varlock-backed schemas.
- `ADMIN_TOKEN` and `ASSISTANT_TOKEN` are distinct, persisted separately, and enforced correctly across admin routes, assistant tooling, guardian-facing flows, and scheduler/automation usage.
- All new reusable secrets logic lives in `packages/lib/` and admin remains a thin consumer.
- `PlaintextBackend` is the default backend and correctly routes system vs user secrets without breaking assistant hot reload.
- `PassBackend` works through `pass` CLI with validated entry names, install-scoped store paths, and no shell-interpolation hazards.
- Admin secrets APIs exist, are admin-token only, never reveal secret values, and emit audit records for list/write/generate/delete actions.
- Component-sensitive fields can register/deregister secret mappings in a backend-agnostic way suitable for #301 and downstream #304 integration.
- Existing installs can be upgraded without losing secrets, and installs missing `ASSISTANT_TOKEN` are repaired automatically.

## Open risks

- The remaining risk is inconsistency between the current nested vault implementation and older helper code or planning text that still assumes flat env-schema filenames or broader admin-only auth.
- Moving audit persistence from `stateDir/audit` to `logs/` may ripple into existing audit readers, tests, and operational tooling.
- Route reclassification from admin-only to assistant-capable auth is security-sensitive; mistakes could broaden access beyond intended operational endpoints.
- `pass` integration depends on host GPG agent/key availability inside the admin container and may vary across Linux/macOS dev setups.
- The current roadmap doc shows a few illustrative file locations under admin that should be implemented in lib instead; the implementation must prefer the architectural rule over the prose example.

## Relevant files

- `.github/roadmap/0.10.0/README.md:45` - roadmap scope, deliverables, dependency on #304, and shared-library rule.
- `.github/roadmap/0.10.0/openpalm-pass-impl-v3.md:34` - detailed secrets architecture and phased design reference.
- `docs/technical/core-principles.md:50` - vault boundary, mount contract, and writer rules.
- `docs/technical/core-principles.md:128` - control-plane logic must live in `packages/lib/`.
- `packages/lib/src/control-plane/secrets.ts` - current nested-vault secret seeding and direct plaintext mutation helpers.
- `packages/lib/src/control-plane/lifecycle.ts:46` - current state creation and env loading path.
- `packages/lib/src/control-plane/validate.ts` and `packages/lib/src/control-plane/secret-backend.ts` - remaining helpers to normalize around the nested vault schema layout.
- `packages/lib/src/control-plane/types.ts:116` - control-plane state shape that needs `assistantToken` and vault-aware evolution.
- `packages/lib/src/control-plane/audit.ts:8` - shared audit append path to extend for secrets events and log-location changes.
- `packages/admin/src/lib/server/helpers.ts:66` - current admin-only auth guard to split into admin vs assistant auth.
- `packages/admin/src/hooks.server.ts:32` - startup auto-apply and secret-seeding order.
- `packages/admin/src/lib/server/control-plane.ts:1` - thin admin wrapper that must stay logic-light.
- `packages/admin/src/routes/admin/audit/+server.ts:47` - audit API behavior that may need log-path and event-shape updates.
- `.openpalm/stack/core.compose.yml` - assistant, guardian, and scheduler env/mount assumptions.
- `.openpalm/stack/addons/admin/compose.yml` - admin env, mounts, and admin OpenCode wiring.
- `core/admin/Dockerfile:68` - admin runtime package install list to extend with `pass`.
- `core/admin/Dockerfile:103` - current static redaction schema copy path.
- `core/assistant/Dockerfile:107` - assistant runtime redaction schema path.
- `core/guardian/Dockerfile:48` - guardian redaction schema path and Varlock wrapping.
- `core/memory/Dockerfile:52` - memory redaction schema path and Varlock wrapping.
- `scripts/dev-setup.sh:64` - legacy dev env seeding that must shift to the vault/two-file model.
