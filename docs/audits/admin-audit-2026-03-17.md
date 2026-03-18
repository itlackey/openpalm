# Admin UI & API Bug Report

**Date:** 2026-03-17
**Scope:** Admin SvelteKit app — API routes, UI components, connection management
**Split from:** `setup-wizard-audit-2026-03-17.md` (admin-specific items only)

---

## CRITICAL (1)

### C1. `writeOpenCodeProviderConfig()` writes `providers` + `smallModel` — crashes OpenCode v1.2.24
**Files:** `packages/lib/src/control-plane/connection-mapping.ts:99-109`
**Called from:** `POST /admin/connections` (DTO save, line 417), `POST /admin/connections/assignments` (line 79)
Every post-setup connection save through the admin UI corrupts `opencode.json` with keys that OpenCode rejects with fatal `ConfigInvalidError: Unrecognized key`. Known broken per MEMORY.md, still exported and called.

---

## HIGH (2)

### H1. Canonical DTO save drops `apiKey` — never persists to secrets.env
**File:** `packages/admin/src/routes/admin/connections/+server.ts` (`handleCanonicalDtoSave`, lines 305-457)
The client sends `apiKey` in the payload, but `handleCanonicalDtoSave()` never reads it. Profiles with `auth.mode: 'api_key'` but no `apiKeySecretRef` are rejected by `parseCanonicalConnectionProfile()` with a 400 error. Any post-setup connection save with an API key via the DTO path fails.

### H2. `anthropic` missing from `WIZARD_PROVIDER_KIND_MAP` — unified save rejects Anthropic
**File:** `packages/admin/src/lib/setup-wizard/scope.ts:33-44`
`anthropic` is in `WIZARD_PROVIDERS` (accepted by setup wizard) but NOT in `WIZARD_PROVIDER_KIND_MAP` (used by `handleUnifiedSave`). Users who set up Anthropic via the wizard cannot update their connection via the unified legacy path.

---

## MEDIUM (4)

### M1. `POST /admin/install` and `POST /admin/update` return 200 even when Docker fails
**Files:** `packages/admin/src/routes/admin/install/+server.ts:67-113`, `update/+server.ts:36-57`
HTTP status is 200 with `ok: true` even when `composeUp()` fails. Client checks `res.ok` and sees success.

### M2. Fire-and-forget Docker deployment in `POST /admin/setup` loses state on server restart
**File:** `packages/admin/src/routes/admin/setup/+server.ts:193-259`
Background `void (async () => {...})()` — if admin restarts during deployment (which happens when admin is one of the managed services), deploy status is lost.

### M3. Duplicate `provider-constants.ts` between lib and admin — drift risk
**Files:** `packages/lib/src/provider-constants.ts`, `packages/admin/src/lib/provider-constants.ts`
Byte-identical copies. Any change to one without the other creates silent mismatches.

### M4. Unified save path never updates OpenCode provider config
**File:** `packages/admin/src/routes/admin/connections/+server.ts` (`handleUnifiedSave`, lines 152-303)
Only the canonical DTO path calls `writeOpenCodeProviderConfig()` (which is broken anyway per C1). The unified path never updates OpenCode config at all.

---

## LOW (5)

| # | Bug | Location |
|---|-----|----------|
| L1 | ConnectionForm kind selector excludes `ollama_local` — can't edit in-stack profiles | `admin/src/lib/components/ConnectionForm.svelte:37` |
| L2 | Connection test `deriveProvider` heuristic only detects Ollama | `admin/src/routes/admin/connections/test/+server.ts:58-62` |
| L3 | Deploy tracker `clearDeployStatus()` exists but is never called | `admin/src/lib/server/deploy-tracker.ts` |
| L4 | Containers up/down/restart update in-memory state even when Docker is unavailable | `admin/src/routes/admin/containers/*/+server.ts` |
| L5 | `ModelSelector.svelte` `syncDefault` action doesn't re-run when options populate | `admin/src/lib/components/setup-wizard/ModelSelector.svelte:12-16` |

---

## TEST GAPS

| Gap | Description |
|-----|-------------|
| **T1** | **ZERO unit tests for `POST /admin/setup`** — the most important admin endpoint |
| **T2** | **ZERO unit tests for `POST /admin/install`** |
| **T3** | No tests for background async Docker deployment (fire-and-forget path) |
| **T4** | `writeOpenCodeProviderConfig` tests pass because they never validate against OpenCode's config schema |

---

## Priority Fixes

1. **C1** — Stop writing `providers`/`smallModel` in `writeOpenCodeProviderConfig()` (or remove it)
2. **H1** — Fix canonical DTO save to persist `apiKey` to secrets.env and set `apiKeySecretRef`
3. **H2** — Add `anthropic` to `WIZARD_PROVIDER_KIND_MAP`
4. **M1** — Return proper HTTP error codes when Docker fails
5. **M3** — Deduplicate `provider-constants.ts` (import from lib instead of copying)
6. **T1** — Add unit tests for `POST /admin/setup`
