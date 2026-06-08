# Setup Wizard — Deep Audit (targeting 0.11.3)

> Generated 2026-06-08 from a 5-angle multi-agent analysis (45 agents) of the setup wizard, 
each finding adversarially verified against source. 40 candidates → 38 verified → 25 deduped issues.


Severity counts: high=9, medium=11, low=5.

## Already fixed in this pass (on release/0.11.2)

The four user-reported bugs and their closest verified gaps are **patched** —
the remaining issues below are tracked for 0.11.3:

- ✅ **Guardian deployed/awaited with zero channels** — `buildManagedServices`
  now only manages guardian when a channel addon is enabled (assistant is the
  only unconditional core service).
- ✅ **Orphaned stopped Ollama container** — the pre-deploy `compose down` now
  passes `--remove-orphans`, pruning a previously-enabled-then-disabled
  profile-gated addon.
- ✅ **Poor local model defaults / embedding offered as chat** — a single shared
  `buildModelOptions` (wizard/helpers.ts) now excludes embedding models from
  chat/small, matches provider defaults tag-insensitively, and ranks best-first.
  Replaces the duplicated builder in `+page.svelte` and `ModelsStep.svelte`.
- ✅ **Host OpenCode provider didn't override Ollama** — host model preferences
  are re-applied *after* the provider model lists load (race fixed), and
  host/cloud providers now rank above local Ollama for the default chat model.


The four user-reported bugs map to: #1 (guardian), #2 (ollama orphan), #3 (model defaults cluster), #4 (host-import precedence/race).


---

## HIGH severity


### 1. [deploy-stack] Guardian unconditionally deployed even with zero channels enabled _(corroborated by 3 independent angles)_

- **Type:** bug · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/control-plane/lifecycle.ts:380`
- **Problem:** buildManagedServices() always includes guardian in CORE_SERVICES=[assistant, guardian], but guardian is only useful when at least one channel (chat, api, discord, slack) is enabled. With zero channels, guardian starts and blocks on health-wait timeout unnecessarily.
- **Evidence:** Line 380: `const services = new Set<string>(CORE_SERVICES);` — CORE_SERVICES is defined in types.ts line 46-49 as `['assistant', 'guardian']`. Guardian has no purpose without channels that call it (all channels in channels.compose.yml depend_on guardian).
- **Recommendation:** Make guardian conditional: only include in CORE_SERVICES (or add to managed services) when at least one channel addon is enabled. Modify buildManagedServices to check `listEnabledAddonIds(state.homeDir).some(a => ['chat', 'api', 'discord', 'slack'].includes(a))` and only add guardian if true. Assistant should continue deploying unconditionally as the core runtime.
- **Verified:** The code at /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/lifecycle.ts line 380 unconditionally initializes the managed services set with `CORE_SERVICES=['assistant', 'guardian']` (defined at /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/types.ts lines 46-49). Guardian is never conditionally removed later in the function. Both code paths (Docker-based discovery at lines 383-389, and fallback addon discovery at lines 391-395) return the set unchanged, meaning guardian will always be included even when zero channels are enabled. This is problematic because guardian's sole purpose is to serve as the ingress for channels (chat, api, discord, slack), each of which declares `depends_on: guardian: condition: service_healthy` in /home/founder3/code/github/itlackey/openpalm/.openpalm/config/stack/channels.compose.yml (lines 23, 52, 91, 125). When no channels are enabled, guardian has no callers and unnecessarily blocks deployment health-checks waiting for it to become healthy.


### 2. [host-detection] Local provider detection only probes fixed default ports

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/control-plane/model-runner.ts`
- **Problem:** detectLocalProviders() hardcodes port numbers (11434 for Ollama, 1234 for LM Studio, 12434 for model-runner) and does not check environment variables like OLLAMA_HOST. Users running Ollama on custom ports (e.g., OLLAMA_HOST=0.0.0.0:9999) will not be detected, leaving them unable to use their local LLM without manual configuration.
- **Evidence:** Lines 38-94 define LOCAL_PROVIDER_PROBES with fixed URLs: `http://ollama:11434/api/tags`, `http://host.docker.internal:11434/api/tags`, `http://localhost:11434/api/tags` for Ollama; `http://localhost:1234/v1/models` for LM Studio; `http://localhost:12434/engines/v1/models` for model-runner. No code path reads OLLAMA_HOST, LMSTUDIO_PORT, or MODEL_RUNNER_PORT environment variables.
- **Recommendation:** Enhance detectLocalProviders() to read environment variables as fallback port sources: for Ollama check OLLAMA_HOST env var (parse the host:port if provided), for LM Studio check LMSTUDIO_PORT env var, for model-runner check MODEL_RUNNER_PORT env var. Insert custom-port probes ahead of the default ones in the list so environment-specified ports are tried first.
- **Verified:** The `detectLocalProviders()` function at /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/model-runner.ts (lines 38-126) defines a hardcoded LOCAL_PROVIDER_PROBES array with fixed port numbers: port 11434 for Ollama (lines 65, 70, 75), port 1234 for LM Studio (lines 85, 89), and port 12434 for model-runner (lines 47, 51, 55). The function iterates through these static probes (lines 104-125) with no mechanism to read environment variables like OLLAMA_HOST, LMSTUDIO_PORT, or MODEL_RUNNER_PORT. A grep search across the codebase confirms zero references to these environment variables in model-runner.ts or the detect-providers endpoint. Users running local providers on custom ports will not be auto-detected.
- **Verifier correction:** Local provider detection hardcodes port numbers (11434 for Ollama, 1234 for LM Studio, 12434 for model-runner) and does not read environment variables like OLLAMA_HOST, LMSTUDIO_PORT, or MODEL_RUNNER_PORT to discover providers running on non-standard ports.


### 3. [host-import] No precedence logic when host OpenCode AND local providers both present _(corroborated by 6 independent angles)_

- **Type:** misalignment · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/api/setup/recommend/+server.ts`
- **Problem:** When a host OpenCode installation with configured providers exists AND local provider endpoints (Ollama, LM Studio) are detected running, the recommendation engine does not specify which takes precedence. Both are returned to the wizard, and the UI's import logic does not prevent Ollama from being auto-enabled when a host OpenCode provider (e.g., a Claude provider) should take priority. Per architecture rules, 'A host OpenCode/AKM with configured providers should take precedence over the bundled in-stack Ollama.'
- **Evidence:** Lines 72-76 in recommend/+server.ts return both hostProviders AND the recommendation. The recommendation logic (setup-recommendation.ts lines 84-91) triggers `use-host-providers` when hostProviders.length > 0, but this checks only local provider detection (ollama/lmstudio/model-runner), not whether host OpenCode has connected providers. Line 74 filters to `p.available` but doesn't suppress in-stack Ollama when a superior host provider could be used.
- **Recommendation:** In the recommendation logic, check detectHostOpenCode().credentialCount in addition to hostProviders length. If credentialCount > 0 (host OpenCode has credentials), emit `use-host-providers` with the highest priority, before checking for local provider endpoints. This ensures the wizard prefers imported host credentials over auto-detected local LLMs.
- **Verified:** The finding is CONFIRMED. The recommend endpoint at /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/api/setup/recommend/+server.ts does NOT check for host OpenCode credentials before making its recommendation. 

Evidence from the code:

1. Lines 20-29 of recommend/+server.ts define authJsonConnected() which reads ONLY from the stack's OP_HOME: `const path = authJsonPath(getState());` - this returns the stack's knowledge/secrets/auth.json, not the host's ~/.local/share/opencode/auth.json.

2. Lines 42-57 of recommend/+server.ts: detectCloudProviders() queries OpenCode's connected providers from the in-stack OpenCode instance or from the stack's OP_HOME auth.json - it does NOT call detectHostOpenCode() to check if a host OpenCode installation has superior credentials.

3. Line 76 in recommend/+server.ts passes cloudProviders and hostProviders to recommendSetup(), but cloudProviders only contains providers already in the stack's OP_HOME, not the host's credentials.

4. Lines 84-91 in setup-recommendation.ts: when hostProviders.length > 0 (detecting Ollama/LMStudio running), it recommends 'use-host-providers' WITHOUT checking if the host has superior cloud provider credentials that should take precedence.

The precedence gap: If a user has a host OpenCode installation with a Claude provider configured, and also has Ollama running locally, the recommendation will suggest 'use-host-providers' (for Ollama) instead of checking for the host's superior cloud provider that should take precedence per the architecture rule.

The fix (per the finding) is correct: detectCloudProviders() should call detectHostOpenCode() and include those provider IDs in the cloudProviders list before the recommendation is made. This is available since detectHostOpenCode is exported from @openpalm/lib (line 371 of packages/lib/src/index.ts) but is not imported or called in recommend/+server.ts.


### 4. [host-import] Host-import silent failure: importedProviderIds defaults to empty if auth.json cannot be read post-import _(corroborated by 2 independent angles)_

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/api/setup/import-host/+server.ts:113-123`
- **Problem:** When import-host succeeds in copying files but the subsequent read of the imported auth.json fails, the endpoint returns ok=true with an empty importedProviderIds array, silently masking credentials that ARE on disk. The UI marks no providers verified, and the user is left with an unusable setup.
- **Evidence:** Lines 113-123: `const importedAuthPath = authJsonPath(state); const authPathToUse = existsSync(importedAuthPath) ? importedAuthPath : hostStatus.authPath ?? null; const importedProviderIds = authPathToUse ? providerIdsFromAuth(authPathToUse) : [];` — if providerIdsFromAuth catches an exception and returns [], callers see ok=true with no imported providers. The result.imported counts come from importHostOpenCode (filesystem copy), but importedProviderIds drives UI verification state.
- **Recommendation:** Extract provider IDs from result.imported.credentials during the copy phase instead of reading the file post-copy. Or verify readability of the written auth.json before returning success. Log warnings when import-host copy succeeds but verification read fails.
- **Verified:** The finding is confirmed by examining the actual code flow:

1. **`importHostOpenCode()` (host-opencode.ts lines 170-258)** successfully copies/merges auth.json credentials to disk but returns ONLY numeric counts in `HostImportResult`: `{ imported: { providers: number; credentials: number }; conflicts: string[] }` (lines 40-47). The actual provider IDs from the imported credentials are NOT returned.

2. **The import-host endpoint (lines 113-123)** attempts to re-read the file to extract provider IDs:
   ```typescript
   const importedAuthPath = authJsonPath(state);
   const authPathToUse = existsSync(importedAuthPath)
     ? importedAuthPath
     : hostStatus.authPath ?? null;
   const importedProviderIds = authPathToUse ? providerIdsFromAuth(authPathToUse) : [];
   ```

3. **`providerIdsFromAuth()` (lines 84-95) silently returns `[]` on ANY error**:
   ```typescript
   function providerIdsFromAuth(authPath: string): string[] {
     try {
       const raw = JSON.parse(readFileSync(authPath, 'utf-8')) as unknown;
       if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
         return Object.keys(raw as Record<string, unknown>);
       }
     } catch {
       // ignore — caller falls back to an empty list
     }
     return [];
   }
   ```
   If readFileSync or JSON.parse fails (file permissions, corruption, encoding), the function silently returns `[]`.

4. **The endpoint returns success regardless (lines 138-148)**:
   ```typescript
   return json({
     ok: true,
     imported: result.imported,
     importedProviders: importedProviderIds,  // potentially empty even if credentials are on disk
     ...
   });
   ```

5. **The UI marks zero providers verified when `importedProviders` is empty** (lines 1433-1434 in +page.svelte):
   ```typescript
   const importedIds = data.importedProviders ?? data.pushedProviders ?? [];
   for (const id of importedIds) markProviderVerifiedFromImport(id);
   ```

The root cause is that during the auth.json merge/copy phase in `importHostOpenCode()` (lines 224-252), the function has direct access to the credential object keys (line 234: `for (const [id, value] of Object.entries(hostAuth))`) but only counts them. It could collect and return the actual provider IDs instead of forcing the endpoint to re-read an already-written file, eliminating the silent failure scenario.


### 5. [host-import] Host import and OpenCode reload do not coordinate on model list population; race condition on model preference resolution

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte:1428-1456`
- **Problem:** handleHostImport marks providers verified immediately, then reloads OpenCode providers (line 1439), then calls applyImportedModelPreferences (line 1445). But loadOpenCodeProviders also calls applyImportedOpenCodeModelSelections (line 911), which may race. If the reload is slow or fails, applyImportedModelPreferences runs while st.models is still empty, and the preferences silently fail to resolve.
- **Evidence:** Lines 1439-1445: The reload is in a try/catch that doesn't block; if it fails, the code continues to applyImportedModelPreferences with the old (empty) models. Lines 1447-1451 then attempt to verifyProvider on unverified local providers (non-blocking), which also race the preference application.
- **Recommendation:** Make the OpenCode reload blocking and required; only apply model preferences after models are confirmed populated. Or add an explicit await on model population (fetch /api/setup/models) before calling applyImportedModelPreferences.
- **Verified:** The race condition is plainly present in the code:

1. Line 1434: `for (const id of importedIds) markProviderVerifiedFromImport(id);` marks providers as verified immediately.

2. Line 1439: `try { await loadOpenCodeProviders(); } catch { /* keep import-marked verified state */ }` loads providers but silently swallows any errors without blocking.

3. Line 1445: `applyImportedModelPreferences();` is called immediately after without waiting for models to be populated.

4. Inside applyImportedModelPreferences (lines 827-837), it calls resolvePreferredModelSelection which at line 793 calls getModelOptionsForRole.

5. getModelOptionsForRole (line 753) iterates over verifiedProviders (line 755) and uses `st.models` (line 758), which is populated by loadOpenCodeProviders at line 902.

6. If loadOpenCodeProviders() fails silently at line 1439, or if its fetch is still in-flight when applyImportedModelPreferences runs at line 1445, st.models will be empty.

7. With empty st.models, getModelOptionsForRole returns an empty array (lines 754-786), causing resolvePreferredModelSelection to return undefined at line 794, silently failing to resolve the model preferences.

Additionally, lines 1448-1451 spawn non-blocking verifyProvider() calls via `void verifyProvider(id)` which may race the preference application.

The code comment at lines 1442-1444 acknowledges this race ("Called here explicitly to handle cases where the reactive chain inside loadOpenCodeProviders didn't find the models yet") but the implementation doesn't actually block on model population before applying preferences.


### 6. [model-defaults] Guardian dependency not in core.compose.yml—defined only in channels.compose.yml with profile gates

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `.openpalm/config/stack/channels.compose.yml:188`
- **Problem:** Guardian is defined in channels.compose.yml with profiles=['addon.chat', 'addon.api', 'addon.discord', 'addon.slack']. If zero channels are enabled and guardian is still deployed (via CORE_SERVICES), the guardian service definition never gets loaded because no profile that gates it is active. This creates a service name mismatch: buildManagedServices returns 'guardian' but compose config doesn't define it.
- **Evidence:** Guardian definition at line 188: `guardian: { profiles: ['addon.chat', 'addon.api', 'addon.discord', 'addon.slack'] }`. Core.compose.yml has no guardian service definition. When no channel addon is enabled, none of those profiles activate.
- **Recommendation:** Either (1) move guardian to core.compose.yml with no profile gate (if you want it always available), or (2) make guardian truly optional by excluding it from CORE_SERVICES when no channels are enabled (preferred, per finding #1). The current mismatch between 'guardian always in CORE_SERVICES' and 'guardian only in profile-gated compose' is the root cause.
- **Verified:** Guardian is unconditionally in CORE_SERVICES (packages/lib/src/control-plane/types.ts:46-49), which means buildManagedServices always returns "guardian" in the service list (packages/lib/src/control-plane/lifecycle.ts:380: `new Set<string>(CORE_SERVICES)`). However, the guardian service definition exists ONLY in channels.compose.yml:139-140 with `profiles: ["addon.chat", "addon.api", "addon.discord", "addon.slack"]`. When zero channels are enabled, none of these profiles activate, so the guardian service definition is never loaded into the merged compose config. When composeUp tries to start the "guardian" service that buildManagedServices returned, Docker Compose fails because guardian service doesn't exist in the active configuration. The core.compose.yml has no guardian definition—verified by grep. This creates exactly the mismatch described: buildManagedServices returns 'guardian' but compose config doesn't define it when no channel profiles are active.


### 7. [model-defaults] Unused OLLAMA_DEFAULT_MODELS constant breaks model defaults

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/provider-constants.ts (line 94-98) and packages/ui/src/routes/setup/+page.svelte (line 493)`
- **Problem:** When enabling in-stack Ollama, the wizard hardcodes only 'qwen3:4b' as the seeded model, ignoring the OLLAMA_DEFAULT_MODELS constant which defines chat:'llama3.2:latest' and embedding:'nomic-embed-text'. This hardcoding fails to auto-select an embedding model (qwen3:4b is not an embedding model), contradicting the architecture rule that embedding should be 'derived, never required' and breaking the expected defaults chain.
- **Evidence:** enableRecommendedOllama() line 493: `if (st.models.length === 0) st.models = ['qwen3:4b'];` but OLLAMA_DEFAULT_MODELS (provider-constants.ts line 95-98) defines `{ chat: 'llama3.2:latest', embedding: 'nomic-embed-text' }`. getModelOptionsForRole() line 760 expects defaultModel to exist in st.models for isDefault=true to trigger, but qwen3:4b is not an embedding model so embedding options are empty.
- **Recommendation:** Use OLLAMA_DEFAULT_MODELS instead of hardcoding: if (st.models.length === 0) st.models = [OLLAMA_DEFAULT_MODELS.chat]; Seed only the chat model to respect akm self-embedding rule. Remove the embedding seed altogether since akm handles it locally.
- **Verified:** The finding is confirmed with code evidence:

1. OLLAMA_DEFAULT_MODELS constant exists at /home/founder3/code/github/itlackey/openpalm/packages/lib/src/provider-constants.ts lines 95-98: `export const OLLAMA_DEFAULT_MODELS = { chat: "llama3.2:latest", embedding: "nomic-embed-text" }`

2. Hardcoded 'qwen3:4b' appears at /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte line 493: `if (st.models.length === 0) st.models = ['qwen3:4b'];`

3. The constant is NEVER imported anywhere in the codebase (verified via grep) and is not exported from packages/lib/src/index.ts

4. The hardcoding contradicts the Ollama provider config which specifies llmModel:'llama3.2' (from wizard/constants.ts line 11)

5. The embedding model impact is confirmed: in getModelOptionsForRole (lines 753-786), when st.models = ['qwen3:4b'], the defaultModel 'nomic-embed-text' is not included in st.models, so users cannot select the configured default embedding model 'nomic-embed-text' if they want to override akm's local embedding

This is a real logic gap: a constant was defined to encode proper Ollama defaults but remains unused, while code hardcodes a different model. While the comment correctly notes embedding shouldn't be seeded by default (akm self-embeds), the chat model choice mismatches the architecture.


### 8. [model-defaults] Imported OpenCode provider does not override in-stack Ollama for chat model selection unless explicitly verified before Ollama is verified _(corroborated by 3 independent angles)_

- **Type:** logic-gap · **Verdict:** PLAUSIBLE
- **File:** `packages/ui/src/routes/setup/+page.svelte:738-786`
- **Problem:** autoSelectModels picks the first provider in verifiedProviders that has models. When both an imported OpenCode provider (e.g., OpenAI) and in-stack Ollama are verified, whichever is verified first in the array iteration wins as the default. In-stack Ollama auto-enable (enableRecommendedOllama) sets it verified before the host provider import completes, so Ollama's 'qwen3:4b' may be selected for chat even though the user has a better model configured on the host OpenCode.
- **Evidence:** Lines 493 in enableRecommendedOllama: `st.models = ['qwen3:4b'];` — this happens when recommendation action is 'enable-ollama', before host import. Lines 738-751 in autoSelectModels: the first provider with a defaultOpt (isDefault=true) OR the first provider in options wins. If ollama's qwen3:4b is marked isDefault=true (line 761-766), it is always selected even if imported openai/gpt-4o is verified.
- **Recommendation:** Deprioritize Ollama in model selection unless it is explicitly verified by the user (not auto-enabled). Or ensure imported host providers are verified and their model lists populated BEFORE auto-enabling Ollama. Or add a precedence rule: 'imported host providers override in-stack Ollama for chat models.'
- **Verified:** The finding's claimed mechanism (first provider in iteration wins) is INCORRECT. Line 748 of /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte shows: `const defaultOpt = options.find((o) => o.isDefault) ?? options[0];` — it selects the FIRST option with isDefault=true, not the first provider. However, a PLAUSIBLE root cause exists: Lines 1438-1440 show a race condition where if `opencodeAvailable` is still false when `handleHostImport()` runs (due to async `checkOpenCodeAndInit()` not being awaited at line 1467), then `loadOpenCodeProviders()` is skipped and the imported provider is marked verified with empty models=[]. In `getModelOptionsForRole()` (lines 755-772), if st.models is empty, the provider contributes no options, so Ollama (with models=['qwen3:4b'] from line 493) becomes the only provider with options and gets selected. This is a legitimate precedence bug, but the stated mechanism is wrong.
- **Verifier correction:** The actual issue is a race condition where imported OpenCode providers can be marked verified without their models being populated if `opencodeAvailable` is still false during `handleHostImport()`. When models aren't populated, that provider contributes zero options to getModelOptionsForRole(), allowing Ollama (which auto-seeds with models=['qwen3:4b']) to become the default selection. The fix would be to always attempt `await loadOpenCodeProviders()` in handleHostImport(), not conditional on `opencodeAvailable`, or to ensure OpenCode is checked before attempting host import.


### 9. [state-flow] enableVoice state can drift from voiceTts/Stt engines between steps

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 216-238 (displayedVoice) vs 1729, 1734 (sync on Voice step)`
- **Problem:** enableVoice is a separate state variable that is kept in sync with voiceTts/Stt engines ONLY via event handlers on the Voice step (lines 1729, 1734). But displayedVoiceTts/Stt (used in Review/payload) derive from enableVoice. If voiceTts/Stt are modified outside the Voice step event handlers (e.g. via rerun deserialization at line 1508-1522), enableVoice becomes stale. Review step could show incorrect engines or payload could persist stale voice config.
- **Evidence:** Line 1729: `enableVoice = (voiceTts.engine === 'openpalm-voice' || voiceStt.engine === 'openpalm-voice')` (only on Voice step change); Rerun loads voiceTts at line 1508 without syncing enableVoice; Payload at line 291 checks persistedVoiceTts which derives from enableVoice (line 228-231).
- **Recommendation:** Make enableVoice a derived state: `const enableVoice = $derived(voiceTts.engine === 'openpalm-voice' || voiceStt.engine === 'openpalm-voice')`. Remove manual sync assignments at lines 1729 and 1734. This is simpler, self-updating, and immune to deserialization drift.
- **Verified:** The finding is confirmed by examining the actual code flow:

1. INITIALIZATION (line 47): `let enableVoice = $state(false);`

2. DESERIALIZATION WITHOUT SYNC (lines 1505-1522): When rerun config is loaded, voiceTts and voiceStt are restored from stored config:
   ```
   if (storedTts.engine) {
     voiceTts = { ...storedTts, engine: storedTts.engine }; // line 1508
   }
   if (storedStt.engine) {
     voiceStt = { ...storedStt, engine: storedStt.engine }; // line 1517
   }
   ```
   BUT enableVoice is NEVER synced here.

3. MANUAL SYNC ONLY IN VOICE STEP (lines 1729, 1734): Sync only occurs in response to VoiceStep UI events:
   ```
   enableVoice = (voiceTts.engine === 'openpalm-voice' || voiceStt.engine === 'openpalm-voice');
   ```

4. DERIVED STATE DEPENDENCY (lines 228-231, 234-237): The persistedVoice states depend on enableVoice:
   ```
   const persistedVoiceTts = $derived.by(() => {
     if (voiceTts.engine) return voiceTts;
     if (enableVoice) return { engine: 'openpalm-voice' }; // line 230
     return { engine: '' };
   });
   ```

5. PAYLOAD IMPACT (line 291): The addon decision uses persistedVoiceTts:
   ```
   if (persistedVoiceTts.engine === 'openpalm-voice' || persistedVoiceStt.engine === 'openpalm-voice') {
     addons.voice = true;
   }
   ```

DRIFT SCENARIO: On rerun, lines 1508/1517 set voiceTts/voiceStt to 'openpalm-voice' but enableVoice remains false. Then persistedVoiceTts checks enableVoice (line 230) which is false, causing it to return { engine: '' } even though the actual voiceTts.engine is 'openpalm-voice'. This causes the voice addon to NOT be enabled in the payload despite the stored config requiring it.

The recommendation to use `const enableVoice = $derived(...)` is correct and would eliminate this drift vector entirely.


---

## MEDIUM severity


### 10. [deploy-stack] Pre-deploy compose down does not guarantee orphan container cleanup between addon profile changes

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/lib/server/setup-deploy.ts:362-364`
- **Problem:** The pre-deploy `composeDown()` at line 364 runs with the *new* profile set from buildComposeOptions(state), meaning it only removes containers whose services are in the current active profiles. If a user previously enabled ollama (addon.ollama.cpu profile) and now disables it, the pre-deploy down only runs against profiles that do NOT include ollama, so orphaned ollama containers are not explicitly removed—they rely on the later composeUp's `--remove-orphans` flag.
- **Evidence:** Line 362: `const composeOpts = buildComposeOptions(state);` — uses the *new* stack.env which has OP_ENABLED_ADDONS updated to exclude ollama. Line 364: `composeDown({ ...composeOpts, removeVolumes: false })` uses those same options. The down command only knows about active profiles, not the old ones.
- **Recommendation:** Change the pre-deploy down to NOT filter by profiles (or pass ALL possible profiles/services), so it stops all containers regardless of profile state. Alternatively, after applyInstall writes the new stack.env, read the *old* OP_ENABLED_ADDONS from a backup and build profiles including both old+new, then down against that merged set. The current approach works only because removeOrphans in composeUp later catches the strays, but it is indirect and fragile.
- **Verified:** Code flow confirmed: (1) performSetup() in /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/api/setup/complete/+server.ts:38 modifies stack.env (via setAddonEnabled → setEnabledAddonState → patchSecretsEnvFile in registry.ts:855); (2) startDeploy() is then called at line 83, which at setup-deploy.ts:338 calls applyInstall(state); (3) at setup-deploy.ts:362, buildComposeOptions(state) is called, which in turn calls resolveActiveProfiles(state) from compose-args.ts:70; (4) resolveActiveProfiles() in compose-args.ts:31-58 reads the CURRENT OP_ENABLED_ADDONS from the ALREADY-MODIFIED stack.env (line 47 parses it); (5) at setup-deploy.ts:364, composeDown() is invoked with these CURRENT (new) profiles only. Therefore, if a user disables an addon (e.g., ollama) in the wizard, the pre-deploy compose down runs against profiles that exclude addon.ollama.cpu, so ollama containers are NOT explicitly stopped—they rely on the later composeUp's --remove-orphans flag (line 450) to clean them. This is indirect and fragile, especially if that composeUp fails or if the deployment process terminates early.


### 11. [deploy-stack] removeOrphans flag only effective when service exists in compose definition but is excluded by profile

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/lib/server/setup-deploy.ts:450`
- **Problem:** `--remove-orphans` in docker compose removes containers whose services are NOT in the final composed config. However, if a profile is fully inactive (e.g., addon.ollama.cpu is not in active profiles), Docker Compose's profile resolution may not even load the service definition, so removeOrphans never learns that ollama existed as a candidate to clean. The flag only works if the service definition is present in the loaded compose files but gated by an inactive profile that compose still knows about.
- **Evidence:** Docker Compose --remove-orphans semantic: stops containers not referenced in the resolved service list. If addon.ollama is disabled, the compose resolution with the new profiles doesn't know about ollama services, so removeOrphans has nothing to compare against. This is why lingering ollama containers can survive: composeUp's removeOrphans doesn't see them as orphans because compose never learned they should exist.
- **Recommendation:** Either (1) ensure all service definitions (including optional ones) are always loaded in compose, with only the *instances* controlled by profiles (change compose structure), or (2) explicitly track and stop disabled addons before composeUp (pre-down but with historical profile set), or (3) add a post-deploy cleanup step that queries docker ps for containers with labels matching disabled profiles and removes them explicitly. The current implicit cleanup via removeOrphans is insufficient.
- **Verified:** The finding is confirmed by code inspection and Docker Compose behavior verification:

1. DOCKER COMPOSE BEHAVIOR (verified empirically):
   - When a service is gated by a profile that is NOT activated (e.g., `profiles: ["addon.ollama.cpu"]` with no active profiles), Docker Compose does NOT load the service definition into the resolved config.
   - Testing: `docker compose -f services.compose.yml config --services` (without `--profile addon.ollama.cpu`) returns EMPTY output; with the profile returns `ollama`.

2. --remove-orphans LIMITATION (Docker docs): "Remove containers for services not defined in the Compose file"
   - The flag only removes containers whose SERVICE DEFINITIONS are absent from the RESOLVED config.
   - If a service definition is never loaded (profile-gated but inactive), Docker Compose never learns it should exist, so the container is not recognized as an orphan.

3. CODE EVIDENCE - setup-deploy.ts:
   - Line 362: `const composeOpts = buildComposeOptions(state);`
   - Line 364: `const downResult = await composeDown({ ...composeOpts, removeVolumes: false });`
   - Line 450: `const result = await composeUp({ ...composeOpts, forceRecreate: true, removeOrphans: true });`
   - Both calls use THE SAME composeOpts, which derive active profiles from the CURRENT state only.

4. PROFILE RESOLUTION (compose-args.ts lines 31-57):
   - `resolveActiveProfiles(state)` reads OP_ENABLED_ADDONS and active profile selections from stack.env.
   - If ollama is disabled (`OP_ENABLED_ADDONS` does not include 'ollama'), no `addon.ollama.*` profile is added.
   - Result: composeOpts.profiles excludes all ollama profiles.

5. SCENARIO WALKTHROUGH:
   - User enables Ollama during initial setup → `OP_ENABLED_ADDONS=ollama` → `resolveActiveProfiles()` returns `["addon.ollama.cpu"]` → Docker Compose loads `ollama` service → container created.
   - User disables Ollama and redeploys → `OP_ENABLED_ADDONS=""` → `resolveActiveProfiles()` returns `[]` → Docker Compose config resolves with no profiles → `ollama` service NEVER LOADED → `composeUp(..., removeOrphans: true)` has no service definition to compare against → container persists as "not an orphan".

The bug is real, conditional, and affects the upgrade/redeploy path when addons are disabled after initial setup.


### 12. [host-detection] Probe timeout too short for slow networks (3 seconds)

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/control-plane/model-runner.ts`
- **Problem:** Local provider detection uses a 3-second timeout (line 108: `signal: AbortSignal.timeout(3000)`), which may be too aggressive on slow networks or systems under load. A legitimate provider service on a slow link may be missed, causing the wizard to fall back to manual configuration or in-stack Ollama when a usable local provider is available.
- **Evidence:** Line 107-109: `const res = await fetch(probeUrl, { signal: AbortSignal.timeout(3000), });` hardcodes 3000ms. In comparison, model listing (provider-models.ts line 89, 119) uses 5000ms: `signal: AbortSignal.timeout(5000)` for the same Docker-internal network.
- **Recommendation:** Increase the timeout to 5 seconds to match the model-listing probe timeout, and document the assumption (that local services respond in under 5s on typical networks). Consider making the timeout configurable via an environment variable for users with slow/congested networks.
- **Verified:** The code plainly shows the timeout discrepancy:
- /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/model-runner.ts line 108: `signal: AbortSignal.timeout(3000)` in detectLocalProviders()
- /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/provider-models.ts line 89: `signal: AbortSignal.timeout(5000)` for Ollama probing
- /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/provider-models.ts line 119: `signal: AbortSignal.timeout(5000)` for generic OpenAI-compatible API probing

Both functions probe the same Docker-internal service endpoints (ollama:11434, host.docker.internal, localhost) for the same purpose (discovering available local providers). The detectLocalProviders() function uses a 3-second timeout while fetchProviderModels() uses 5 seconds for identical network operations on the same Docker network context, which could cause legitimate but slower services to be missed during initial detection.


### 13. [host-detection] Validation failure prevents validation result from flowing into model fetching

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/control-plane/model-runner.ts`
- **Problem:** The Ollama response validator (lines 28-36) returns false if the response body doesn't match the expected shape (missing or non-array .models), but when validation fails (line 111), the code continues the loop trying the next probe instead of returning detailed error info. A probe may reach the server successfully (res.ok = true) but have unexpected response format, and this validation gap is silently treated as 'endpoint not reachable' rather than surfacing the actual mismatch.
- **Evidence:** Lines 110-114: `if (validate && !(await validate(res))) { logger.debug(...); continue; }` — on validation failure, the loop continues to the next probe without logging the response body or specific validation error. Lines 28-36 in validateOllamaResponse: if body.models is not an array, false is returned. A user might have an Ollama service misconfigured (returning garbage or a different API shape) and never know because the detection silently moves to the next probe.
- **Recommendation:** When a validator returns false, log the actual response body (truncated to <500 chars) and the validation check that failed. This helps debugging when an Ollama instance is reachable but behaving unexpectedly. Optionally, track validation failures separately from network failures so the UI can distinguish between 'service not found' and 'service found but not recognized'.
- **Verified:** Lines 111-114 in /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/model-runner.ts show that when a probe reaches an endpoint (res.ok is true) but validation fails, the code logs only `{ provider, url: baseUrl }` via logger.debug() and continues to the next probe. The actual response body is never logged, making it impossible to debug why validation failed. For example, if validateOllamaResponse (lines 28-36) returns false because body.models is missing or not an array, a user's misconfigured Ollama instance will silently be treated as unavailable, indistinguishable from a truly unreachable endpoint. The test suite (model-runner.vitest.ts) has no test case for validation failure with a 200 response.
- **Verifier correction:** When a validator returns false (validation failure), log the actual response body (truncated to reasonable size, e.g., 500 chars) and the specific validation check that failed. This distinguishes between network unavailability and misconfiguration, improving debuggability for users with running but misconfigured local services.


### 14. [model-defaults] Model detection doesn't auto-select embedding model from detected Ollama _(corroborated by 2 independent angles)_

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte`
- **Problem:** When Ollama is detected or auto-enabled, the wizard does not automatically fetch and select an embedding model (e.g., nomic-embed-text) even though Ollama instances commonly expose embedding models. The wizard comments (line 741-744) explicitly skip auto-selecting embedding: 'akm self-embeds locally, so the wizard leaves modelSelection.embedding unset unless a user explicitly picks one'. This is correct for embedding configuration logic, but the comment and behavior don't reflect that Ollama-provided embedding models should be offered as an alternative if explicitly chosen.
- **Evidence:** Lines 753-786 in getModelOptionsForRole(): when roleId === 'embedding', the function returns only real embedding models (o.isDefault || o.dims > 0), never populating options from a detected Ollama's embedding models. Lines 741-744 confirm this is intentional: 'akm self-embeds locally, so the wizard never auto-configures an embedding model.' However, getModelOptionsForRole() does not verify that o.dims is populated from detected Ollama models, leaving the list potentially empty.
- **Recommendation:** Verify that detectLocalProviders() → providerState[ollama].models is populated with Ollama's actual models (via verifyProvider), and ensure those models carry the embDims metadata from KNOWN_EMB_DIMS lookup (see lines 764-765). The UI should then offer these embedding models as *optional* selections in the Models step, not auto-select them. The current logic is sound; the gap is ensuring the embedding model list is discoverable if the user wants to pick one explicitly.
- **Verified:** The finding is CONFIRMED. The code reveals the following sequence:

1. **In-stack Ollama seeding (line 493):** When `enableRecommendedOllama()` is called, it seeds `st.models = ['qwen3:4b']` - only a chat model.

2. **Missing verification flow (lines 962-966):** When Ollama is in `instack` mode, `verifyProvider('ollama')` short-circuits and returns early without fetching Ollama's actual available models from the `/api/tags` endpoint.

3. **Empty embedding options (lines 778-783):** `getModelOptionsForRole('embedding')` filters options with `return options.filter((o) => o.isDefault || o.dims > 0)`. For embedding to appear, a model must either be marked isDefault OR have dims > 0 in KNOWN_EMB_DIMS.

4. **Missing embedding model (lines 760-766):** The defaultModel `'nomic-embed-text'` is in PROVIDERS[ollama].embModel and in KNOWN_EMB_DIMS[768], BUT line 760 checks `models.includes(defaultModel)` - since st.models only contains `['qwen3:4b']`, this check fails and nomic-embed-text is never added to options as isDefault.

5. **Result:** The embedding role's model list becomes empty because:
   - nomic-embed-text is NOT in st.models (seeded with only qwen3:4b)
   - No other models in ['qwen3:4b'] qualify as embedding models (dims=0 lookup in KNOWN_EMB_DIMS)
   - The filter on line 783 removes all non-embedding options
   - User sees no embedding model options despite Ollama supporting them

The finding's claim is accurate: the wizard does not populate st.models with embedding models when Ollama is auto-enabled, leaving the embedding model options list potentially empty. The comment on lines 491-492 correctly states "akm self-embeds locally" but the actual gap is that st.models is not populated with known embedding models Ollama would expose.


### 15. [model-defaults] Embedding role displays inconsistently when auto-handled by akm _(corroborated by 2 independent angles)_

- **Type:** misalignment · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/steps/ModelsStep.svelte (lines 87-94, 169-173)`
- **Problem:** The embedding role rendering says 'Handled automatically — uses built-in local embeddings. No model needed.' when options are empty (isEmptyEmbedding). However, the parent +page.svelte autoSelectModels() skips embedding entirely (line 745: `if (roleId === 'embedding') continue;`), leaving modelSelection.embedding undefined. This is correct for akm self-embedding but the UI messaging is inconsistent with model-selection state — 'Automatic' is shown but no model is actually selected.
- **Evidence:** ModelsStep line 158 displays: `{isEmptyEmbedding && !sel?.model ? 'Automatic' : (sel?.model ?? '(none)')}`. getOptionsForRole (line 87-93) filters to embedding-only models: `return options.filter((o) => o.isDefault || o.dims > 0);` which returns empty when no embedding models are exposed. But +page.svelte's autoSelectModels (line 745) skips embedding entirely, so modelSelection.embedding stays undefined.
- **Recommendation:** Document the intentional behavior: when embedding options are empty, akm handles it locally and no model is persisted. The UI is correct; clarify the comment to say 'Automatic (akm self-embeds)' rather than generic 'Handled automatically'. Ensure payload build (payload derived, line 325) correctly omits embedding when unset.
- **Verified:** The code confirms the finding's core claim: when embedding options are empty (isEmptyEmbedding=true), ModelsStep displays 'Automatic' (line 158) and the explanatory note "Handled automatically — uses built-in local embeddings" (lines 169-173), while +page.svelte's autoSelectModels() intentionally skips embedding entirely (line 745: `if (roleId === 'embedding') continue;`), leaving modelSelection.embedding undefined. The payload builder (lines 324-326) correctly omits embedding when emb?.model is unset. This is intentional behavior per comments, but the UI label 'Automatic' on line 158 is less informative than the expanded note on line 171. The recommendation is valid: clarify the collapsed-state label from 'Automatic' to something like 'Automatic (akm self-embeds)' to match the intent documented in the expanded view and align with the architecture rule that akm self-embeds locally without requiring a configured model.
- **Verifier correction:** The UI messaging is intentionally sparse but could be clearer. Line 158's simple 'Automatic' label is correct behavior (embedding stays unset, payload omits it) but less informative than line 171's note. The finding's recommendation stands: use 'Automatic (akm self-embeds)' or similar on the collapsed header to make the local embedding handling explicit without requiring the user to expand the section.


### 16. [model-defaults] Small model fallback uses first LLM provider's entire model list without filtering

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/steps/ModelsStep.svelte (lines 96-107)`
- **Problem:** When a small-model-specific option does not exist, the fallback (lines 96-107) dumps ALL models from verifiedProviders[0] into the small role, then autoSelectModels picks the first one. This can select an embedding model, a large model, or any unsuitable candidate. No filtering for small/lightweight characteristics.
- **Evidence:** getOptionsForRole() lines 96-107: `if (role.id === 'small' && options.length === 0) { const llmProvider = verifiedProviders[0]; if (llmProvider) { for (const m of providerState[llmProvider.id].models) { options.push(...); } } }` — all models are added regardless of size/type. Then autoSelectModels (line 748) picks `options[0]` which may be an embedding model.
- **Recommendation:** Filter small-model candidates: exclude known embedding models (check KNOWN_EMB_DIMS) and prefer models with 'small', 'mini', 'lite' in their name or lower parameter counts. If no heuristic matches, only fall back to 'use chat model' (the default UI option at line 182) rather than blindly picking the first candidate.
- **Verified:** The finding is confirmed. ModelsStep.svelte lines 96-107 add ALL models from verifiedProviders[0] to the 'small' role options without any filtering, as claimed. The code iterates through `providerState[llmProvider.id].models` and blindly pushes each model with `isDefault: false`. These models come from the provider's API (line 99-105) and include all available models—chat, embedding, or otherwise. Additionally, getModelOptionsForRole in +page.svelte (lines 753-786) has a compounding issue: when the provider's p.llmModel is not in the actual models list, the function adds all remaining models with isDefault=false, causing autoSelectModels (line 748) to pick `options[0]` without any filtering. This could select an embedding model like 'nomic-embed-text' if it appears first alphabetically after the provider's API response is sorted. File evidence: /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/steps/ModelsStep.svelte:96-107 (confirmed fallback adds all models), and /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte:748 (autoSelectModels picks first option without 'small' filtering), and /home/founder3/code/github/itlackey/openpalm/packages/lib/src/control-plane/provider-models.ts:99-100 (Ollama models returned sorted alphabetically with no filtering).


### 17. [simplification] Duplicate voice profile selection logic (3 places) _(corroborated by 2 independent angles)_

- **Type:** simplification · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 412-425, 631-635, 1127-1132`
- **Problem:** Voice profile selection logic for GPU-aware CUDA/CPU fallback is duplicated across loadVoiceProfiles(), handleEnableVoiceChange(), and handleInstall(). This creates maintenance risk: a GPU upgrade path bug at line 422 could differ from the Enable Voice toggle at line 632.
- **Evidence:** Line 412-425 (loadVoiceProfiles): `const fallback = gpuDetected ? data.profiles.find((p) => p.id === addonProfileId('voice', 'cuda')...`; Line 631-635 (handleEnableVoiceChange): `const preferred = addonProfileId('voice', gpuDetected ? 'cuda' : 'cpu')...`; Line 1128: Same pattern in handleInstall fallback.
- **Recommendation:** Extract GPU-aware voice/Ollama profile selection into a helper function in wizard/helpers.ts: `selectProfileForGpu(profiles, addon, gpuDetected)`. Use it in all three places. This centralizes the logic and prevents divergence.
- **Verified:** The finding is confirmed. The code shows GPU-aware voice profile selection logic repeated across multiple locations with subtle differences:

1. `/home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte` lines 411-425 (`loadVoiceProfiles`): Multi-level fallback tries CUDA→default→any (if GPU) or CPU→default→any (if no GPU), then has a separate GPU-upgrade check at lines 422-424.

2. Lines 631-635 (`handleEnableVoiceChange`): Simpler pattern tries preferred (CUDA/CPU based on gpuDetected) then any available.

3. Lines 1127-1132 (`handleInstall`): Extended pattern tries preferred (CUDA/CPU), explicit CPU fallback, any available, defaults to CPU string.

4. Lines 1635-1637 (SystemCheckStep callback): GPU upgrade runtime logic.

The patterns have subtle fallback-chain differences (some include default profile check, some include explicit CPU fallback) which increases divergence risk.
- **Verifier correction:** Duplicate voice profile selection logic appears in 4 places (not 3): loadVoiceProfiles() lines 411-425, handleEnableVoiceChange() lines 631-635, handleInstall() lines 1127-1132, AND SystemCheckStep ongpudetected callback lines 1635-1637. Additionally, identical Ollama profile selection logic exists in loadOllamaProfiles() lines 443-454. The patterns have fallback-chain differences which increase maintenance risk.


### 18. [state-flow] buildManagedServices deliberately excludes guardian from addon service discovery but always includes it in CORE_SERVICES

- **Type:** misalignment · **Verdict:** CONFIRMED
- **File:** `packages/lib/src/control-plane/registry.ts:456 + lifecycle.ts:380`
- **Problem:** getAddonServiceNames() filters out guardian (`if (serviceName === 'guardian') return false;` at line 456) to avoid double-counting it when discovering channel addon services. However, buildManagedServices always adds guardian from CORE_SERVICES (line 380) unconditionally. This creates an asymmetry: guardian is force-deployed even when no channels exist, yet the addon discovery logic explicitly prevents it from being counted as a channel addon.
- **Evidence:** Line 456 in registry.ts: guardian is filtered out. Line 380 in lifecycle.ts: guardian is blindly added from CORE_SERVICES. Lines 372-395 in lifecycle.ts: addons are discovered via getAddonServiceNames, which never returns guardian, but CORE_SERVICES always has it.
- **Recommendation:** Treat guardian as a conditional service that should only be in the managed set when at least one channel is enabled. Remove it from CORE_SERVICES (which should only be 'assistant') and add conditional logic in buildManagedServices: `if (listEnabledAddonIds(state.homeDir).some(a => ['chat', 'api', 'discord', 'slack'].includes(a))) { services.add('guardian'); }`. This makes guardian's lifecycle consistent with the channels that depend on it.
- **Verified:** The code confirms the asymmetry:

1. **Guardian's profile gate in compose** (/.openpalm/config/stack/channels.compose.yml:140): guardian has `profiles: ["addon.chat", "addon.api", "addon.discord", "addon.slack"]`, meaning it should only be selected when those channel profiles are active.

2. **Guardian filtering in addon discovery** (/packages/lib/src/control-plane/registry.ts:456): The `readAddonServiceNamesFromContent` function explicitly excludes guardian (`if (serviceName === 'guardian') return false;`) to avoid double-counting it during addon service discovery.

3. **Guardian unconditionally in CORE_SERVICES** (/packages/lib/src/control-plane/types.ts:46-49): `CORE_SERVICES = ["assistant", "guardian"]` with no conditions.

4. **Unconditional inclusion in buildManagedServices** (/packages/lib/src/control-plane/lifecycle.ts:380): The services set is initialized with `const services = new Set<string>(CORE_SERVICES)` before any filtering. Guardian is pre-seeded and never removed, even when no channel profiles are active.

5. **Command-line override of profiles** (/packages/lib/src/control-plane/docker.ts:251): `composeUp` passes services as positional arguments (`args.push(...options.services)`), which causes Docker Compose to start those services **regardless of their profile gates**.

The result is that guardian is deployed in all installations, even when no channels (chat, api, discord, slack) are enabled, contradicting its conditional profile definition in the compose file.</parameter>
</invoke>


### 19. [state-flow] Ollama toggle sync only applies on entering Options step, misses rerun case

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 723-726 vs 1530`
- **Problem:** ollamaEnabled is synced from providerState.ollama.ollamaMode ONLY when goToStep(5) is called (line 725). On rerun (isRerun=true), ollamaEnabled is set at line 1530 from the loaded config, but if the user navigates backward then forward, step 5 entry will overwrite the restored ollamaEnabled with the stale ollamaMode state.
- **Evidence:** Line 725: `if (n === 5 && hasOllamaVerified) { ollamaEnabled = providerState.ollama?.ollamaMode === 'instack'; }` overwrites ollamaEnabled unconditionally; Line 1530: `if (enabled.includes('ollama')) ollamaEnabled = true;` sets it on rerun; If user goes back to step 4 then forward to step 5 again, the line 725 sync will clobber the restored value.
- **Recommendation:** Make ollamaEnabled a derived state only for the step-entry sync scenario: change line 723-726 to conditionally sync only if ollamaMode was detected, not restored. Or extract sync into a helper that preserves user edits. Better: use a computed state that reflects both the provider state AND user overrides via the toggle handler (handleOptionsOllamaChange).
- **Verified:** The code explicitly shows the bug:

**Line 1530** (rerun config restore):
```
if (enabled.includes('ollama')) ollamaEnabled = true;
```
Restores the Ollama toggle from the persisted config.

**Line 724-726** (step 5 entry sync):
```
if (n === 5 && hasOllamaVerified) {
  ollamaEnabled = providerState.ollama?.ollamaMode === 'instack';
}
```
Unconditionally overwrites `ollamaEnabled` every time step 5 is entered, based on `providerState.ollama?.ollamaMode`.

**THE BUG**: On rerun with in-stack Ollama previously configured:
1. Line 1530 restores: `ollamaEnabled = true`
2. `detectProviders()` (line 1576) detects a host Ollama running and sets: `providerState.ollama.ollamaMode = 'running'` (line 928)
3. When user navigates to step 5, line 725 evaluates: `ollamaEnabled = ('running' === 'instack')` → `ollamaEnabled = false`
4. Result: User's setting is silently overwritten.

OR in a simpler scenario: User toggles Ollama on step 5, navigates away, navigates back → line 725 re-executes and overwrites the toggle if `ollamaMode` doesn't match `'instack'`.

The sync at line 725 has no guard preventing it from clobbering intentional user edits or restored config values. It runs unconditionally every step entry, treating `ollamaMode` as the source of truth rather than preserving user state.


### 20. [state-flow] allowEmptyInstall reset may fire after provider verify, silently blocking install

- **Type:** logic-gap · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 202-206`
- **Problem:** $effect at lines 202-206 resets allowEmptyInstall when a provider verifies. Comment says it prevents 'stale allowEmptyInstall' from bypassing model selection. But the effect fires on EVERY hasVerifiedProvider change (a derived that re-evaluates whenever verifiedProviders updates). If a user checks 'allow empty install', then a background provider verification completes, allowEmptyInstall flips to false without user action. User may not notice and think the install is blocked.
- **Evidence:** Line 202-206: `$effect(() => { if (hasVerifiedProvider && allowEmptyInstall) { allowEmptyInstall = false; } })` fires whenever hasVerifiedProvider (line 194) changes; This clobbers user intent without UI feedback.
- **Recommendation:** Only reset allowEmptyInstall when the user EXPLICITLY enables a provider via UI action, not passively via background verification. Either: (1) reset in handleVerify/markProviderVerifiedFromImport after explicit user action, or (2) make the reset conditional: only reset if the user hasn't explicitly toggled the checkbox recently. Or simplest: remove the $effect and let validateStep2() gate on the canComplete predicate (which already checks hasVerifiedProvider).
- **Verified:** The effect at lines 202-206 in /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte is a real reactivity hazard. It resets allowEmptyInstall (line 204) whenever hasVerifiedProvider (line 194, a derived value) changes. This derived recomputes whenever verifiedProviders (lines 149-182, which watches providerState) changes. Background async operations like OAuth callbacks (line 1079: st.verified = true), host imports (line 1401: st.verified = true via markProviderVerifiedFromImport), and auto-Ollama enable (line 488: st.verified = true) all mutate providerState and trigger the effect. The user's checkbox flip (line 1690) sets allowEmptyInstall to true, but any subsequent background verification silently flips it back to false without any UI feedback (line 204 is the only reset path). The checkbox itself won't show as unchecked unless the user re-renders the ProvidersStep (line 635-636). This violates UI transparency: the checkbox state can change without the user knowing.


---

## LOW severity


### 21. [deploy-stack] Health polling timeout does not distinguish between unavoidable slow-start and true startup failure

- **Type:** simplification · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/lib/server/setup-deploy.ts:467`
- **Problem:** The 5-minute health poll timeout (line 467) is a blanket timeout applied to all services. On a slow disk or during the first-ever run of multi-GB voice CUDA images, legitimate cold-start delays are common. However, if a service fails to become healthy (e.g., guardian starting without any valid channels, or assistant unable to reach a provider), the timeout eventually fires and reports a generic 'did not become healthy' error without surfacing the actual service log or failure reason.
- **Evidence:** Line 467: `const healthError = await pollContainerHealth(composeOpts, services, 5 * 60_000);` — timeout is uniform. Lines 268-276 in setup-deploy.ts: on timeout, the error message just names unhealthy services, not why they failed. No log inspection or diagnostic fallback is performed.
- **Recommendation:** Extend the error message to include the last few lines of `docker compose logs <service>` for any unhealthy service, or add a post-timeout diagnostic step that queries container exit codes / logs before surfacing the error. This will help users distinguish 'still downloading models' from 'service crashed due to config error'.
- **Verified:** Line 467 shows uniform 5-minute timeout: `const healthError = await pollContainerHealth(composeOpts, services, 5 * 60_000);`. Lines 273-276 in pollContainerHealth return generic error mentioning only service names, not failure reason: `Services started but some did not become healthy in time: ${unhealthy.join(", ")}. Check logs: docker compose -p ${projectName} logs ${unhealthy.join(" ")}.` Lines 468-471 show no diagnostic fallback after timeout — error is set and function returns immediately without calling composeLogs (available but unimported in setup-deploy.ts) to fetch container logs automatically. Early-exit terminal error path (lines 259-264) has identical limitation.


### 22. [host-detection] Assistant does not declare explicit dependency on guardian; relies on network isolation for security

- **Type:** simplification · **Verdict:** CONFIRMED
- **File:** `.openpalm/config/stack/channels.compose.yml:188 + core.compose.yml`
- **Problem:** Guardian depends_on assistant (line 188-189 in channels.compose.yml), but assistant does not declare a dependency on guardian. This is by design (assistant is the core and doesn't need channels), but it creates a one-way coupling where removing guardian would be safe at the service level but would break any channel trying to reach it at runtime. The compose dependency graph is incomplete from a contract perspective.
- **Evidence:** Guardian: `depends_on: { assistant: { condition: service_healthy } }` (lines 188-189). Assistant has no depends_on guardian. All channels have `depends_on: { guardian: { condition: service_healthy } }` (lines 22, 51, 90, 124).
- **Recommendation:** Document this as intentional in code comments: 'Assistant is always deployed and does not depend on channels/guardian. Channels depend on guardian; guardian depends on assistant. Guardian may be safely disabled when no channels are enabled.' Add an integration test that deploys with zero channels enabled and verifies that (a) guardian does not start, or (b) guardian is correctly gated and not deployed at all (depending on the fix for finding #1).
- **Verified:** Code evidence confirms the finding:

1. **One-way coupling verified**: Guardian depends_on assistant (channels.compose.yml:188-189), all channels depend_on guardian (lines 22, 51, 90, 124), but assistant has zero depends_on declaration (core.compose.yml:27-99 contains no depends_on block).

2. **Profile gating is functional**: Guardian declared with `profiles: ["addon.chat", "addon.api", "addon.discord", "addon.slack"]` (channels.compose.yml:140) prevents instantiation when NO channels enabled.

3. **Runtime risk identified**: CORE_SERVICES=[assistant, guardian] hardcoded (types.ts:46-49), buildManagedServices() unconditionally includes guardian in service set (lifecycle.ts:380) without checking enabled channel profiles. This is safe in practice because Compose prevents instantiation, but creates a latent contract violation: TypeScript layer does not reflect the actual runtime dependency graph.


### 23. [simplification] Redundant displayedVoice vs persistedVoice derivations

- **Type:** simplification · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 216-238`
- **Problem:** displayedVoiceTts/Stt (lines 216-226) and persistedVoiceTts/Stt (lines 228-238) have identical logic: show engine if set, else show enableVoice engine, else show default. persistedVoice just returns empty engine string instead of default. This is confusing: it's unclear why two nearly-identical derivations exist and which should be used where.
- **Evidence:** displayedVoiceTts (216): `if (voiceTts.engine) return voiceTts; if (enableVoice) return { engine: 'openpalm-voice' }; return { engine: voiceDefaults.tts };` vs persistedVoiceTts (228): `if (voiceTts.engine) return voiceTts; if (enableVoice) return { engine: 'openpalm-voice' }; return { engine: '' };`. Used at line 1714 (Voice step display) and line 291/342/344 (payload build).
- **Recommendation:** Rename persistedVoice → voiceEnginePayload and clarify: persistedVoice should ONLY return an engine when it should be saved to config (explicit, or enableVoice=true for openpalm-voice). Remove the 'displayed' variants and use the engine directly in VoiceStep with fallbacks computed at render time. Simplify to a single source of truth per side.
- **Verified:** Both displayedVoiceTts (lines 216-220) and persistedVoiceTts (lines 228-232) in /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte have identical logic for the first two branches (check if voiceTts.engine is set, then check enableVoice), differing only in the fallback: displayedVoice returns voiceDefaults.tts/stt while persistedVoice returns empty string. displayedVoice is passed to VoiceStep for rendering (line 1714), while persistedVoice is used only for payload generation (lines 291, 342-345, 348, 1772-1773) where empty engines are filtered by voicePayload() at line 333 (if (!v.engine || v.engine.startsWith('skip-')) return undefined). The redundancy is real: the two derivations could be consolidated with a single source providing the engine, then applying different fallbacks only at the point of use (display vs persistence). The code comment at line 328-331 shows the distinction is intentional but the implementation creates confusing duplication.


### 24. [simplification] Recommendation fast-path and handleUseDefaults both validate LLM but have separate logic

- **Type:** maintainability · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/routes/setup/+page.svelte, lines 589-593 and 617-620`
- **Problem:** handleUseDefaults() validates the LLM gate in TWO places: fast path (lines 589-593) and slow path (lines 617-620). Both blocks are identical. If validation logic changes (e.g. add small model requirement), both must be updated.
- **Evidence:** Lines 590-593: `if (!modelSelection.llm?.model && !allowEmptyInstall) { goToStep(3); return; }` (fast path); Lines 617-620: identical block (slow path).
- **Recommendation:** Extract the LLM validation + routing into a helper: `function routeIfMissingLlm(): boolean { if (...) { goToStep(3); return true; } return false; }`. Call it once at the end of handleUseDefaults after both paths have applied imported preferences and auto-selected models. Reduces duplication and centralizes the gate logic.
- **Verified:** File /home/founder3/code/github/itlackey/openpalm/packages/ui/src/routes/setup/+page.svelte contains handleUseDefaults() with identical LLM validation in two separate paths:
- Fast path (lines 590–593): if (!modelSelection.llm?.model && !allowEmptyInstall) { goToStep(3); return; }
- Slow path (lines 617–620): if (!modelSelection.llm?.model && !allowEmptyInstall) { goToStep(3); return; }

Both blocks check the exact same condition and perform the exact same routing action. The slow-path comment (line 616) even acknowledges: "Same LLM gate as the fast path: never skip to Options with no chat model." This duplication creates a maintainability risk: any future change to LLM validation logic (e.g., adding small-model requirements) would require updating two separate locations.


### 25. [state-flow] Addon profile storage (OP_OLLAMA_PROFILE, OP_VOICE_PROFILE) happens in startDeploy phase 1b but is not atomic with applyInstall writes

- **Type:** maintainability · **Verdict:** CONFIRMED
- **File:** `packages/ui/src/lib/server/setup-deploy.ts:339-350`
- **Problem:** applyInstall() at line 338 writes the wizard's chosen config to stack.env. Then, at lines 339-350, if ollama is enabled but no profile is stored, the default profile is set via setAddonProfileSelection(). This is a separate write outside the applyInstall lock window, creating a potential race: if the deploy is interrupted between applyInstall and the profile write, the stack.env will have OP_ENABLED_ADDONS=ollama but no OP_OLLAMA_PROFILE, causing the later buildComposeOptions to default to the fallback profile at runtime (line 51 in compose-args.ts).
- **Evidence:** Line 338: `await applyInstall(state);` releases the lock. Lines 342-350: `setAddonProfileSelection()` is called outside the protected window. If process dies between these, stack.env has ollama enabled but profile unset, and subsequent redeploys will use the fallback profile instead of what the user chose.
- **Recommendation:** Move the addon profile defaulting logic inside applyInstall (or before it) so it runs within the install lock window. Alternatively, make buildManagedServices or buildComposeOptions resilient to missing profile selections by recording a default at the time OP_ENABLED_ADDONS is written, not retroactively in startDeploy.
- **Verified:** The code at /home/founder3/code/github/itlackey/openpalm/packages/ui/src/lib/server/setup-deploy.ts lines 338-350 shows applyInstall() at line 338 acquires and then releases a lock (via lifecycle.ts lines 125-134). Lines 343-350 call setAddonProfileSelection() OUTSIDE that lock window. setAddonProfileSelection (registry.ts:844-848) calls patchSecretsEnvFile which performs an unprotected read-modify-write of stack.env. If the process terminates between line 338 (lock release) and line 345 (profile write completion), stack.env will have OP_ENABLED_ADDONS=ollama but no OP_OLLAMA_PROFILE set. Subsequent calls to resolveActiveProfiles (compose-args.ts:31-58, specifically line 51) will then default to 'addon.ollama.cpu' via the fallback `|| 'addon.ollama.cpu'` operator, rather than the profile that would have been written. This violates atomicity of the addon-enable + profile-default operation and creates a window where interrupted deploys leave inconsistent state.
