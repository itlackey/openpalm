# Stack Spec Refactor Plan: Remove `secrets` and `connections`, add channel `host` exposure

This checklist plans a full refactor of stack-spec and its downstream consumers to:

1. Remove the top-level `secrets` object from stack-spec.
2. Add `host` as a valid channel exposure type.
3. Remove top-level `connections` from stack-spec.
4. Use one global `secrets.env` key/value list, referenced directly by channel config values.

---

## Target end state

- `stack-spec.json` describes only:
  - global access scope,
  - channels (`enabled`, `exposure`, `config`),
  - automations.
- Channel `config` values can contain either literal values or secret references (documented format), and no longer depend on a separate channel secret map.
- No connection registry or connection CRUD APIs.
- Artifact generation reads `secrets.env` once, resolves direct references, and writes service env files.

---

## Migration and compatibility decisions (must be finalized first)

- [ ] Decide secret reference format inside channel config values (recommended: `${SECRET_NAME}` or `secret:SECRET_NAME`; pick one and standardize everywhere).
- [ ] Decide whether to support a temporary compatibility mode for legacy stack-spec fields (`secrets`, `connections`) during rollout.
- [ ] Define behavior for unresolved references (fail render vs. warn + empty string), and use one policy across admin + CLI + tests.
- [ ] Confirm exposure semantics:
  - `public`: internet reachable,
  - `lan`: private network reachable,
  - `host`: loopback only.
- [ ] Confirm whether `accessScope` remains separate from per-channel exposure and document precedence rules.

---

## Code checklist

### 1) Stack spec model and parsing (`packages/lib/admin`)

- [ ] Update `packages/lib/admin/stack-spec.ts`:
  - [ ] Extend `ChannelExposure` to include `"host"`.
  - [ ] Remove `StackSecretsConfig`, `ChannelSecretMap`, `StackConnection`, `ConnectionType` types.
  - [ ] Remove `secrets` and `connections` fields from `StackSpec`.
  - [ ] Remove default secret maps and connection defaults.
  - [ ] Keep/adjust channel config keys for known channels, but support direct secret references in values.
  - [ ] Update parser allowed keys and validation errors to match the simplified schema.
  - [ ] Add optional migration adapter (if compatibility mode is accepted) that strips legacy fields before returning the parsed spec.
- [ ] Remove now-unused helpers in `stack-spec.ts` (for example `channelEnvSecretVariable` if no longer needed).
- [ ] Update `assets/config/stack-spec.json` to the new schema.

### 2) Artifact generation (`packages/lib/admin/stack-generator.ts`)

- [ ] Remove connection-env accumulation logic.
- [ ] Remove dependency on stack-spec secret maps for channel secret env vars.
- [ ] Add a shared resolver for channel config values:
  - [ ] detect secret reference tokens,
  - [ ] resolve from `secrets.env` map,
  - [ ] preserve literal values,
  - [ ] report unresolved refs with actionable errors.
- [ ] Implement `host` handling in route generation:
  - [ ] preserve current `lan` restriction,
  - [ ] add host-only matcher for channel routes when `exposure === "host"`.
- [ ] Ensure generated env files still include required non-channel defaults (`POSTGRES_*`, memory keys, etc.) without connection indirection.
- [ ] Verify caddy snippets remain deterministic (stable ordering for test snapshots).

### 3) Stack management APIs (`packages/lib/admin/stack-manager.ts`)

- [ ] Remove methods tied to connection lifecycle (`listConnections`, upsert/delete/validate connection methods).
- [ ] Remove channel secret mapping mutators/getters.
- [ ] Add/keep validation entrypoints for resolved channel config references if needed by admin preview flows.
- [ ] Ensure write paths only mutate remaining stack-spec fields.

### 4) Admin service HTTP surface (`admin/src/server.ts`)

- [ ] Remove `/admin/connections*` endpoints and handler branches.
- [ ] Remove connection data from any bootstrap/config payload responses.
- [ ] Update channel update endpoints to accept `host` exposure.
- [ ] Ensure validation errors for unresolved secret references are returned as clear API responses.

### 5) Front-end/admin UI (if present for connections/channels)

- [ ] Remove connections screens/routes/components.
- [ ] Remove client API calls and types for connections CRUD and validation.
- [ ] Update channel exposure controls to include `host` option.
- [ ] Update helper text to explain direct secret references in channel config fields.

### 6) Shared/admin library exports

- [ ] Remove exported connection types/functions from `packages/lib/admin/index.ts` (or equivalent barrels).
- [ ] Fix all downstream imports to the new type surface.

---

## Test checklist

### 1) Unit tests

- [ ] Rewrite `packages/lib/admin/stack-spec.test.ts`:
  - [ ] accepts `host` exposure,
  - [ ] rejects unknown exposures,
  - [ ] rejects removed fields when strict mode is intended,
  - [ ] optional compatibility tests for legacy spec translation.
- [ ] Rewrite `packages/lib/admin/stack-generator.test.ts`:
  - [ ] no connection merging behavior,
  - [ ] direct channel secret reference resolution,
  - [ ] unresolved reference behavior,
  - [ ] host exposure route output assertions.
- [ ] Rewrite `packages/lib/admin/stack-manager.test.ts`:
  - [ ] remove connection CRUD tests,
  - [ ] add stack updates that rely on direct secret references.

### 2) Admin integration/e2e tests

- [ ] Update `admin/src/admin-e2e.test.ts`:
  - [ ] remove connection endpoint tests,
  - [ ] add channel exposure=`host` API test,
  - [ ] add invalid secret reference failure test.

### 3) Contract/snapshot checks

- [ ] Update expected seeded stack-spec fixture snapshots.
- [ ] Update generated env/caddy snapshot baselines where exposure or env resolution output changes.

---

## Assets and seed data checklist

- [ ] Update `assets/config/stack-spec.json` to remove `secrets` and `connections`.
- [ ] Update any sample/fixture stack-spec files under `test/`, `assets/`, or `docs/` that still include legacy fields.
- [ ] Update asset seeding logic (`packages/lib/src/assets.ts` expectations) if schema checks are present.

---

## Scripts and operational tooling checklist

- [ ] Audit scripts under `dev/` for references to connection APIs or legacy stack-spec keys.
- [ ] Update smoke/validation scripts that parse stack-spec JSON structure.
- [ ] If there is a schema validation step in CI, update schema/fixtures accordingly.
- [ ] Add a one-time migration helper script (optional but recommended) to rewrite existing `stack-spec.json` files by removing deprecated fields.

---

## Documentation checklist

- [ ] Update `docs/admin-concepts.md`:
  - [ ] remove connection registry model,
  - [ ] describe single secret inventory + direct channel references.
- [ ] Update `docs/admin-guide.md`:
  - [ ] remove connection management sections and API walkthroughs,
  - [ ] document `host` channel exposure behavior.
- [ ] Update `docs/development/api-reference.md`:
  - [ ] remove `/admin/connections*` endpoints,
  - [ ] update stack-related payload examples.
- [ ] Update `docs/development/architecture.md` and simplification checklist docs to reflect the simplified config model.
- [ ] Update any docs mentioning `gatewayChannelSecrets` or `channelServiceSecrets`.

---

## Rollout checklist

- [ ] Phase 1: land parser/generator support + compatibility mode (if chosen), keep UI behavior stable.
- [ ] Phase 2: remove connection endpoints/UI and migrate tests.
- [ ] Phase 3: remove compatibility code and legacy docs; require new schema only.
- [ ] Publish upgrade notes with explicit before/after `stack-spec.json` examples and secret reference examples.

---

## Acceptance criteria

- [ ] New installs seed a stack-spec file with no `secrets` or `connections` keys.
- [ ] Admin + generator can render working artifacts using direct secret references from channel config.
- [ ] Channel exposure supports `host`/`lan`/`public` with expected routing behavior.
- [ ] No code paths or docs reference connection CRUD as an active feature.
- [ ] Full test suite for touched packages/services passes.
