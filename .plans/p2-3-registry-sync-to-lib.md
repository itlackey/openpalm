# P2-3 Implementation Plan: Move Admin Registry Sync/Discovery into Shared Lib

Date: 2026-03-24  
Backlog item: `P2-3` in `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:315`

## Goal and Constraints

Move registry clone/pull/discovery behavior out of admin-only code into `@openpalm/lib` so CLI/admin/scheduler can reuse one implementation, consistent with the shared control-plane rule in `docs/technical/authoritative/core-principles.md:178` and `docs/technical/authoritative/core-principles.md:184`.

This change is maintainability-only (P2): no architecture expansion, no new runtime surfaces, no behavior broadening beyond current admin behavior.

## Current State and Drift Surface (with refs)

- Admin-only registry orchestration currently lives in `packages/admin/src/lib/server/registry-sync.ts:1`.
- Admin registry API routes directly import that module:
  - `packages/admin/src/routes/admin/registry/+server.ts:18`
  - `packages/admin/src/routes/admin/registry/install/+server.ts:28`
  - `packages/admin/src/routes/admin/registry/refresh/+server.ts:22`
- Shared registry abstractions exist in lib but only for install/uninstall interface shape:
  - `packages/lib/src/control-plane/registry-provider.ts:1`
  - `packages/lib/src/control-plane/channels.ts:142`
- Existing API contract docs cover these endpoints but do not document shared-lib registry internals:
  - `docs/technical/api-spec.md:381`
  - `docs/technical/api-spec.md:405`
  - `docs/technical/api-spec.md:433`

## Proposed Module Extraction

## 1) Add canonical lib registry module

Create `packages/lib/src/control-plane/registry-sync.ts` containing logic currently in admin module:

- Registry source validation (URL + branch)
- Clone/sparse-checkout bootstrap
- Pull refresh
- Addon/component discovery
- Automation discovery
- Automation-by-name content lookup

Move these functions into lib with minimal signature drift:

- `registryRoot()`
- `ensureRegistryClone()`
- `pullRegistry()`
- `discoverRegistryComponents()`
- `discoverRegistryAutomations()`
- `getRegistryAutomation(name)`

Keep strict input guards equivalent to current admin behavior:

- Branch regex + `..` rejection now in `packages/admin/src/lib/server/registry-sync.ts:25`
- URL prefix allowlist now in `packages/admin/src/lib/server/registry-sync.ts:34`
- Name validation now in `packages/admin/src/lib/server/registry-sync.ts:132`

## 2) Keep lib layering clean

No SvelteKit/admin imports in lib module; only node APIs + existing lib helpers (`resolveCacheHome` currently imported in admin module at `packages/admin/src/lib/server/registry-sync.ts:17`).

Do not embed route-level fallback policy in this module; keep policy decisions in route handlers or a focused lib helper.

## 3) Export through package index

Add exports in `packages/lib/src/index.ts` near registry-related interfaces currently at `packages/lib/src/index.ts:41`.

Proposed export block:

- Types: `RegistryAutomationEntry`
- Functions: clone/pull/discovery/getters listed above

## API Design (lib)

## A) Types

Re-use existing `RegistryComponentEntry` and `RegistryProvider` from `packages/lib/src/control-plane/registry-provider.ts:10` and `packages/lib/src/control-plane/registry-provider.ts:18`.

Add in new module:

```ts
export type RegistryAutomationEntry = {
  name: string;
  type: "automation";
  description: string;
  schedule: string;
  ymlContent: string;
};
```

## B) Source/config resolution API

To reduce hidden global behavior, add optional options object while preserving zero-arg defaults:

```ts
type RegistrySyncOptions = {
  registryUrl?: string;
  registryBranch?: string;
  cacheHome?: string;
};
```

Rules:

- Default to current env behavior (`OP_REGISTRY_URL`, `OP_REGISTRY_BRANCH`) for compatibility.
- Validate options/env identically.
- Keep returned error contracts stable (especially `pullRegistry(): { updated: boolean; error?: string }`) to avoid route/API drift.

## C) Discovery behavior contract

Preserve existing behavior exactly:

- Components discovered from clone dir path used today in `packages/admin/src/lib/server/registry-sync.ts:140`.
- Automations discovered from clone dir path used today in `packages/admin/src/lib/server/registry-sync.ts:169`.
- YAML parse remains best-effort for `description`/`schedule` used today in `packages/admin/src/lib/server/registry-sync.ts:184`.

## Migration Plan for Admin Consumers

## Step 1: Switch admin routes to lib imports

Update imports to `@openpalm/lib`:

- `packages/admin/src/routes/admin/registry/+server.ts:18`
- `packages/admin/src/routes/admin/registry/install/+server.ts:28`
- `packages/admin/src/routes/admin/registry/refresh/+server.ts:22`

No route contract changes:

- Keep auth/audit behavior unchanged (`registry.list`, `registry.install`, `registry.refresh`).
- Keep HTTP status/error codes unchanged (`invalid_input`, `registry_sync_error`).

## Step 2: Preserve install route merge behavior

`POST /admin/registry/install` currently merges remote + local automation maps in `buildMergedAutomationRegistry(...)` at `packages/admin/src/routes/admin/registry/install/+server.ts:104`.

Plan:

- Keep this merge policy during migration (remote entries override local).
- Optionally extract to a lib helper later if reused, but do not force extra abstraction in this P2 scope.

## Step 3: Remove admin-only registry module

After route migration and green tests, delete:

- `packages/admin/src/lib/server/registry-sync.ts`

Then run a repo grep to ensure no remaining imports of `$lib/server/registry-sync.js`.

## Tests Plan

Backlog requires lib tests for branch/url validation and discovery behavior (`docs/reports/end-to-end-remediation-backlog-2026-03-24.md:333`).

## 1) New lib test file

Add `packages/lib/src/control-plane/registry-sync.test.ts`.

Cover at minimum:

- URL validation accepts `https://` and `git@`, rejects others.
- Branch validation rejects invalid chars and `..`.
- `pullRegistry()` bootstrap behavior when repo does not exist.
- Discovery name filtering with strict regex.
- Discovery ignores addon dirs missing `compose.yml` or `.env.schema`.
- Automation discovery returns parsed metadata and keeps best-effort behavior on malformed YAML.

Use temp dirs and explicit options injection (`cacheHome`, `registryUrl`, `registryBranch`) to avoid relying on mutable process-global state.

## 2) Admin regression coverage

Add or update endpoint tests so routes prove migration parity:

- Add tests for:
  - `GET /admin/registry` source selection behavior (`remote` vs fallback path) in `packages/admin/src/routes/admin/registry` test file (new if absent).
  - `POST /admin/registry/install` merged registry precedence and install errors.
  - `POST /admin/registry/refresh` error propagation from `pullRegistry().error`.

If route-specific tests do not exist yet, create focused `server.test.ts` files colocated with each route, following existing route test style (examples in `packages/admin/src/routes/admin/connections/status/server.test.ts:1` and `packages/admin/src/routes/admin/config/validate/server.test.ts:1`).

## 3) Keep existing lib tests passing

Ensure no regressions in channel/registry-adjacent logic:

- `packages/lib/src/control-plane/registry-components.test.ts:94`
- `packages/lib/src/control-plane/channels.ts:142` (install from `RegistryProvider` contract)

## Docs Update Plan

Update docs to reflect shared-lib ownership and preserve endpoint behavior text.

- `docs/technical/api-spec.md:385`
  - Keep endpoint contract unchanged.
  - Clarify that clone/pull/discovery implementation is in shared lib used by admin route handlers.
- `docs/technical/api-spec.md:433`
  - Clarify refresh is executed by shared registry sync module.
- `docs/how-it-works.md:211`
  - Add/adjust one line that `registry.*` endpoints are thin admin transport over shared control-plane logic.
- Optional maintenance note in backlog tracking doc:
  - `docs/reports/end-to-end-remediation-backlog-2026-03-24.md:315` (mark in-progress/completed when implemented).

## Sequenced Execution Steps

1. Create `packages/lib/src/control-plane/registry-sync.ts` by extracting logic from `packages/admin/src/lib/server/registry-sync.ts:1`.
2. Export new APIs from `packages/lib/src/index.ts:41` area.
3. Add lib tests in `packages/lib/src/control-plane/registry-sync.test.ts`.
4. Migrate admin registry routes to import from `@openpalm/lib`.
5. Remove `packages/admin/src/lib/server/registry-sync.ts`.
6. Add/update admin route tests for list/install/refresh behaviors.
7. Update docs refs listed above.
8. Run verification commands and fix regressions.

## Verification Commands

- `cd packages/lib && bun test src/control-plane/registry-sync.test.ts`
- `cd packages/lib && bun test`
- `cd packages/admin && npm run check`
- `cd packages/admin && bun test`
- `cd core/guardian && bun test`

## Complexity Guardrails

Unjustified complexity to avoid:

- Do not keep dual implementations (admin + lib) after migration.
- Do not introduce a second registry abstraction layer if route-level policy can stay simple.
- Do not change API payload shape/status codes as part of this extraction.

Acceptable complexity (justified):

- Optional function options for testability and deterministic dependency injection.
- Focused lib tests for validation/discovery edge cases required by backlog.

## Definition of Done (P2-3)

- Registry clone/pull/discovery implementation exists only in `@openpalm/lib`.
- Admin registry routes consume shared lib APIs and remain thin transport handlers.
- Branch/url validation + discovery behaviors are covered in lib tests.
- Admin route regressions are covered for list/install/refresh.
- Docs reflect shared ownership and remain contract-accurate.
