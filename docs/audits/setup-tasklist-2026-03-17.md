# Setup & Install — Consolidated Task List

**Date:** 2026-03-17
**Sources:** `setup-wizard-audit-2026-03-17.md`, `setup-audit-2026-03-17.md`

---

## CRITICAL

- [x] **Add `MEMORY_AUTH_TOKEN` to CLI `ensureSecrets()` or `buildSecretsFromSetup()`** — memory service runs unauthenticated after fresh CLI install (`cli/src/lib/env.ts:64-92`, `lib/control-plane/secrets.ts:55-88`)
- [x] **Add retry logic to `fetchAsset()`** — single fetch attempt with no retry; transient GitHub errors abort install (`cli/src/lib/docker.ts:33-48`)

## HIGH

- [x] **Allow re-running setup after Docker failure** — `state.setupComplete` short-circuits retry/back; user is stuck after successful setup but failed deploy (`cli/src/setup-wizard/server.ts:204`, `wizard.js:1087-1098`)
- [x] **Fix deploy polling to wait for actual container status** — polling sees `setupComplete: true` + empty `deployStatus[]` and shows "done" before containers start (`cli/src/setup-wizard/wizard.js:796-849`)
- [x] **Preserve `OPENPALM_SETUP_COMPLETE` in `stageStackEnv`** — derives from `state.adminToken` presence, not actual setup completion; any `persistArtifacts()` call can prematurely mark setup complete (`lib/control-plane/staging.ts:171-172`)
- [x] **Add retry to CLI binary download** — single `curl -fsSL` with no `--retry` in bootstrap script (`scripts/setup.sh:80`)
- [x] **Fix inconsistent asset error handling** — schema downloads throw and abort install; should be non-fatal like other optional assets (`cli/src/commands/install.ts:112-146`)
- [x] **Detect port 8100 collision** — hardcoded port with no fallback or clear error on bind failure (`cli/src/commands/install.ts:18,200`)
- [x] **Don't silently swallow `docker compose pull` failure on first install** — no cached images means `up` fails with unhelpful error (`cli/src/commands/install.ts:228-230`)
- [x] **Switch assistant health check from TCP to HTTP** — TCP probe passes before app is ready; downstream services start too early (`assets/docker-compose.yml:107`)
- [x] **Extract shared Ollama URL resolution** — duplicated between `buildSecretsFromSetup()` and `performSetup()`; divergence risk (`lib/control-plane/setup.ts:249-254,350-355`)
- [x] **Replace non-null assertions with explicit checks in `performSetup()`** — `.find()!` produces cryptic TypeError instead of clean error (`lib/control-plane/setup.ts:387,392,395`)

## MEDIUM

- [x] **Fix `replaceWithTextInput` to be reversible** — model `<select>` permanently replaced with `<input>` after zero-model connection; never switches back (`cli/src/setup-wizard/wizard.js:592-604`)
- [x] **Add `deepseek`/`together`/`xai` to `PROVIDER_KEY_MAP`** — fallback stores all three under `OPENAI_API_KEY`; multi-provider key collision (`lib/src/provider-constants.ts:28-34`)
- [x] **Fix `docker.ts` private `parseEnvFile()` to strip `export` prefix** — env override keys include literal `export `, defeating the precedence fix (`lib/control-plane/docker.ts:25-41`)
- [x] **Fix `isSetupComplete()` fallback to check `OPENPALM_ADMIN_TOKEN`** — checks `ADMIN_TOKEN` which CLI comments out; returns false after valid CLI setup (`lib/control-plane/setup-status.ts:23-31`)
- [x] **Strip existing `/v1` suffix in `mem0BaseUrlConfig` before appending** — user input `…/v1` becomes `…/v1/v1`; memory requests fail (`lib/src/provider-constants.ts:80-89`)
- [x] **Add retry to PowerShell install script** — `Invoke-WebRequest` has no retry (`scripts/setup.ps1:67`)
- [x] **Add `start_period` to memory service healthcheck** — health checks begin immediately; premature unhealthy marking (`assets/docker-compose.yml:58-60`)
- [x] **Improve Docker socket detection** — hardcoded path misses OrbStack, Colima, Rancher Desktop, Podman (`cli/src/lib/paths.ts:21`)
- [x] **Fix vector store provider mismatch** — `buildMem0Mapping()` hardcodes qdrant; `getDefaultConfig()` uses sqlite-vec; re-setup silently switches provider (`lib/control-plane/connection-mapping.ts:146`, `memory-config.ts:209`)

## LOW

- [x] **Guard `ensureStackEnv` against missing artifacts directory** — crashes if called independently outside install flow (`cli/src/lib/env.ts:162`)
- [x] **Print wizard URL to terminal** — `xdg-open` may not exist on headless/WSL; user gets no fallback (`cli/src/lib/docker.ts:103`)
- [x] **Add `$` escaping to `quoteEnvValue()`** — dollar signs in API keys get expanded when env file is sourced by bash (`lib/control-plane/env.ts:24`)
- [x] **Fix guardian healthcheck to verify response status** — 500 response passes the check (`assets/docker-compose.yml:144`)
- [x] **Use GitHub redirect for version lookup** — unauthenticated API limited to 60/hr; redirect from `/releases/latest` avoids rate limit (`scripts/setup.sh:69`)
- [x] **Monitor socat proxy process** — crash silently breaks LM Studio requests (`core/assistant/entrypoint.sh:157`)
- [x] **Fix step dot navigation validation** — users can click back to later steps with invalid state (`cli/src/setup-wizard/wizard.js:1015-1022`)
- [x] **Transfer draft model cache on connection save** — `_draft` cache discarded; forces redundant API call (`cli/src/setup-wizard/wizard.js:446-447`)

## TEST GAPS

- [x] **Replace inline staging test reimplementation with real imports** — `staging.test.ts` tests a copy of the code, not production code
- [x] **Add server-side E2E wizard tests** — current E2E mocks away all server behavior; only tests HTML/JS
- [x] **Add wizard error scenario tests** — no coverage for server 500, validation 400, network timeout, empty model lists
- [x] **Add special character tests for admin token** — no coverage for `=`, quotes, newlines in token values
- [x] **Add stack spec creation test** — `performSetup()` writes `openpalm.yaml` but no test verifies it
