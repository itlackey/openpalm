# Admin Tool vs New Design — Misalignment Report

**Date:** 2026-03-22  
**Scope:** The new solution design (StackSpec v2 / `stack.yaml`, addons) as the authoritative reference. Evaluated against the Admin API implementation and `api-spec.md`.  
**Authoritative sources:** `docs/technical/directory-structure.md`, `docs/technical/core-principles.md`

---

## Architectural Context

**Addons are the component model.** There is no separate "instance" or "component" concept.

- Addons live in `stack/addons/{name}/compose.yml`
- An addon is enabled by `stack.yaml addons.{name}: true`
- An addon is configured by `stack.yaml addons.{name}: { env: { KEY: value } }` — the `env` map is the per-addon configuration mechanism; `deriveAddonEnv` writes this to `vault/stack/addons/{name}/managed.env` which compose loads via `env_file`
- `buildComposeFileList` assembles `stack/core.compose.yml` + one overlay per enabled addon
- The directory contract (`directory-structure.md`) defines `data/` as containing only: `admin/`, `assistant/`, `guardian/`, `memory/`, `stash/`, `workspace/`

**Connections = capabilities in `stack.yaml`.** Profiles do not exist. `stack.yaml capabilities` IS the connection model.

**Registry = `stack/addons/` + `config/automations/`.** The registry lists available addons and automations.

---

## Executive Summary

Four categories of misalignment:

1. **Legacy component/instance system must be deleted.** `components.ts`, `instance-lifecycle.ts`, the `/api/instances` and `/api/components` admin routes, and the CLI `component` command are built around `data/components/` and `data/catalog/` — paths that violate the directory contract and should not exist. This code represents an abandoned parallel design that addons supersede.
2. **`api-spec.md` documents the old model** and is almost entirely wrong.
3. **No admin API route exists to manage addons** — the core operation of the new design (enable/disable/configure addons via `stack.yaml`) has no admin API surface.
4. **Several confirmed build-level bugs** in the current codebase.

---

## Part 1: Legacy Code to Delete

### 1.1 `components.ts` and `instance-lifecycle.ts`

`packages/lib/src/control-plane/components.ts` and `packages/lib/src/control-plane/instance-lifecycle.ts` implement a "component instance" system that stores working copies in `data/components/{id}/` and a registry in `data/catalog/`. Both paths are absent from the directory contract.

This system duplicates what the addon model already provides:
- Addon enable/disable → `stack.yaml addons.{name}: true/false`
- Addon configuration → `stack.yaml addons.{name}: { env: { KEY: value } }`
- Addon compose inclusion → `buildComposeFileList` (already works)
- Addon env derivation → `deriveAddonEnv` + `writeManagedEnvFiles` (already works)

**Delete:** `components.ts`, `instance-lifecycle.ts`, and all their exports from `lib/src/index.ts`.

### 1.2 `/api/instances` and `/api/components` Admin Routes

All routes under `packages/admin/src/routes/api/instances/` and `packages/admin/src/routes/api/components/` depend on the deleted library code above.

**Delete:**
- `packages/admin/src/routes/api/instances/` (entire directory)
- `packages/admin/src/routes/api/components/` (entire directory)

### 1.3 CLI `component` Command

`packages/cli/src/commands/component.ts` implements `component list|instances|add|configure|remove|start|stop`. All subcommands call `discoverComponents`, `createInstance`, `configureInstance`, `deleteInstance`, etc. — the deleted library functions.

**Delete:** `packages/cli/src/commands/component.ts` and its registration in the CLI command tree.

### 1.4 `registry-sync.ts` Population of `data/catalog/`

If `registry-sync.ts` writes anything to `data/catalog/`, those writes also need to be removed.

---

## Part 2: Admin Route Coverage Gaps Against the New Design

### 2.1 No Admin Route to Enable/Disable or Configure Addons (Critical)

The new design manages addons entirely through `stack.yaml addons`. There is currently **no admin API route** that reads or writes the `addons` map.

`stack-spec.ts` already exports all needed primitives: `hasAddon`, `addonNames`, `readStackSpec`, `writeStackSpec`. `deriveAddonEnv` and `writeManagedEnvFiles` handle the env derivation. But no admin route calls them for addon management.

**Recommended new routes:**
- `GET /admin/addons` — list all known addons with their current `stack.yaml` enabled state and env config
- `POST /admin/addons/:name` — set `stack.yaml addons.{name}` to `true`, `false`, or `{ env: {...} }`; regenerate managed env files; optionally restart affected services

### 2.2 `POST /admin/containers/up` Does Not Ensure Runtime Files Are Current (Medium)

`POST /admin/containers/up` calls `composeUp` directly with `buildComposeFileList(state)` without ensuring `stack/core.compose.yml` and managed env files are current. The route should call `writeRuntimeFiles` as a preflight step, or document the precondition explicitly.

### 2.3 Channel HMAC Secret Generation Not Integrated with `stack.yaml addons` (Medium)

`writeRuntimeFiles` generates HMAC secrets for channels via `discoverChannels(state.configDir)`, which reads from `config/channels/` — not from `stack.yaml addons`. If a user enables the `discord` addon via `stack.yaml` but has no `config/channels/discord.yml`, no HMAC secret is generated and the guardian will reject its requests.

---

## Part 3: Routes Flagged for Removal

### 3.1 `/admin/opencode/*`

| Route | Behaviour |
|---|---|
| `GET /admin/opencode/status` | Probes `http://127.0.0.1:3881` |
| `GET /admin/opencode/model` | Reads model from OpenCode API + `stack.yaml` |
| `POST /admin/opencode/model` | Writes model to OpenCode API + `stack.yaml` |
| `GET /admin/opencode/providers` | Proxies to OpenCode API |
| `GET /admin/opencode/providers/[id]/auth` | Proxies to OpenCode API |
| `GET /admin/opencode/providers/[id]/models` | Proxies to OpenCode API |

Model/provider configuration is handled by `POST /admin/connections/assignments` which writes directly to `stack.yaml`. These routes are a duplicate write path with a runtime dependency on the OpenCode container. **Delete all `/admin/opencode/*` routes.**

---

## Part 4: `api-spec.md` vs. the New Design

`api-spec.md` was written before StackSpec v2 and must be treated as wrong until rewritten.

### 4.1 Connections Model Is Wrong

Documents `GET /admin/connections` returning `{ profiles, assignments, connections }`. Actual response is `{ capabilities, secrets }`. Profiles and connections-as-objects do not exist anywhere in the codebase.

### 4.2 `/admin/connections/profiles` Routes Do Not Exist

Documents `GET/POST/PUT/DELETE /admin/connections/profiles/:id`. None of these routes exist.

### 4.3 `/admin/channels` Routes Do Not Exist

Documents `GET/POST/PUT/DELETE /admin/channels`. These routes do not exist. Channel addons are managed via `stack.yaml addons` (no admin route yet, see Part 2.1).

### 4.4 Registry Route Shape Is Wrong

Documents `GET /admin/registry` returning `{ channels: [{ name, version, installed, enabled }] }`. Actual response is `{ components: [{ id, type }], automations: [...], source: "..." }`. Shape, field names, and semantics differ entirely.

### 4.5 `POST /admin/registry/install` Is Automations Only

Documents this route as installing any channel/component. It only handles automations and explicitly rejects `type: "channel"`.

### 4.6 `GET /admin/automations` Missing `scheduler` Key

Documents a `scheduler` key in the response. The actual route returns only `{ automations: [...] }`.

### 4.7 `stack.yaml` / StackSpec v2 Not Mentioned

The entire configuration model (`stack.yaml`, `capabilities`, `addons` map) is absent from `api-spec.md`.

---

## Part 5: Confirmed Build-Level Bugs

### 5.1 `packages/admin/src/lib/server/control-plane.ts` — Imports Non-Exported Functions

This file (in LSP state, not found on disk — likely deleted mid-refactor with dependents not cleaned up) imports from `@openpalm/lib`:

| Import | Status |
|---|---|
| `readEnabledInstances` | Not exported (internal to `components.ts`) |
| `addEnabledInstance` | Not exported |
| `removeEnabledInstance` | Not exported |
| `buildVoiceEnvVars` | Does not exist |
| `applyVoiceEnvVars` | Does not exist |

If this file still needs to exist, these imports must be replaced. If it was intentionally deleted, ensure nothing imports from it.

### 5.2 `packages/cli/src/lib/staging.ts` — Imports Deleted Exports

Imports `resolveArtifacts` and `FilesystemAssetProvider` from `@openpalm/lib`, and `defaultHomeDir` from `./paths.ts`. None exist. Should be deleted.

### 5.3 `packages/lib/src/control-plane/channels.ts` — Return Type Mismatch

`discoverChannels` returns `{ name, ymlPath }[]` but is typed as `ChannelInfo[]`. `ChannelInfo` requires a `hasRoute` property not present in the returned objects.

### 5.4 `packages/assistant-tools` — Minor Type Errors

- `memory-context.ts:140` — `scope: string | undefined` is not assignable to `MemoryScope | undefined`
- `tools/lib.ts:23` — `{ ok: boolean }` is missing `error` required by `ProvisionResult`

---

## Part 6: Future Work

### 6.1 Secrets Routes — Deferred

`GET/POST/DELETE /admin/secrets` and `POST /admin/secrets/generate` work correctly via `detectSecretBackend()` (`PlaintextBackend` / `PassBackend`) but may need updating as the vault model evolves. Defer to a future secrets work stream.

---

## Summary Table

| Category | Item | Action |
|---|---|---|
| Delete | `components.ts`, `instance-lifecycle.ts` and their lib exports | Delete |
| Delete | `/api/instances/*` admin routes (entire directory) | Delete |
| Delete | `/api/components/*` admin routes (entire directory) | Delete |
| Delete | CLI `component` command | Delete |
| Delete | `/admin/opencode/*` routes | Delete |
| Code Gap | No admin route to enable/disable/configure addons in `stack.yaml` | Add `GET/POST /admin/addons` |
| Code Gap | `POST /admin/containers/up` doesn't ensure runtime files are current | Fix |
| Code Gap | HMAC secret generation not integrated with `stack.yaml addons` | Fix |
| Doc | `api-spec.md` connections model, profiles routes, channels routes all wrong | Rewrite |
| Doc | `api-spec.md` registry shape wrong | Rewrite |
| Doc | `stack.yaml` / StackSpec v2 not documented in `api-spec.md` | Rewrite |
| Bug | `control-plane.ts` imports non-exported/nonexistent lib functions | Fix or delete file |
| Bug | `cli/src/lib/staging.ts` imports deleted exports | Delete file |
| Bug | `channels.ts` `discoverChannels` return type missing `hasRoute` | Fix |
| Bug | `assistant-tools` minor type errors | Fix |
| Deferred | `/admin/secrets/*` routes need updating | Future work |
