# Admin Package Complexity Audit

Audit of unnecessary complexity in `packages/admin` that can be removed.

## Dead Code

### Unused Components (delete immediately)
- **`src/lib/components/ModelSelector.svelte`** — never imported anywhere
- **`src/lib/components/ProviderForm.svelte`** — never imported anywhere
- **`src/lib/components/opencode/ConnectProviderSheet.svelte`** — never imported anywhere (only self-references in its own warn log)

### Unused Re-export Module
- **`src/lib/provider-constants.ts`** — just re-exports from `@openpalm/lib`. Consumers could import directly.

## Duplicated Code

### API Header Construction (6 places)
The pattern `{ 'x-admin-token': token, 'x-request-id': crypto.randomUUID(), 'x-requested-by': 'ui' }` is copy-pasted in:
- `CapabilitiesTab.svelte` (line 238)
- `ConnectDetailSheet.svelte` (lines 66-68, 129)
- `ConnectProviderSheet.svelte` (line 39)
- `ManageModelsSheet.svelte` (lines 60, 122-124)

`api.ts` already has a `buildHeaders()` helper but it's **not exported**. Export it and use it everywhere.

### Capabilities Save Pattern (3 routes)
These routes each independently read stack.yml → modify → write → writeCapabilityVars:
- `routes/admin/capabilities/+server.ts`
- `routes/admin/capabilities/assignments/+server.ts`
- `routes/admin/opencode/model/+server.ts`

Extract a shared `updateAndPersistCapabilities(spec, state)` utility.

## Over-Engineering

### CapabilitiesTab State (28 separate variables)
Lines 59-75 define 17 individual `$state()` variables for capability fields (llmProvider, llmModel, slmProvider, slmModel, embProvider, embModel, embDims, ttsProvider, ttsModel, ttsVoice, sttProvider, sttModel, sttLanguage, rerankProvider, rerankMode, rerankModel, rerankTopK). Lines 51-56 add 6 more for the custom endpoint form.

Replace with structured objects:
```ts
let capabilities = $state({
  llm: { provider: '', model: '' },
  slm: { provider: '', model: '' },
  embeddings: { provider: '', model: '', dims: 768 },
  tts: { provider: '', model: '', voice: '' },
  stt: { provider: '', model: '', language: '' },
  reranking: { provider: '', mode: 'llm', model: '', topK: 10 },
});
```

### OAuth Session Management
`routes/admin/opencode/providers/[id]/auth/+server.ts` lines 27-73:
- `MAX_OAUTH_SESSIONS = 1_000` with O(n log n) trim function — this is a single-user admin panel
- Dual purge mechanisms (on-demand + periodic interval) — one is sufficient
- 15+ lines of session management code for a non-problem

### Assignments Validation (91 lines of custom validators)
`routes/admin/capabilities/assignments/+server.ts` lines 33-124:
- Custom `isRecord()`, `requireString()`, `rejectUnknownKeys()`, `parseCapabilityRef()`, `parseObjectCapability()` validator factory with callback support
- 91 lines of validation infrastructure for 5 capability types
- Could use Zod or direct type narrowing

### Model Probing Triple-Fallback
`CapabilitiesTab.svelte` `probeModels()` (lines 258-281):
1. Check providerModels cache
2. Check OpenCode provider data
3. Fall back to local detection + testCapability endpoint

Three strategies for the same data, with `loadOpenCodeProviders()` already populating the same cache.

## Unused Types / Imports

- **ManageModelsSheet.svelte** — imports `OpenCodeProviderSummary` (line 3) but never uses it; redefines `ModelEntry` locally instead of using `OpenCodeModelInfo` from types.ts

## Summary

| Item | Lines Removable | Effort |
|------|----------------|--------|
| Delete 3 unused components | ~250 | 5 min |
| Export + use `buildHeaders()` | ~30 | 30 min |
| Consolidate capability save pattern | ~40 | 1 hour |
| Replace 28 state vars with objects | ~20 | 1 hour |
| Simplify OAuth session management | ~15 | 15 min |
| Replace custom validators with Zod | ~60 | 1 hour |
| Remove unused re-export module | ~5 | 5 min |
