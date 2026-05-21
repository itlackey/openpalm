# AKM / Capabilities Refactoring Audit

**Date:** 2026-05-21
**Branch:** release/0.11.0
**Scope:** Configuration ownership conflicts between the Capabilities system (stack.yml → OP_CAP_* → containers) and the AKM Profile system (config/akm/config.json).

---

## 1. Executive Summary

- **What works correctly today:** The happy path — a fresh install where the operator uses only the Capabilities tab — produces consistent config across stack.yml, stack.env, config/akm/config.json, and the running container. The OP_CAP_* env vars are the single runtime source of truth for containers and the entrypoint correctly re-derives akm config from them.

- **What is broken:** Saving AKM-tab-managed config (embedding connection details, named LLM profiles, per-operation feature trees) and then saving Capabilities-tab config will partially overwrite the AKM settings. The direction is one-way and non-obvious: `POST /admin/capabilities/assignments` always wins over `PATCH /admin/akm` for four shared fields in `config/akm/config.json`.

- **What is structurally unsound:** The URL-resolution logic for converting a provider name to a base URL endpoint is duplicated in four places, with no single authoritative function. Any change to how a provider's default URL is handled must be applied in four separate files.

- **What needs fixing now (high severity):** The legacy `POST /admin/capabilities` route (line 122 of `+server.ts`) does a full `writeFileSync` overwrite of `config/akm/config.json` with no merge, destroying all user-set AKM profiles, features, and behavior configuration. This route is reachable.

- **What needs fixing as a planned refactor:** The three-location URL derivation logic should be consolidated into a single exported function in `packages/lib/src/control-plane/spec-to-env.ts`. The entrypoint bash implementation should be deleted and replaced with a call to a helper script that invokes the lib function.

---

## 2. Architecture Overview

There are three independent paths that write `config/akm/config.json`. They are not coordinated.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  PATH A — Capabilities Tab  (POST /admin/capabilities/assignments)              │
│                                                                                  │
│  Browser                                                                         │
│    └─ saveAssignments()                    packages/ui/src/lib/api.ts:251       │
│         └─ POST /admin/capabilities/assignments                                  │
│              └─ +server.ts:43–116          packages/ui/src/routes/admin/        │
│                    │                           capabilities/assignments/         │
│                    │                           +server.ts                        │
│                    ├─ validateCapabilities()   packages/lib/src/control-plane/   │
│                    │                           capability-schema.ts:78           │
│                    ├─ writeStackSpec()          → OP_HOME/config/stack/stack.yml │
│                    ├─ writeCapabilityVars()     → OP_HOME/config/stack/stack.env │
│                    │   (BASE_URL_ENV_MAP copy)  spec-to-env.ts:75–100            │
│                    └─ buildAkmSetupJson()       spec-to-env.ts:213–311           │
│                         (BASE_URL_ENV_MAP copy) spec-to-env.ts:237–256           │
│                         └─ { ...existing, ...generated }                         │
│                              → OP_HOME/config/akm/config.json  (MERGE)          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  PATH B — AKM Tab  (PATCH /admin/akm)                                           │
│                                                                                  │
│  Browser                                                                         │
│    └─ saveAkmConfig()                      packages/ui/src/lib/api.ts:262       │
│         └─ PATCH /admin/akm                                                      │
│              └─ +server.ts:111–445         packages/ui/src/routes/admin/         │
│                                                akm/+server.ts                    │
│                    └─ deep merge per section                                     │
│                         → OP_HOME/config/akm/config.json  (DEEP MERGE)          │
│                                                                                  │
│  Does NOT touch: stack.yml, stack.env                                            │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  PATH C — Container Startup  (entrypoint.sh:maybe_configure_akm)                │
│                                                                                  │
│  docker start / docker compose up                                                │
│    └─ entrypoint.sh:200–258               core/assistant/entrypoint.sh          │
│         (bash copy of URL resolution)     lines 221–256                          │
│         └─ akm setup --config <json>                                             │
│              → OP_HOME/config/akm/config.json  (akm tool owns merge logic)      │
│                                                                                  │
│  Re-runs on EVERY container start.                                               │
│  Reads: OP_CAP_* from environment (sourced from stack.env by compose).          │
│  Does NOT read: config/akm/config.json before writing.                           │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  PATH D — Legacy Capabilities Route  (POST /admin/capabilities)                 │
│                                                                                  │
│  POST /admin/capabilities                                                        │
│    └─ +server.ts:64–135                   packages/ui/src/routes/admin/          │
│                                               capabilities/+server.ts            │
│         └─ buildAkmSetupJson()                                                   │
│              └─ writeFileSync(path, akmJson)  line 122  (NO MERGE, OVERWRITE)   │
│                   → OP_HOME/config/akm/config.json  (FULL OVERWRITE)            │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  PATH E — URL Resolution — FOURTH copy                                          │
│                                                                                  │
│  PROVIDER_BASE_URL_ENV                    packages/lib/src/control-plane/        │
│    (identical map to BASE_URL_ENV_MAP)    setup.ts:71–85                        │
│    used by buildSecretsFromSetup()                                               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Issue Inventory

### Issue 1 — Four implementations of the same URL-resolution logic

**Severity: MEDIUM**

The logic "given a provider name, return its base URL endpoint" is implemented independently in four places:

| Location | Lines | Form |
|---|---|---|
| `packages/lib/src/control-plane/spec-to-env.ts` | 75–100 | `BASE_URL_ENV_MAP` + `resolveUrl()` inside `writeCapabilityVars()` |
| `packages/lib/src/control-plane/spec-to-env.ts` | 237–256 | `BASE_URL_ENV_MAP` + `resolveBaseUrl()` inside `buildAkmSetupJson()` |
| `core/assistant/entrypoint.sh` | 221–254 | Bash `case` statement with same branch logic |
| `packages/lib/src/control-plane/setup.ts` | 71–85 | `PROVIDER_BASE_URL_ENV` map (used by `buildSecretsFromSetup`) |

All four encode the same provider-to-env-var mapping. The `ensureV1()` helper is copy-pasted between lines 69–71 and 232–235 of `spec-to-env.ts`. There are minor behavioral differences: `resolveUrl()` in `writeCapabilityVars()` has a special case for the ollama in-stack addon (line 92) that `resolveBaseUrl()` in `buildAkmSetupJson()` does not.

**Impact if left unaddressed:** Adding a new provider requires four edits. If any one is missed the capability resolves to an empty or default URL in one of the paths. The ollama addon URL override already diverges between the two functions in the same file.

---

### Issue 2 — Embedding config has two owners with a destructive merge order

**Severity: HIGH**

Two tabs claim ownership of the AKM embedding configuration, but they write to different schemas and different levels of the same JSON file:

**CapabilitiesTab owner:**
- Stack.yml: `capabilities.embeddings: { provider, model, dims }` — written by `POST /admin/capabilities/assignments` (`assignments/+server.ts:75–85`)
- Derived to `config/akm/config.json:embedding`: `{ endpoint, model, provider, dimension }` via `buildAkmSetupJson()` (`spec-to-env.ts:298–308`)

**AkmTab owner:**
- `config/akm/config.json:embedding`: `{ endpoint, model, provider, apiKey, dimension, localModel, batchSize, chunkSize, contextLength, ollamaOptions }` — written by `PATCH /admin/akm` (`akm/+server.ts:354–369`)

**The destructive path:**

`POST /admin/capabilities/assignments` (`assignments/+server.ts:99–101`) does:
```typescript
const merged = { ...existing, ...generated };
writeFileSync(akmConfigPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
```

`generated` (from `buildAkmSetupJson`) always includes the top-level `embedding` key. When spread into `merged`, the generated `embedding` object **completely replaces** the existing `config.embedding` object — it does not deep-merge. This means all AKM-tab-managed embedding fields (`apiKey`, `localModel`, `batchSize`, `chunkSize`, `contextLength`, `ollamaOptions`) are silently deleted the next time an operator saves Capabilities.

The AkmTab's deep merge at `akm/+server.ts:354–369` correctly preserves existing keys for all other sections. The problem is the Capabilities path has a shallow `{ ...existing, ...generated }` merge at the top level, which replaces the entire `embedding` sub-object.

**Impact if left unaddressed:** Operators who have carefully tuned AKM embedding parameters via the AKM tab (e.g., `batchSize`, `chunkSize`, `ollamaOptions.num_ctx`) will silently lose those values the next time they change any capability setting.

---

### Issue 3 — Feature flags have two representations that can diverge

**Severity: MEDIUM**

AKM's three core feature flags are stored in two places with no reconciliation between them:

**Representation 1 — StackSpec / CapabilitiesTab:**
- `stack.yml:capabilities.akm: { feedback_distillation, memory_inference, memory_consolidation }` (boolean)
- `stack.env: OP_CAP_AKM_FEEDBACK_DISTILLATION`, `OP_CAP_AKM_MEMORY_INFERENCE`, `OP_CAP_AKM_MEMORY_CONSOLIDATION` (derived by `writeCapabilityVars`, `spec-to-env.ts:174–177`)
- `config/akm/config.json:llm.features: { ... }` (derived by `buildAkmSetupJson`, `spec-to-env.ts:284–295`)

**Representation 2 — AkmTab / per-operation features:**
- `config/akm/config.json:features.improve.*` — per-operation `ProcessEntry` objects: `{ enabled, mode, profile, timeoutMs }` (managed by `PATCH /admin/akm`, `akm/+server.ts:329–351`)

These two representations are not the same thing:
- The CapabilitiesTab flags (representation 1) are simple on/off toggles that set `config.llm.features.*` — booleans consumed by akm to gate operations globally.
- The AkmTab feature entries (representation 2) are full `ProcessEntry` objects that additionally configure which profile and which execution mode (llm/agent/sdk) each operation uses.

There is no code path that synchronizes them. An operator who turns off `feedback_distillation` in CapabilitiesTab sets `config.llm.features.feedback_distillation = false`. But if `config.features.improve.feedback_distillation.enabled = true` also exists (set by AkmTab), the akm runtime will see a contradiction. Which one wins depends entirely on akm's own precedence rules, which are not documented here.

**Impact if left unaddressed:** Operators using both tabs can produce configurations where the coarse toggle and the fine-grained control conflict. The UI gives no indication of this.

---

### Issue 4 — LLM profiles vs top-level llm with no binding path

**Severity: MEDIUM**

The AKM config has two LLM-related sections with different purposes and different owners:

- `config.llm` (top-level): auto-generated by `buildAkmSetupJson()` from stack.yml capabilities. Contains `endpoint, model, provider, features`. The AkmTab does **not** expose this section and cannot modify it.
- `config.profiles.llm.*`: named LLM profiles for use in per-operation feature configuration. The AkmTab exposes full CRUD for these (`akm/+server.ts:129–137`).

There is no code path that creates a default named profile from the top-level `config.llm`. The `defaults.llm` field (set via `PATCH /admin/akm`, `akm/+server.ts:320–326`) points to a named profile ID — but the top-level LLM (the one that comes from Capabilities) is not a named profile and cannot be referenced by `defaults.llm`.

This means an operator who wants feature operations to use the same model as the primary capability must:
1. Know that `config.llm` and `config.profiles.llm` are different structures.
2. Manually recreate the Capabilities LLM settings as a named profile in AkmTab.
3. Set that profile as `defaults.llm`.

If they do not do this, feature operations will use whatever akm's own fallback behavior is, which may or may not match the Capabilities LLM.

**Impact if left unaddressed:** Advanced AKM configuration requires undocumented manual duplication of capability data. Operators will either not configure profiles at all (using akm defaults) or create drift between the capability and the profile.

---

### Issue 5 — Entrypoint overwrites admin-made changes on every container restart

**Severity: HIGH**

`core/assistant/entrypoint.sh:maybe_configure_akm()` (lines 200–258) runs unconditionally on every container start. It calls `akm setup --config <json>` where the JSON is derived purely from `OP_CAP_*` environment variables. It does not read the existing `config/akm/config.json` first.

The behavior of `akm setup --config` is: the akm tool applies the supplied config to its internal store. Depending on akm's implementation, this may merge or overwrite existing config. Based on the entrypoint's design intent (it was written to configure akm from scratch), it is intended to be a setup/seed operation — but if `akm setup` performs a merge at the akm level, the entrypoint's JSON omits many fields that the AkmTab writes (profiles, features tree, behavior, search settings) and those gaps may cause akm to reset them to defaults.

The entrypoint JSON only includes:
```json
{
  "llm": { "endpoint": "...", "model": "...", "provider": "...", "features": {...} },
  "embedding": { "endpoint": "...", "model": "...", "provider": "...", "dimension": ... }
}
```

All of the following are not present in the entrypoint JSON and are therefore subject to whatever akm's merge behavior is:
- `profiles.llm.*`
- `profiles.agent.*`
- `defaults.*`
- `features.improve.*` / `features.index.*` / `features.search.*`
- `semanticSearchMode`, `archiveRetentionDays`, `stashInheritance`
- `improve.*`, `search.*`, `feedback.*`

**Impact if left unaddressed:** Operators who configure AKM behavior via the AkmTab and then restart the assistant container (for any reason — update, crash, config change) may find their AKM configuration partially or fully reverted to capability-derived defaults.

---

### Issue 6 — Legacy capabilities route does full overwrite, destroying profiles

**Severity: HIGH**

`packages/ui/src/routes/admin/capabilities/+server.ts`, the `POST /admin/capabilities` handler, at line 122:

```typescript
writeFileSync(`${akmConfigDir}/config.json`, akmJson, { mode: 0o600 });
```

This is a direct `writeFileSync` with no read of the existing file and no merge. It writes only the capabilities-derived LLM and embedding fields. All other content in `config/akm/config.json` — named LLM profiles, agent profiles, defaults, features tree, behavior, search config — is silently deleted.

This contrasts with the `POST /admin/capabilities/assignments` handler at `assignments/+server.ts:95–101`, which does read and shallow-merge the existing file.

The legacy route (`POST /admin/capabilities`) is a v1 interface. It is not called by the current CapabilitiesTab (which uses `saveAssignments` → `POST /admin/capabilities/assignments`), but it is reachable as an HTTP endpoint and may be called by older CLI versions, scripts, or external integrations.

**Impact if left unaddressed:** Any caller of `POST /admin/capabilities` (including a downgrade scenario, a script from docs, or an older CLI version) will silently delete all user-configured AKM profiles and settings.

---

### Issue 7 — Voice config is asymmetric with AKM config

**Severity: LOW**

TTS and STT capabilities are managed exclusively through the Capabilities path:

- CapabilitiesTab / VoiceTab both call `saveAssignments` → `POST /admin/capabilities/assignments` (`api.ts:251`, `VoiceTab.svelte:70`)
- Written to `stack.yml:capabilities.tts` and `capabilities.stt`
- Derived to `stack.env: TTS_BASE_URL`, `TTS_MODEL`, `TTS_VOICE`, `STT_BASE_URL`, `STT_MODEL`, `STT_LANGUAGE` (`spec-to-env.ts:146–168`)
- There is no voice section in `config/akm/config.json`
- There is no AkmTab voice section

This is intentional (voice is a channel concern, not an AKM concern) but creates asymmetry: the AkmTab manages embedding and LLM connections directly, but voice connections pass only through the Capabilities path and are never mirrored to akm config. This is correct behavior but creates the misleading impression that the AkmTab is the "fine-grained config" tab for all service connections.

Additionally: TTS/STT API keys are explicitly not auto-resolved by `writeCapabilityVars()`. The comment at `spec-to-env.ts:139–145` explains the rationale (voice key would travel to the browser via `/config/defaults`, crossing a trust boundary). Operators must set `TTS_API_KEY` / `STT_API_KEY` in `stack.env` directly. This is not documented in the UI.

**Impact if left unaddressed:** Operators who expect the AkmTab to be the complete connection management surface will not know where to set voice API keys. This is a documentation/UX gap, not a data-corruption risk.

---

### Issue 8 — API key management is split across four locations with no map

**Severity: MEDIUM**

Provider API keys flow into the system through different paths for different use cases, with no single document describing the routing:

| Key type | Storage location | Written by | Consumed by |
|---|---|---|---|
| LLM provider keys (cloud) | `OP_HOME/config/stack/opencode.json` auth section (auth.json) | Connections tab (`/auth/{providerID}`) | OpenCode runtime |
| AKM per-profile API key override | `config/akm/config.json:profiles.llm[*].apiKey` | AkmTab (`PATCH /admin/akm`) | akm tool |
| TTS/STT API keys | `config/stack/stack.env` | Operator direct edit | Voice channel container via compose env |
| User-managed secrets | `stash/vaults/user.env` (akm vault:user) | User vault UI or `akm vault set` | Assistant container (sourced in entrypoint) |

The legacy `POST /admin/capabilities` handler also writes API keys to `stack.env` via `patchSecretsEnvFile` (line 96 of `capabilities/+server.ts`). The current `POST /admin/capabilities/assignments` handler does not write API keys at all (as documented in its comment at lines 108–112). This means the two capabilities endpoints have different side effects on credentials.

**Impact if left unaddressed:** Operators who rotate API keys must know which of the four locations contains the active key for their scenario. There is no UI surface that shows a unified credential status across all locations.

---

## 4. Refactoring Recommendations

### Quick Wins

**QW-1: Fix the legacy POST /admin/capabilities overwrite (Issue 6)**

File: `packages/ui/src/routes/admin/capabilities/+server.ts`, lines 118–123.

Change from:
```typescript
writeFileSync(`${akmConfigDir}/config.json`, akmJson, { mode: 0o600 });
```

Change to (matching the pattern in `assignments/+server.ts:95–101`):
```typescript
let existing: Record<string, unknown> = {};
if (existsSync(akmConfigPath)) {
  try { existing = JSON.parse(readFileSync(akmConfigPath, 'utf-8')); } catch { /* ignore */ }
}
const generated = JSON.parse(akmJson) as Record<string, unknown>;
const merged = { ...existing, ...generated };
writeFileSync(akmConfigPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
```

Also add `existsSync, readFileSync` to the existing `import { mkdirSync, writeFileSync }` at line 6.

Expected outcome: `POST /admin/capabilities` no longer destroys user-configured AKM profiles.

---

**QW-2: Fix the shallow merge on the embedding key in POST /admin/capabilities/assignments (Issue 2)**

File: `packages/ui/src/routes/admin/capabilities/assignments/+server.ts`, line 100.

The current merge:
```typescript
const merged = { ...existing, ...generated };
```

replaces `existing.embedding` entirely with `generated.embedding`. Change to a deep merge for the `embedding` key only:

```typescript
const merged = { ...existing, ...generated };
if (existing.embedding && generated.embedding && typeof existing.embedding === 'object' && typeof generated.embedding === 'object') {
  merged.embedding = { ...(existing.embedding as Record<string, unknown>), ...(generated.embedding as Record<string, unknown>) };
}
```

Expected outcome: AKM-tab-managed embedding fields (`apiKey`, `localModel`, `batchSize`, `chunkSize`, `contextLength`, `ollamaOptions`) survive a capabilities save. The capabilities-derived fields (`endpoint`, `model`, `provider`, `dimension`) still win if they are present in both.

---

**QW-3: Equalize the two capabilities route behaviors (Issue 6 documentation)**

At a minimum, add a comment to `POST /admin/capabilities` (`capabilities/+server.ts:64`) noting that this is the legacy v1 interface and that new callers should use `POST /admin/capabilities/assignments`. Consider adding a deprecation log line at the route level using the existing `logger` on line 35.

---

### Deeper Refactors

**DR-1: Consolidate URL resolution into a single exported function (Issue 1)**

The four copies of `BASE_URL_ENV_MAP` and the `resolveUrl`/`resolveBaseUrl`/`PROVIDER_BASE_URL_ENV` logic should be collapsed into one function exported from `packages/lib/src/control-plane/spec-to-env.ts`.

Proposed signature:
```typescript
export function resolveProviderBaseUrl(
  provider: string,
  stackEnv: Record<string, string>,
  homeDir?: string,
): string
```

This function should:
- Contain the single canonical `PROVIDER_BASE_URL_ENV` map
- Handle the ollama addon URL override (currently only in `writeCapabilityVars`, line 92)
- Handle the `ensureV1` suffix logic
- Be called by both `writeCapabilityVars` and `buildAkmSetupJson` instead of their current local copies

The `PROVIDER_BASE_URL_ENV` map in `setup.ts:71–85` should be removed and replaced with an import from `spec-to-env.ts`.

The bash implementation in `entrypoint.sh:221–254` cannot be directly replaced (it runs in a container without access to the TypeScript library), but it should be reduced to the minimal case: read the already-resolved `OP_CAP_*` variables from the environment (which were derived by `writeCapabilityVars` before container start) rather than re-deriving URLs from provider names.

Specifically, the entrypoint's `maybe_configure_akm()` already reads `OP_CAP_SLM_BASE_URL` and `OP_CAP_EMBEDDINGS_BASE_URL` (lines 215, 245) — it does not need to re-derive from provider names at all, because the resolved URLs are already in the env. The `case "$base_no_slash"` statement (lines 224–227, 251–254) is all that remains, and that is just the `ensureV1` logic applied to an already-resolved URL. That is acceptable and cannot be easily removed. The key duplication — the `BASE_URL_ENV_MAP` itself — does not actually exist in the bash script; the bash script reads pre-resolved variables. This means **the bash duplication is lower severity than it appears**: the entrypoint reads already-resolved OP_CAP_* URLs, it does not independently resolve provider-to-URL.

Files to change: `packages/lib/src/control-plane/spec-to-env.ts` (lines 67–100 and 229–256), `packages/lib/src/control-plane/setup.ts` (lines 71–85).

---

**DR-2: Define clear field ownership between Capabilities and AKM for config/akm/config.json (Issues 2, 3, 4)**

The root cause of Issues 2, 3, and 4 is that there is no written contract specifying which fields in `config/akm/config.json` are owned by the Capabilities system vs. the AKM system. The current implementation resolves this by accident (capabilities always write a subset of fields), but the accident is fragile.

Proposed contract:

| Field path in config/akm/config.json | Owner | Set by |
|---|---|---|
| `llm.endpoint`, `llm.model`, `llm.provider` | Capabilities | `buildAkmSetupJson()` |
| `llm.features.feedback_distillation`, `llm.features.memory_inference`, `llm.features.memory_consolidation` | Capabilities | `buildAkmSetupJson()` |
| `embedding.endpoint`, `embedding.model`, `embedding.provider`, `embedding.dimension` | Capabilities | `buildAkmSetupJson()` |
| `embedding.apiKey`, `embedding.localModel`, `embedding.batchSize`, `embedding.chunkSize`, `embedding.contextLength`, `embedding.ollamaOptions` | AKM | `PATCH /admin/akm` |
| `profiles.*` | AKM | `PATCH /admin/akm` |
| `defaults.*` | AKM | `PATCH /admin/akm` |
| `features.*` (the per-operation tree, not `llm.features`) | AKM | `PATCH /admin/akm` |
| `semanticSearchMode`, `archiveRetentionDays`, `stashInheritance`, `stashDir`, `defaultWriteTarget` | AKM | `PATCH /admin/akm` |
| `improve.*`, `search.*`, `feedback.*`, `output.*` | AKM | `PATCH /admin/akm` |

Once this contract is written down, `buildAkmSetupJson()` should be changed to write only its owned fields (using a targeted write that does not touch AKM-owned fields), and the shallow merge in `assignments/+server.ts:100` should be replaced with a field-by-field write that respects this contract.

Mechanical change: instead of `const merged = { ...existing, ...generated }`, write:

```typescript
const merged = { ...existing };
// Capabilities-owned fields at llm.*
if (generated.llm) {
  const existingLlm = (existing.llm as Record<string, unknown>) ?? {};
  merged.llm = {
    ...existingLlm,
    endpoint: (generated.llm as Record<string, unknown>).endpoint,
    model: (generated.llm as Record<string, unknown>).model,
    provider: (generated.llm as Record<string, unknown>).provider,
    features: (generated.llm as Record<string, unknown>).features,
  };
}
// Capabilities-owned fields at embedding.* (only the four derived fields)
if (generated.embedding) {
  const existingEmb = (existing.embedding as Record<string, unknown>) ?? {};
  merged.embedding = {
    ...existingEmb, // preserve AKM-owned fields
    endpoint: (generated.embedding as Record<string, unknown>).endpoint,
    model: (generated.embedding as Record<string, unknown>).model,
    provider: (generated.embedding as Record<string, unknown>).provider,
    dimension: (generated.embedding as Record<string, unknown>).dimension,
  };
}
```

File: `packages/ui/src/routes/admin/capabilities/assignments/+server.ts`, lines 95–101.
Apply the same pattern to `packages/ui/src/routes/admin/capabilities/+server.ts` after QW-1 is applied.

---

**DR-3: Make the entrypoint akm setup call conditional or idempotent (Issue 5)**

The entrypoint's `maybe_configure_akm()` at `core/assistant/entrypoint.sh:200–258` runs on every container start and always calls `akm setup --config`. This is appropriate on first boot but destructive on subsequent boots if the operator has modified AKM config.

Options, in order of invasiveness:

Option A (minimal): Document that `akm setup --config` is a merge, not an overwrite, by verifying akm's behavior and updating the entrypoint comment. If akm's merge is safe (preserves unknown keys), no code change is needed — only verification.

Option B (conservative): Add a sentinel file. After the first successful `akm setup --config` call, write a marker file (e.g., `/etc/openpalm/akm/.setup-complete`). On subsequent starts, skip the `akm setup` call and rely on the already-configured state. The marker should be stored in the config volume (not in the container image) so it survives restarts but is reset on `docker compose down -v`.

Option C (correct): Change `maybe_configure_akm()` to call a targeted `akm config set` (or equivalent akm subcommand) for only the capability-derived fields (`llm.endpoint`, `llm.model`, `llm.provider`, `llm.features.*`, `embedding.*`), rather than the full `akm setup --config` which may reset other fields.

The right choice depends on what `akm setup --config` does internally. This must be verified before DR-3 is implemented.

---

**DR-4: Add a UI indicator for the feature flag conflict (Issue 3)**

The CapabilitiesTab's three AKM feature toggles and the AkmTab's per-operation feature tree can diverge. The minimal fix is a UI note in both tabs explaining the relationship. The deeper fix is to either:

- Remove the coarse toggles from CapabilitiesTab entirely and redirect operators to AkmTab for feature management, or
- Have `buildAkmSetupJson()` not write `llm.features` at all, leaving that entirely to the AkmTab.

The second option aligns with DR-2's ownership contract and is the recommended approach. Removing `features` from `buildAkmSetupJson()`'s output at `spec-to-env.ts:290–294` means the entrypoint's `maybe_configure_akm()` at `entrypoint.sh:236–240` also needs to omit `features` from the akm setup JSON.

This requires coordinating with akm's default behavior: if `llm.features` is absent from config, does akm enable or disable the operations? If akm defaults to enabled, removing the Capabilities-path features write is safe.

---

## 5. What NOT to Change

These are intentional design decisions that should not be disturbed by the refactoring:

**OP_CAP_* env vars as the runtime interface.** Containers consume capabilities through `OP_CAP_*` env vars injected via compose env substitution. This indirection is correct — it means containers never need to parse YAML and the entrypoint's environment is always authoritative for runtime behavior. Do not replace this with a container-side YAML read.

**API key isolation: OpenCode auth.json vs stack.env vs vault:user.** The separation of LLM provider keys (auth.json), TTS/STT keys (stack.env), and user vault keys is intentional. The voice tab's explicit choice not to auto-resolve API keys is documented and deliberate (`spec-to-env.ts:139–145`). Do not merge these stores.

**CLI → lib delegation.** All control-plane logic lives in `@openpalm/lib`. The CLI and UI both import from lib. Do not add provider/URL mapping logic directly to CLI or UI packages.

**Voice config living only in Capabilities.** TTS/STT is a channel concern. It does not belong in `config/akm/config.json`. The asymmetry between voice and AKM tabs is correct.

**stack.yml as the canonical capabilities record.** The stack spec file is the source of truth for what capabilities are configured. Derived outputs (stack.env OP_CAP_* vars, config/akm/config.json llm/embedding sections) are always re-derivable from it. Do not store capability selections exclusively in config/akm/config.json.

**`buildAkmSetupJson()` remaining in lib.** The function is called by both the UI route and (conceptually) should be the source for the entrypoint derivation. Keep it in `spec-to-env.ts`. Do not move it to a UI-only file.

---

## 6. Migration Notes

### For DR-2 (targeted field writes)

Existing `config/akm/config.json` files on operator systems may have a mix of capabilities-derived and AKM-tab-derived content with no field ownership metadata. After DR-2 is applied, the first capabilities save will use the new targeted write. If the file has capabilities-derived fields at unexpected paths (from a previous version of `buildAkmSetupJson`), those old fields will be left in place (they are not cleaned up by DR-2, only the specific four embedding fields are now written carefully).

No migration script is needed. The worst case is stale fields in config/akm/config.json that akm ignores.

### For DR-3 (entrypoint conditionals)

If the sentinel-file approach (Option B) is chosen, the sentinel file path must be inside the config volume (mounted at `/etc/openpalm/`), not in the container's writable layer. If placed in the container's writable layer, it will be lost on `docker compose up --force-recreate`.

### For QW-2 (embedding deep merge)

The deep merge fix means that after the patch, an operator who has never used the AKM tab will see no behavioral difference. An operator who has set AKM embedding fields and then saves capabilities will now correctly retain their AKM fields. There is no scenario where the new behavior is worse than the old behavior.

### For QW-1 (legacy route overwrite fix)

After the patch, `POST /admin/capabilities` becomes safe to call at any time. Any existing documentation or scripts that advise operators to call this endpoint after configuring AKM profiles no longer carry a data-loss risk. No migration action needed.

### For DR-4 (removing llm.features from buildAkmSetupJson)

Removing `features` from the capabilities-derived akm config will mean that on first install (no `config/akm/config.json` exists yet), akm will use its own default feature behavior rather than the operator's toggle state. This is only visible if akm's default feature behavior differs from `{ feedback_distillation: true, memory_inference: true, memory_consolidation: true }`. If akm defaults to enabled, there is no regression. If akm defaults to disabled, the three CapabilitiesTab toggles must be preserved in `buildAkmSetupJson` for the first-install case only (which requires detecting a fresh vs. upgraded install — additional complexity). Verify akm defaults before implementing DR-4.
