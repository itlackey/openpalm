# Admin UI Internal Simplification

## Context

The OpenPalm admin UI's original mental model is small: **a file editor for `OP_HOME` plus a few docker compose commands**. The runtime stack is composed entirely from files (`stack.yml`, `stack.env`, `guardian.env`, `addons/*/compose.yml`, `opencode.json`, `user.env`) — there's no template rendering, no orchestration that isn't ultimately "write a file" or "run docker compose".

Exploration confirms the server is **mostly** thin: writes flow through `@openpalm/lib`, and lifecycle endpoints (`install`, `upgrade`, `containers/*`) are already correctly delegating. But several areas have drifted into bespoke, multi-step internal logic that doesn't pull weight:

- **Provider mutations** are split across 4 nearly-identical endpoints (`save`, `toggle`, `local`, `custom`), each doing the same read-merge-write of `opencode.json`.
- **`catalog.ts`** (202 LOC) does an elaborate 5-source merge to produce a single view, with triple-fallback expressions repeated per field.
- **`capabilities/assignments`** (156 LOC) hand-rolls validation for 6+ capability shapes when a single Zod schema would express the same rules in a third of the lines.
- **`addons` and `addons/[name]`** duplicate the same enable/disable + service-stop logic with subtle drift.
- **`patchConfig`** is exposed raw; every caller repeats the read-mutate-write boilerplate.
- **`CapabilitiesTab.svelte`** (469 LOC) manages the deeply nested state of 6 capability slots inline.

**OpenCode delegation stays.** Provider configuration and OAuth must keep going through the OpenCode API — we are not reimplementing OAuth or maintaining our own provider catalog. The simplification is **internal**: thinner glue around the same OpenCode integration, plus collapsing duplicated endpoints and validation.

## Goal

Reduce server-side admin code by ~30–40% (LOC and surface area) and remove the patterns that don't justify their complexity, **without** changing the OpenCode integration boundary or losing any user-facing capability.

## Plan

### Phase 1 — Consolidate `opencode.json` mutations (server)

**Problem:** `providers/save`, `providers/toggle`, `providers/local`, `providers/custom`, `providers/model`, `opencode/model` are 6 endpoints that all do `read opencode.json → mutate one field → write back → sync to live OpenCode`.

**Change:**
- Add high-level helpers in `packages/ui/src/lib/server/opencode/config.ts`:
  - `setProviderOptions(id, options)` — replaces `providers/save`
  - `setProviderEnabled(id, enabled)` — replaces `providers/toggle` (helper already exists, hoist usage)
  - `registerProvider(id, entry)` — replaces `providers/local` + `providers/custom` (one entry shape, branched only by `kind`)
  - `setMainModel(modelId)` — replaces `opencode/model` POST + `providers/model`
- Collapse the 6 endpoints into **`PATCH /admin/providers/:id`** (provider options/enable/register) and **`PUT /admin/opencode/model`** (selection).
- Each endpoint becomes ~15 LOC: parse body → call helper → return result.

**Files touched:**
- `packages/ui/src/lib/server/opencode/config.ts` — add helpers, keep `patchConfig` private
- `packages/ui/src/routes/admin/providers/+server.ts` — accept PATCH for `:id`
- Delete: `providers/save/`, `providers/toggle/`, `providers/local/`, `providers/custom/`, `providers/model/` route folders
- Delete: `opencode/model/+server.ts` (or keep as proxy that calls the new helper)
- Update callers in `CapabilitiesTab.svelte`, `ConnectionsTab.svelte`/`ProvidersPanel.svelte`, setup wizard

**Stays:** OAuth routes (`providers/oauth/*`), provider catalog GET (`opencode/providers`), `addons/[name]/credentials` proxy.

### Phase 2 — Slim `catalog.ts`

**Problem:** `loadProviderPage` (202 LOC) repeats the `resolvedEntry ?? configEntry ?? entry` triple-merge pattern per field and inlines model extraction + sort.

**Change:**
- Extract `mergeProviderData(catalogEntry, configEntry, resolvedEntry)` — single source of truth for the field-level merge.
- Extract `extractAndSortModels(resolved, config, catalog)`.
- Keep `loadProviderPage` as the public entry; reduce it to orchestration.
- Target: 202 → ~120 LOC.

**File:** `packages/ui/src/lib/server/opencode/catalog.ts`

### Phase 3 — Replace capability validation with a Zod schema

**Problem:** `capabilities/assignments/+server.ts` lines 27–137 hand-roll validation across 6 capability shapes with bespoke required/optional/shape branching.

**Change:**
- Define one Zod schema in `packages/lib/src/control-plane/capability-schema.ts` (so CLI shares it).
- Endpoint becomes: `parseJsonBody → schema.parse → writeStackSpec → writeCapabilityVars → buildAkmSetupJson`.
- Target: 156 → ~60 LOC.

**Files:**
- New: `packages/lib/src/control-plane/capability-schema.ts`
- `packages/ui/src/routes/admin/capabilities/assignments/+server.ts`

### Phase 4 — Deduplicate addon endpoints

**Problem:** `addons/+server.ts` and `addons/[name]/+server.ts` both implement enable/disable + post-mutation service-stop + result-list rebuild, with slightly drifted code.

**Change:**
- Move the shared flow into `packages/lib/src/control-plane/addons.ts` as `setAddonState(name, enabled, state)` returning `{ changed, enabledList, stoppedServices }`.
- Both endpoints become thin wrappers (~25 LOC each).
- Target: 230 → ~120 LOC total across both routes.

### Phase 5 — Remove low-value endpoints

Evaluate and remove if unused:
- `/admin/capabilities/test` — external-API probe; if only used by setup wizard, inline it there or drop (let the user discover failures on first real use).
- `/admin/capabilities/export/opencode` — confirm no caller; remove if dead.

(These are confirmations, not assumptions — grep callers before deleting.)

### Phase 6 — UX simplification (optional, follow-up)

If server simplification lands cleanly, the natural follow-up is breaking `CapabilitiesTab.svelte` (469 LOC) into one component per slot (`LlmField`, `EmbeddingsField`, `TtsField`, `SttField`, `RerankingField`, `AkmField`) so each manages its own state. This is independent of the server work above and can be a separate PR.

## Critical files

| Path | Change |
|---|---|
| `packages/ui/src/lib/server/opencode/config.ts` | Add `setProviderOptions`, `registerProvider`, `setMainModel` |
| `packages/ui/src/lib/server/opencode/catalog.ts` | Extract `mergeProviderData`, `extractAndSortModels` |
| `packages/ui/src/routes/admin/providers/+server.ts` | Accept PATCH `:id`; subsume save/toggle/local/custom |
| `packages/ui/src/routes/admin/providers/{save,toggle,local,custom,model}/` | **Delete** |
| `packages/ui/src/routes/admin/opencode/model/+server.ts` | Reduce or merge into providers route |
| `packages/lib/src/control-plane/capability-schema.ts` | **New** — shared Zod schema |
| `packages/ui/src/routes/admin/capabilities/assignments/+server.ts` | Use schema, drop hand-rolled validation |
| `packages/lib/src/control-plane/addons.ts` | Add `setAddonState` |
| `packages/ui/src/routes/admin/addons/+server.ts` | Thin wrapper |
| `packages/ui/src/routes/admin/addons/[name]/+server.ts` | Thin wrapper |
| Callers (CapabilitiesTab, ProvidersPanel, setup wizard `/api/setup/*`) | Update fetch calls to new endpoints |

## Reuse

- `@openpalm/lib` `setAddonEnabled`, `writeStackSpec`, `patchSecretsEnvFile`, `writeCapabilityVars`, `buildAkmSetupJson` — already exist, keep using.
- `opencode/http.ts` `opencodeFetch` — unchanged; provider catalog still pulled from OpenCode.
- `helpers.ts` `requireAdmin`, `parseJsonBody`, `jsonResponse` — unchanged.
- `coercion.ts` — keep for body parsing inside the new helpers.

## Non-goals

- Replacing the OAuth subprocess flow (`providers/oauth/*`) — confirmed to stay.
- Building a generic "raw file editor" endpoint — would lose typing/audit per file class.
- Rewriting the setup wizard from scratch — it will inherit Phase 1's collapsed endpoints, no other change.
- UI redesign — `CapabilitiesTab.svelte` cleanup is deferred (Phase 6) and optional.

## Verification

End-to-end checklist per phase:

1. **Build/typecheck**: `cd packages/ui && npm run check` (0 errors before and after).
2. **Unit + browser**: `bun run ui:test:unit`.
3. **Mocked Playwright contracts**: `bun run ui:test:e2e:mocked` — these cover the wizard/admin browser contracts that exercise the renamed endpoints.
4. **Stack integration**:
   - `bun run dev:setup && bun run dev:stack`
   - In admin UI: toggle a provider (enable/disable), set provider options, register a custom provider, change main model — verify `OP_HOME/config/assistant/opencode.json` updates correctly and OpenCode picks up the change.
   - In setup wizard: complete a fresh install with `bun run wizard:dev`, walk all steps, verify same files write.
   - Toggle an addon on/off; verify `OP_HOME/config/stack/addons/<name>/` is created/removed and `docker compose ps` matches.
   - Edit capabilities (assign LLM, change embeddings) — verify `stack.yml`, `stack.env`, `config/akm/setup.json` all update.
5. **Audit log**: confirm every mutation still produces an `admin-audit.jsonl` entry with the correct actor/action.
6. **LOC delta**: `git diff --stat` should show net reduction in `packages/ui/src/routes/admin/` and `packages/ui/src/lib/server/opencode/`.

## Expected outcome

- Server-side LOC in `packages/ui/src/routes/admin/` reduced ~25–35%.
- Provider mutation surface goes from 6 endpoints to 1.
- Capability validation lives in one schema shared by CLI and UI.
- Addon enable/disable logic exists in exactly one place.
- OpenCode boundary unchanged; OAuth flow untouched; no user-visible regression.
