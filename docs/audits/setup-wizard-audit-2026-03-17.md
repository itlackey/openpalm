# Setup Flow Bug Report — Full Audit

**Date:** 2026-03-17
**Scope:** CLI `openpalm install` → setup wizard → staging pipeline → Docker deployment
**Split:** Admin-specific items moved to `admin-audit-2026-03-17.md`

---

## CRITICAL (1)

### C1. Missing `MEMORY_AUTH_TOKEN` on fresh CLI install — memory service runs unauthenticated
**Files:** `packages/cli/src/lib/env.ts:64-92` (CLI ensureSecrets), `packages/lib/src/control-plane/secrets.ts:55-88` (lib ensureSecrets)
CLI's `ensureSecrets()` runs first (install.ts:148) and creates `secrets.env` without `MEMORY_AUTH_TOKEN`. Lib's `ensureSecrets()` then sees the file exists and returns early (line 58-60). `performSetup()` never adds `MEMORY_AUTH_TOKEN` to its updates. Result: memory service has no auth token.

---

## HIGH (3)

### H1. Deploy retry/back does not re-run `performSetup()` after first success
**File:** `packages/cli/src/setup-wizard/wizard.js:1087-1098`, `server.ts:204`
After a successful `performSetup()` but failed Docker deployment, the server's handler checks `state.setupComplete` and returns immediately. Neither "Retry" nor "Back to Review" will re-run `performSetup()`. The user is stuck with a completed-but-undeployed state.

### H2. Deploy "done" screen appears before containers actually start
**File:** `packages/cli/src/setup-wizard/wizard.js:796-849`
After POST succeeds, deploy polling sees `setupComplete: true` + `deployError: null` + empty `deployStatus[]` and immediately shows the "done" screen before Docker operations begin.

### H3. `stageStackEnv` sets `OPENPALM_SETUP_COMPLETE` from `state.adminToken` presence, not actual setup completion
**File:** `packages/lib/src/control-plane/staging.ts:171-172`
Any call to `persistArtifacts()` (including `applyUpdate()`, `applyUpgrade()`) will set `OPENPALM_SETUP_COMPLETE=true` if the in-memory state has an admin token, regardless of whether `performSetup()` was actually called. A partially-configured system can be prematurely marked as setup-complete.

---

## MEDIUM (6)

### M1. Anthropic API key incorrectly marked optional in CLI wizard
**File:** `packages/cli/src/setup-wizard/wizard.js:381-384`
`if (draftKind === "cloud" && !apiKey && draftProvider !== "anthropic")` — skips API key validation for Anthropic. Users can save a broken Anthropic connection.

### M2. `replaceWithTextInput` permanently breaks model selector
**File:** `packages/cli/src/setup-wizard/wizard.js:592-604`
When a connection returns zero models, `<select>` is replaced with `<input>`. Switching connections never converts it back. Model selection is permanently broken for that slot.

### M3. `deepseek`/`together`/`xai` missing from `PROVIDER_KEY_MAP` — API keys collide under `OPENAI_API_KEY`
**File:** `packages/lib/src/provider-constants.ts:28-34`
Fallback stores all three providers' keys as `OPENAI_API_KEY`. Multi-provider setups have key collisions.

### M4. `docker.ts` private `parseEnvFile()` doesn't handle `export` prefix
**File:** `packages/lib/src/control-plane/docker.ts:25-41`
Env override mechanism produces keys like `export OPENAI_API_KEY` instead of `OPENAI_API_KEY`. The overrides accomplish nothing; `--env-file` works as fallback, but the precedence fix is defeated.

### M5. `isSetupComplete()` fallback checks wrong key — breaks setup detection after CLI install
**File:** `packages/lib/src/control-plane/setup-status.ts:23-31`
CLI's `ensureSecrets()` comments out `ADMIN_TOKEN` but sets `OPENPALM_ADMIN_TOKEN`. The fallback check uses `keys.ADMIN_TOKEN === true` which returns false after CLI setup. This causes `isSetupComplete()` to return false even when setup finished, triggering unnecessary setup token regeneration and incorrect state.

### M6. `mem0BaseUrlConfig` always appends `/v1` without stripping existing suffix
**File:** `packages/lib/src/provider-constants.ts:80-89`
User enters `https://api.groq.com/openai/v1` → becomes `https://api.groq.com/openai/v1/v1`. Memory service requests fail.

---

## LOW (6)

| # | Bug | Location |
|---|-----|----------|
| L1 | `ensureStackEnv` assumes artifacts directory exists — crashes if called independently | `cli/src/lib/env.ts:162` |
| L2 | No timeout on wizard `waitForComplete()` — CLI blocks forever if wizard abandoned | `cli/src/setup-wizard/server.ts:120-122` |
| L3 | CLI wizard `POST /api/setup/complete` casts body without validation before `performSetup` | `cli/src/setup-wizard/server.ts:215` |
| L4 | Step dot navigation lets users reach later steps with invalid state | `cli/src/setup-wizard/wizard.js:1015-1022` |
| L5 | Draft model cache `_draft` never transferred on save — redundant API call | `cli/src/setup-wizard/wizard.js:446-447` |
| L6 | Misleading review URL for Ollama in-stack (shows `localhost` not `ollama:11434`) | `cli/src/setup-wizard/wizard.js:29-30` |

---

## TEST GAPS

| Gap | Description |
|-----|-------------|
| **T1** | `staging.test.ts` tests an **inline reimplementation** of staging functions, NOT the real code — bugs in production code are invisible |
| **T2** | E2E wizard tests mock away ALL server-side behavior — only test HTML/JS, not the actual setup flow |
| **T3** | No tests for error scenarios in wizard (server 500, validation 400, network timeout, empty model lists) |
| **T4** | No tests for special characters in admin token (`=`, quotes, newlines) |
| **T5** | No test for stack spec creation during `performSetup()` |

---

## Priority Fixes

1. **C1** — Add `MEMORY_AUTH_TOKEN` generation to CLI's `ensureSecrets()` or `buildSecretsFromSetup()`
2. **H1** — Allow re-running setup after Docker failure (don't short-circuit on `setupComplete`)
3. **H2** — Fix deploy polling to wait for actual container status, not just `setupComplete`
4. **H3** — Preserve existing `OPENPALM_SETUP_COMPLETE` in `stageStackEnv` instead of deriving from token presence
5. **M1** — Remove Anthropic API key skip in CLI wizard validation
6. **M3** — Add `deepseek`/`together`/`xai` to `PROVIDER_KEY_MAP`
7. **M5** — Fix `isSetupComplete()` fallback to check `OPENPALM_ADMIN_TOKEN`
8. **T1** — Replace inline staging test reimplementation with imports from real module
