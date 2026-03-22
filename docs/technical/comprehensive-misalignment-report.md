# Comprehensive Misalignment Report

**Date:** 2026-03-22  
**Authoritative sources:** `@openpalm/lib` (`packages/lib/`), all compose files under `.openpalm/stack/`, and direct source reads.  
**Scope:** All documentation files under `docs/technical/` compared against every source file read in this audit session.  
**Supersedes:** `misalignment-report.md`, `admin-vs-new-design-misalignment-report.md`, `doc-vs-code-misalignment-report.md`

---

## Executive Summary

| Severity | Count |
|---|---|
| Critical — API/route/behavior completely wrong | 2 |
| High — response shape, env var, or behavior mismatch | 10 |
| Medium — minor shape drift, undocumented features, paths | 8 |
| Low — stale references, wording gaps | 6 |
| Resolved — previously reported, now fixed | many |

**Overall assessment:** The codebase and docs have improved substantially. The previous wave of phantom routes (channels, profiles, instances) is gone. The `api-spec.md` rewrite was largely successful. The remaining gaps are smaller in scope but still mislead callers.

---

## Previously Reported — Now Resolved

The following items from prior reports have been fixed and are **no longer misaligned**:

- `/admin/channels/install|uninstall` phantom routes — deleted.
- `/admin/connections/profiles` CRUD phantom routes — deleted.
- `/api/instances`, `/api/components` phantom routes — deleted.
- CLI `component` command — deleted.
- `GET /admin/connections` returning `profiles/assignments/connections` — now correctly returns `capabilities/secrets`.
- `GET /admin/registry` returning `channels[]` — now returns `automations[]` only; channels clarified as managed via `/admin/addons`.
- `POST /admin/registry/install` accepting `type: "channel"` — now explicitly 400s with clear redirect message.
- `admin-vs-new-design` Part 2.1 gap (no addon routes) — `GET/POST /admin/addons` and `GET/POST /admin/addons/:name` now exist and are correctly implemented.
- `admin-vs-new-design` Part 3.1 (delete opencode routes) — these routes intentionally kept and now documented in `api-spec.md`; the recommendation to delete them is itself resolved/closed.
- `doc-vs-code-misalignment-report.md` is correctly marked RESOLVED and is a historical record.
- `PROVIDER_KEY_MAP` drift — admin's `$lib/provider-constants.ts` is now a clean re-export from `@openpalm/lib/provider-constants`.

---

## Critical Misalignments

### C-1: `GET /admin/connections` response example in `api-spec.md` has unclosed JSON

**File:** `docs/technical/api-spec.md` lines 482–504

**Issue:** The code block showing the `GET /admin/connections` response is missing its closing `}`. The fence marker closes the block but the JSON object is never terminated:

```
  "MEMORY_USER_ID": "default_user"
  }

### `POST /admin/connections`
```

This is a documentation-only bug but the response example is malformed, making it unreadable to consumers.

**Actual response shape is correct** in the implementation (`connections/+server.ts`). Only the doc example is broken.

---

### C-2: `api-spec.md` `GET /admin/upgrade` `backupDir` path is wrong

**File:** `docs/technical/api-spec.md` line 121

**Doc claims:**
```json
"backupDir": "/home/user/.openpalm/data/backups/2025-01-01T00-00-00"
```

**Reality:** `resolveBackupsDir()` in `packages/lib/src/control-plane/home.ts` returns `${resolveOpenPalmHome()}/backups` — i.e., `~/.openpalm/backups/` at the root, **not** under `data/`. The `data/` subdirectory in the example is wrong.

**Impact:** Callers searching for backup archives will look in the wrong location.

---

## High Severity Misalignments

### H-1: `GET /admin/addons` response shape in `api-spec.md` uses `id` but implementation returns `name`

**File:** `docs/technical/api-spec.md` lines 272–280

**Doc claims:**
```json
{ "addons": [{ "id": "chat", "enabled": true, "env": {} }] }
```

**Reality:** `packages/admin/src/routes/admin/addons/+server.ts:37–41` defines `AddonItem` with a `name` field, not `id`. The actual response is:
```json
{ "addons": [{ "name": "chat", "enabled": true, "hasCompose": true, "env": {} }] }
```

Two differences: (1) `id` → `name`, (2) `hasCompose` field is present in the response but absent from the doc example.

**Impact:** Clients reading `addon.id` will receive `undefined`.

---

### H-2: `POST /admin/addons` response shape in `api-spec.md` uses nested `addon` object but implementation returns flat shape

**File:** `docs/technical/api-spec.md` lines 298–300

**Doc claims:**
```json
{ "ok": true, "addon": { "id": "chat", "enabled": true, "env": {} } }
```

**Reality:** `packages/admin/src/routes/admin/addons/+server.ts:163` returns:
```json
{ "ok": true, "addon": "chat", "enabled": true, "changed": true }
```

`addon` is a plain string (the name), not an object. `changed` is present in the actual response but absent from the doc.

---

### H-3: `GET /admin/audit` `source` parameter is undocumented

**File:** `docs/technical/api-spec.md` lines 912–915

**Doc claims:** Simple endpoint returning `{ "audit": [...] }` with only a `limit` parameter.

**Reality:** `packages/admin/src/routes/admin/audit/+server.ts` accepts `source=admin|guardian|all` and can merge in-memory admin audit with `logs/guardian-audit.log`. This is a significant undocumented behavior that callers would need to know about to retrieve guardian audit events.

---

### H-4: `POST /admin/memory/models` documented as `GET` in one place

**File:** `docs/technical/api-spec.md` line 137 of the doc-vs-code report (now resolved but worth noting the current `api-spec.md` line 765)

**Current `api-spec.md`:** Lists this as `POST /admin/memory/models` which is correct.  
However, the doc example shows `GET /admin/memory/models` in `doc-vs-code-misalignment-report.md:137` (marked resolved). No gap remains here — **this is confirmed correct in the current api-spec.md**.

---

### H-5: `POST /admin/memory/models` actual response includes `status` and `reason` fields not in doc

**File:** `docs/technical/api-spec.md` lines 795–803

**Doc claims:**
```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "error": null }
```

**Reality:** `packages/lib/src/control-plane/model-runner.ts` returns a `ProviderModelsResult` which includes `status: 'ok' | 'recoverable_error'`, `reason` (one of `timeout`, `missing_base_url`, `network`, `provider_http`), and optional `error`. The admin route passes this through. The `status` and `reason` fields are real and callers need them to distinguish error types.

---

### H-6: `POST /admin/connections/test` auth claim is wrong

**File:** `docs/technical/api-spec.md` line 571

**Doc claims:** "Accepts setup token or admin token."

**Reality:** `packages/admin/src/routes/admin/connections/test/+server.ts` calls `requireAdmin(event, requestId)` which only accepts the admin token (`OP_ADMIN_TOKEN`). There is no setup-token fallback in `requireAdmin`. The claim that setup tokens are accepted is false.

**Impact:** Setup wizard callers attempting to use a setup token at this endpoint will receive 401.

---

### H-7: Scheduler `OP_ADMIN_TOKEN` sourced from `OP_ADMIN_TOKEN`, not `OP_ASSISTANT_TOKEN`

**File:** `docs/technical/foundations.md` line 196

**Doc claims:**
```yaml
OP_ADMIN_TOKEN: ${OP_ASSISTANT_TOKEN:-}
```

**Reality:** `.openpalm/stack/core.compose.yml` (confirmed in prior audit) sets:
```yaml
OP_ADMIN_TOKEN: ${OP_ADMIN_TOKEN:-}
```

The scheduler's admin token is sourced from `OP_ADMIN_TOKEN`, not `OP_ASSISTANT_TOKEN`. `foundations.md` is wrong.

**Impact:** If a user relies on `OP_ASSISTANT_TOKEN` being forwarded to the scheduler, they will find the scheduler unauthenticated.

---

### H-8: `AKM_STASH_DIR` value is wrong in `environment-and-mounts.md`

**File:** `docs/technical/environment-and-mounts.md` line 136

**Doc claims:** `AKM_STASH_DIR: /stash`

**Reality:** `.openpalm/stack/core.compose.yml` sets `AKM_STASH_DIR: /home/opencode/.akm` which matches the mount `$OP_HOME/data/stash -> /home/opencode/.akm`.

---

### H-9: `GUARDIAN_SECRETS_PATH` env var is undocumented

**File:** `docs/technical/foundations.md`, `docs/technical/environment-and-mounts.md`

**Reality:** `core/guardian/src/server.ts:30` reads `GUARDIAN_SECRETS_PATH`. When set, the guardian loads channel secrets from a file (with mtime-based caching) rather than from environment variables. The TTL is overridable via `GUARDIAN_SECRETS_CACHE_TTL_MS` (default 30s). These env vars are absent from all docs.

**Impact:** Operators who want to dynamically rotate channel secrets without restarting the guardian cannot configure this feature.

---

### H-10: Guardian session-affinity metadata controls are undocumented

**File:** `docs/technical/foundations.md`, `docs/technical/environment-and-mounts.md`

**Reality:** `core/guardian/src/server.ts:243–260` implements:
- `metadata.sessionKey` — overrides the default per-user session mapping key.
- `metadata.clearSession: true` — clears all matching assistant sessions.
- Session TTL is configurable via `GUARDIAN_SESSION_TTL_MS` (default 15min).

These features are real and directly affect assistant conversation continuity for channel senders. Documented only in `docs/technical/undocumented-details.md` as a known gap, not in primary docs.

---

## Medium Severity Misalignments

### M-1: `directory-structure.md` omits `config/guardian/` directory

**Reality:** `ensureHomeDirs()` in `packages/lib/src/control-plane/home.ts` creates `config/guardian/` as part of the standard setup. Not present in the documented directory tree.

---

### M-2: `directory-structure.md` omits `backups/` at `OP_HOME` root

**Reality:** `ensureHomeDirs()` creates `${home}/backups`. The doc tree shows no `backups/` directory at the `~/.openpalm/` level.

---

### M-3: `directory-structure.md` workspace path confusion

**Reality:** `resolveWorkspaceDir()` returns `${resolveOpenPalmHome()}/workspace` (root level). The doc's Durable Data Policy table shows `data/workspace/` (under `data/`). The assistant's compose mount is `$OP_HOME/data/workspace -> /work` but the lib resolver points to `workspace/` not `data/workspace/`. This is a structural discrepancy between the compose file and the lib.

---

### M-4: `directory-structure.md` omits `vault/stack/addons/` directory

**Reality:** `ensureHomeDirs()` creates `vault/stack/addons/` and `writeManagedEnvFiles()` in `packages/lib/src/control-plane/spec-to-env.ts` writes per-addon `managed.env` files to `vault/stack/addons/{addonName}/managed.env`. This directory and pattern are absent from all documentation.

---

### M-5: `MEMORY_AUTH_TOKEN` vs `OP_MEMORY_TOKEN` inconsistency

**`foundations.md` line 83:** Lists `OP_MEMORY_TOKEN` as the memory service key env.  
**`environment-and-mounts.md` line 90:** Lists `MEMORY_AUTH_TOKEN` as the memory API auth variable.  
**Reality:** `core/memory/src/server.ts:216` reads `MEMORY_AUTH_TOKEN`. The lib's `memory-config.ts` also uses `MEMORY_AUTH_TOKEN`. The compose file writes `MEMORY_AUTH_TOKEN` from `stack.env`. `foundations.md` using `OP_MEMORY_TOKEN` is the incorrect value.

---

### M-6: `GET /admin/audit` source parameter undocumented (also H-3 above)

This overlaps with H-3 but is worth noting as a medium issue from the directory structure perspective: the guardian audit log path (`logs/guardian-audit.log`) is correctly documented in `environment-and-mounts.md`, but that the admin audit API can merge both sources via `?source=all` is not documented.

---

### M-7: OpenViking `ov.conf` mount not in compose file

**File:** `docs/technical/environment-and-mounts.md` line 299

**Doc claims:** openviking mounts `$OP_HOME/vault/user/ov.conf:/app/ov.conf:ro`

**Reality:** `.openpalm/stack/addons/openviking/compose.yml` does not have this bind mount. It sets `OPENVIKING_CONFIG_FILE: /app/ov.conf` via env but does not bind-mount the file. The mount documented does not exist in the actual overlay.

---

### M-8: Guardian `/stats` endpoint is undocumented

**Reality:** `core/guardian/src/server.ts:392–439` exposes a `GET /stats` endpoint (protected by admin token) that returns uptime, rate limiter state, nonce cache size, session counts, and per-channel/per-status request counters. This is completely absent from all documentation.

---

## Low Severity Misalignments

### L-1: Multiple referenced documentation files do not exist

The following files are referenced in `docs/technical/undocumented-details.md` and elsewhere but do not exist in the repository:

| Referenced file | Status |
|---|---|
| `docs/how-it-works.md` | Missing |
| `docs/channels/community-channels.md` | Missing |
| `docs/password-management.md` | Missing |
| `docs/managing-openpalm.md` | Missing |
| `docs/setup-guide.md` | Missing |
| `docs/setup-walkthrough.md` | Missing |
| `docs/installation.md` | Missing |
| `docs/operations/manual-compose-runbook.md` | Missing |
| `.openpalm/README.md` | Missing |
| `.openpalm/config/README.md` | Missing |
| `.openpalm/vault/README.md` | Missing |

---

### L-2: `OLLAMA_INSTACK_URL` auto-override is undocumented

**Reality:** During `performSetup()` in `packages/lib/src/control-plane/setup.ts`, when the `ollama-instack` addon is enabled, the connection `baseUrl` is automatically overridden to `http://ollama:11434`. This behavior is not documented anywhere.

---

### L-3: Provider-key pruning in assistant entrypoint is undocumented

**Reality:** `core/assistant/entrypoint.sh` removes unused provider API keys from the process environment based on `SYSTEM_LLM_PROVIDER` to reduce secret exposure. Documented only in `undocumented-details.md` as a gap.

---

### L-4: `stack.yaml` version field not documented

**Reality:** `packages/lib/src/control-plane/stack-spec.ts` defines `StackSpec` with a `version: 2` field. The live `.openpalm/config/stack.yaml` is version 1 (old format). The lib's `readStackSpec()` handles migration, but the version field and migration behavior are not documented.

---

### L-5: Dual rate limits in guardian are undocumented in primary docs

**Reality:** Guardian enforces both per-user (120/min) and per-channel (200/min) fixed-window rate limits. Documented in `undocumented-details.md` as a known gap but not in `foundations.md` or `environment-and-mounts.md`.

---

### L-6: Memory `/docs` endpoint does not exist but may be referenced

**Reality:** `core/memory/src/server.ts` does not expose any `/docs` UI or swagger endpoint. `docs/technical/undocumented-details.md` documents this as a known gap (line 232): `docs/managing-openpalm.md:319` claims a `/docs` endpoint exists.

---

## Admin Package Assessment (Code vs. Lib Contract)

The following is a code-vs-lib assessment, separate from doc gaps.

### Clean re-exports (no drift)

- `packages/admin/src/lib/provider-constants.ts` — pure re-export from `@openpalm/lib/provider-constants`. No drift.
- `packages/admin/src/lib/server/model-runner.ts` — re-export from lib. No drift.
- All server files (`docker.ts`, `memory-config.ts`, `scheduler.ts`, `secrets.ts`, `env.ts`, `audit.ts`) — thin wrappers or re-exports. No drift.

### Admin-local code that is intentionally not in lib (appropriate)

- `packages/admin/src/lib/server/helpers.ts` — SvelteKit-specific auth, SSRF prevention, JSON parsing. Correct to be local.
- `packages/admin/src/lib/server/registry-sync.ts` — git clone/pull, vite glob discovery. Correct to be local.
- `packages/admin/src/lib/server/vite-registry-provider.ts` — implements `RegistryProvider` using `import.meta.glob`. Correct.
- `packages/admin/src/lib/opencode/client.server.ts` — OpenCode REST client. Not in lib; appropriate since only admin uses OpenCode REST API.
- `packages/admin/src/lib/model-discovery.ts` — UI error message mapping. No lib equivalent; appropriate.
- `packages/admin/src/lib/wizard-scope.ts` — wizard-scoped provider/capability filtering. No lib equivalent; appropriate.

### Potential drift point: logger

- `packages/admin/src/lib/server/logger.ts` — local re-implementation of a logger. `@openpalm/lib` exports `createLogger` from `packages/lib/src/logger.ts`. The admin's local logger is **functionally similar but a separate implementation**, not imported from lib. This is a low-risk drift point — if logger behavior needs to change, it must be updated in two places.

---

## Confirmed Build-Level Issues (from `admin-vs-new-design-misalignment-report.md` — verification status)

### Status: Needs verification

The following bugs were reported in `admin-vs-new-design-misalignment-report.md` Part 5. These were not re-read during this audit session and their current status is unknown:

| Bug | File | Action needed |
|---|---|---|
| `channels.ts` `discoverChannels` return type missing `hasRoute` | `packages/lib/src/control-plane/channels.ts` | Verify/fix |
| `assistant-tools` `memory-context.ts:140` scope type error | `packages/assistant-tools/src/memory-context.ts` | Verify/fix |
| `assistant-tools` `tools/lib.ts:23` `ProvisionResult` missing `error` | `packages/assistant-tools/src/tools/lib.ts` | Verify/fix |

Bugs 5.1 (`control-plane.ts` importing non-exported functions) and 5.2 (`staging.ts` importing deleted exports) were tied to deleted legacy code and are presumably no longer applicable.

---

## Accurate Documentation (No Gap Found)

The following docs and routes are correctly described:

- `docs/technical/core-principles.md` — Architectural rules match code patterns.
- `docs/technical/code-quality-principles.md` — Engineering standards match style.
- `docs/technical/bunjs-rules.md` — Accurate for Bun usage patterns.
- `docs/technical/sveltekit-rules.md` — Accurate for SvelteKit patterns.
- `docs/technical/foundations.md` — Accurate except for H-7 (scheduler token), M-5 (memory token name), H-10 (guardian session metadata).
- `docs/technical/environment-and-mounts.md` — Accurate except for H-8 (AKM_STASH_DIR), H-7 (scheduler token), M-7 (openviking mount).
- `docs/technical/opencode-configuration.md` — Not re-read in this session; prior reports noted it as broadly accurate.
- `api-spec.md` lifecycle, container, registry, connections, memory, config, artifact, audit, installed, secrets, and OpenCode sections — broadly accurate (with exceptions noted above).
- Admin addon routes (`GET/POST /admin/addons`, `GET/POST /admin/addons/:name`) — correctly implemented and match `api-spec.md` except for the shape mismatches in H-1 and H-2.
- Guardian HMAC flow, nonce replay protection, payload validation — correctly implemented; security-critical paths are sound.
- Scheduler: `loadAutomations`, `executeAction`, Croner integration, file watching, HTTP API — correctly implemented and match lib contracts.
- Memory server: auth, config, vector-store, feedback, stats endpoints — correctly implemented.

---

## Recommended Actions (Priority Order)

### P0 — Misleads callers today

1. **Fix `GET /admin/connections` JSON block** in `api-spec.md` — add the missing closing `}`.
2. **Fix `GET /admin/addons` response shape** in `api-spec.md` — change `id` to `name`, add `hasCompose`.
3. **Fix `POST /admin/addons` response shape** in `api-spec.md` — `addon` is a string, not an object; add `changed`.
4. **Fix `POST /admin/connections/test` auth claim** — remove "Accepts setup token" from `api-spec.md`.
5. **Fix `GET /admin/upgrade` `backupDir` path** — remove `data/` from the example in `api-spec.md`.
6. **Fix `foundations.md` scheduler `OP_ADMIN_TOKEN`** source — change `${OP_ASSISTANT_TOKEN:-}` to `${OP_ADMIN_TOKEN:-}`.

### P1 — Missing documentation for real features

7. **Document `GUARDIAN_SECRETS_PATH` and `GUARDIAN_SECRETS_CACHE_TTL_MS`** in `foundations.md` and `environment-and-mounts.md`.
8. **Document guardian session metadata controls** (`sessionKey`, `clearSession`, `GUARDIAN_SESSION_TTL_MS`) in `foundations.md`.
9. **Document `GET /guardian/stats`** endpoint in `foundations.md`.
10. **Document guardian dual rate limits** (120/min user, 200/min channel) in `foundations.md` and `environment-and-mounts.md`.
11. **Fix `AKM_STASH_DIR`** value in `environment-and-mounts.md`: `/stash` → `/home/opencode/.akm`.
12. **Fix `MEMORY_AUTH_TOKEN` vs `OP_MEMORY_TOKEN`** in `foundations.md`.
13. **Document `POST /admin/memory/models` `status` and `reason` fields** in `api-spec.md`.

### P2 — Directory structure corrections

14. **Add `config/guardian/`** to directory tree in `directory-structure.md`.
15. **Add `backups/`** at `OP_HOME` root in `directory-structure.md`.
16. **Add `vault/stack/addons/`** to directory tree and document per-addon `managed.env` pattern.
17. **Clarify workspace path** (`workspace/` at root vs `data/workspace/` — verify which is canonical and fix both `directory-structure.md` and the compose mount if inconsistent).
18. **Fix openviking `ov.conf` mount** claim in `environment-and-mounts.md` (remove or document as planned).

### P3 — Code health

19. **Verify `channels.ts` `discoverChannels` `hasRoute` return type mismatch** — fix if still present.
20. **Verify `assistant-tools` type errors** — fix if still present.
21. **Consolidate logger** — consider making admin import `createLogger` from `@openpalm/lib` to eliminate the duplicate implementation.

### P4 — Create missing reference documents

22. **Create or remove references** to `docs/how-it-works.md`, `docs/password-management.md`, `docs/managing-openpalm.md`, `docs/operations/manual-compose-runbook.md`, and the three `.openpalm/README.md` files. Either write stub versions or remove the dead links.
