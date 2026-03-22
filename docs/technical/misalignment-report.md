# Docs vs Implementation Misalignment Report

**Scope:** All documentation in `docs/technical/` compared against the actual
implementation in `packages/lib/` (authoritative) and `packages/admin/`.

**Methodology:** Every route file, lib source file, and doc was read in full.
Each finding notes the doc claim, the actual implementation, and a severity.

---

## Summary

| Severity | Count |
|---|---|
| Critical (route/endpoint missing or completely wrong) | 7 |
| High (response shape or behavior mismatch) | 10 |
| Medium (env var names, directory paths, minor schema drift) | 8 |
| Low (wording gaps, undocumented features) | 5 |

---

## Critical — Route / Endpoint Missing or Completely Wrong

### C-1: `GET/POST/PUT/DELETE /admin/channels` does not exist

**Doc claims (`api-spec.md` lines 197–268):** A full channel management API
at `/admin/channels`, `/admin/channels/install`, `/admin/channels/uninstall`.

**Reality:** No `channels/` directory exists under
`packages/admin/src/routes/admin/`. Channel install/uninstall has been
**replaced by the addon system** at `/admin/addons` and `/admin/addons/[name]`.

**Impact:** Any caller (assistant, CLI) that uses `/admin/channels/install` will
receive a 404. The API spec is a false contract.

---

### C-2: `GET/POST/PUT/DELETE /admin/connections/profiles` does not exist

**Doc claims (`api-spec.md` lines 637–760):** CRUD operations at
`/admin/connections/profiles` and `/admin/connections/profiles/:id` for managing
canonical connection profiles stored in `config/connections/profiles.json`.

**Reality:** No `profiles/` directory exists under
`packages/admin/src/routes/admin/connections/`. There is no
`config/connections/profiles.json` file or writing logic anywhere in the lib or
admin code.

**Impact:** Entire profiles API is phantom. The documented `GET /admin/connections`
response shape that returns `profiles` and `assignments` objects does not match
reality (see H-1 below).

---

### C-3: Setup-token route variants do not exist

**Doc claims (`api-spec.md` lines 853–861):** Routes at
`GET/POST/PUT/DELETE /admin/setup/connections/profiles` and
`GET/POST /admin/setup/connections/assignments` for setup-token-compatible auth.

**Reality:** No `setup/` directory exists under
`packages/admin/src/routes/admin/`. Since profiles routes don't exist, setup
variants don't exist either.

---

### C-4: `POST /admin/registry/install` rejects `type: "channel"`

**Doc claims (`api-spec.md` lines 295–331):** `POST /admin/registry/install`
supports `type: "channel"` and `type: "automation"` with described compose-up
behavior for channels.

**Reality:** The actual handler at
`packages/admin/src/routes/admin/registry/install/+server.ts` returns `400`
with an error pointing callers to `POST /admin/addons/:name` when
`type: "channel"` is submitted. Only `type: "automation"` is accepted.

---

### C-5: `GET /admin/registry` response shape is wrong

**Doc claims (`api-spec.md` lines 274–290):**
```json
{
  "channels": [{ "name": "chat", "type": "channel", "installed": true, "hasRoute": true, "description": "..." }],
  "automations": [...]
}
```

**Reality:** The actual response uses `components` (not `channels`) and the
shape differs. The `hasRoute` field and `channels` top-level key are not present
in the actual implementation. The real response shape uses `components` with `id`
and `type` fields.

---

### C-6: `GET /admin/connections` response shape is wrong

**Doc claims (`api-spec.md` lines 429–479):** Returns three objects: `profiles`
(canonical DTO array), `assignments` (capability map), and `connections` (legacy
masked key/value map).

**Reality:** The actual `/admin/connections` GET returns `capabilities` (from
`stack.yaml`) and `secrets` (masked key/value pairs from `user.env`). There is
no `profiles` or `assignments` key in the actual response.

---

### C-7: `POST /admin/connections` only supports unified-save shape

**Doc claims (`api-spec.md` lines 497–574):** Three payload shapes supported:
(1) canonical DTO with `profiles`+`assignments`, (2) unified save with `provider`
key, (3) legacy key patch.

**Reality:** The actual handler only processes the unified-save shape (detects
`provider` key) and falls through to a key-patch path. The canonical DTO path
with `profiles` array is not implemented — there is no code that reads a
`profiles` array from the POST body.

---

## High — Response Shape or Behavior Mismatch

### H-1: `GET /admin/automations` does not return `scheduler` or `logs`

**Doc claims (`api-spec.md` lines 387–420):** Response includes a `scheduler`
object (`{ running: boolean, jobCount: number }`) and `logs: []` per automation.

**Reality:** The actual handler returns only the automation config fields. No
`scheduler` status and no `logs` per automation.

---

### H-2: `ALLOWED_CONNECTION_KEYS` documented list does not match lib

**Doc claims (`api-spec.md` lines 482–495):** Allowed keys include
`SYSTEM_LLM_PROVIDER`, `SYSTEM_LLM_BASE_URL`, `SYSTEM_LLM_MODEL`,
`EMBEDDING_MODEL`, `EMBEDDING_DIMS`, `MEMORY_USER_ID`, `OPENAI_BASE_URL`.

**Reality:** The lib (`packages/lib/src/control-plane/secrets.ts`) uses
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`,
`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`,
`HF_TOKEN`, `EMBEDDING_API_KEY`, `OPENAI_BASE_URL`, `OWNER_NAME`, `OWNER_EMAIL`.
The "system LLM" keys (`SYSTEM_LLM_PROVIDER` etc.) are derived from
`stack.yaml` via `spec-to-env.ts` into `vault/stack/services/memory/managed.env`,
not written to `vault/user/user.env` by the connections API.

---

### H-3: `GET /admin/connections/assignments` shape is partially wrong

**Doc claims (`api-spec.md` lines 762–780):** Returns a `capabilities` object
with `llm` (string), `embeddings` (object with `provider`/`model`/`dims`), and
`memory` (object with `userId`/`customInstructions`).

**Reality:** The actual handler reads directly from `stack.yaml` via
`readStackSpec()` and returns the `capabilities` object verbatim, which also
includes optional `slm`, `tts`, `stt`, and `reranking` fields not shown in the
doc example.

---

### H-4: `POST /admin/install` response does not include `artifactsDir`

**Doc claims (`api-spec.md` lines 76–83):**
```json
{
  "ok": true,
  "started": [...],
  "dockerAvailable": true,
  "composeResult": {...},
  "artifactsDir": "/home/user/.openpalm/data"
}
```

**Reality:** The actual response (`packages/admin/src/routes/admin/install/+server.ts`)
does not include `artifactsDir`. Response is:
```json
{ "ok": true, "started": [...], "dockerAvailable": true, "composeResult": {...} }
```

---

### H-5: `GET /admin/audit` `source` query param is undocumented

**Doc claims (`api-spec.md` lines 1076–1079):** Simple endpoint returning
`{ "audit": [...] }` with only a `limit` parameter.

**Reality:** The actual handler supports `source=admin|guardian|all` which
merges admin in-memory audit with `logs/guardian-audit.log`. This is a
significant undocumented feature.

---

### H-6: `POST /admin/memory/models` response shape differs

**Doc claims (`api-spec.md` lines 959–966):**
```json
{ "models": ["gpt-4o", "gpt-4o-mini"], "error": null }
```

**Reality:** The actual lib returns a `ProviderModelsResult` with `models`,
`status` (`'ok' | 'recoverable_error'`), `reason` (enum), and optional `error`.
The `status` and `reason` fields are present in the actual response but absent
from the doc.

---

### H-7: New endpoints undocumented entirely

The following routes exist in the implementation but are **completely absent**
from `api-spec.md`:

| Route | File |
|---|---|
| `GET /admin/opencode/providers` | `opencode/providers/+server.ts` |
| `GET /admin/opencode/providers/[id]/models` | `opencode/providers/[id]/models/+server.ts` |
| `POST /admin/opencode/providers/[id]/auth` | `opencode/providers/[id]/auth/+server.ts` |
| `GET /admin/opencode/model` | `opencode/model/+server.ts` |
| `POST /admin/opencode/model` | `opencode/model/+server.ts` |
| `GET /admin/opencode/status` | `opencode/status/+server.ts` |
| `GET /admin/network/check` | `network/check/+server.ts` |
| `GET /admin/secrets` | `secrets/+server.ts` |
| `POST /admin/secrets` | `secrets/+server.ts` |
| `DELETE /admin/secrets` | `secrets/+server.ts` |
| `POST /admin/secrets/generate` | `secrets/generate/+server.ts` |
| `GET /admin/addons` | `addons/+server.ts` |
| `GET/POST/DELETE /admin/addons/[name]` | `addons/[name]/+server.ts` |
| `GET /admin/connections/export/mem0` | `connections/export/mem0/+server.ts` |
| `GET /admin/connections/export/opencode` | `connections/export/opencode/+server.ts` |
| `POST /admin/connections/test` | `connections/test/+server.ts` |
| `GET /admin/containers/stats` | `containers/stats/+server.ts` |
| `GET /admin/containers/events` | `containers/events/+server.ts` |
| `GET /admin/logs` | `logs/+server.ts` |

---

### H-8: `POST /admin/registry/uninstall` channel type goes to addons system

**Doc claims:** Channel uninstall removes from `stack/addons/`, clears channel
secret, stops Docker service.

**Reality:** Like install, the registry uninstall handler redirects channel
uninstalls to the addons system (`DELETE /admin/addons/:name`).

---

### H-9: `GET /admin/connections/status` checks `stack.yaml`, not `user.env`

**Doc claims (`api-spec.md` lines 581–595):** Checks whether non-empty capability
assignments exist for LLM and embeddings.

**Reality:** Correctly reads `stack.yaml` `capabilities.llm` and
`capabilities.embeddings.provider/model`. The doc is broadly accurate but the
detail about what exactly is checked (trimming, which fields) is incomplete.

---

### H-10: `GET /admin/upgrade` backup path is wrong in response example

**Doc claims (`api-spec.md` line 123):**
```json
"backupDir": "/home/user/.openpalm/data/backups/2025-01-01T00-00-00"
```

**Reality:** The backup path comes from `refreshCoreAssets()` in
`core-assets.ts`. The actual backups live in `~/.openpalm/backups/` (top-level
under `OP_HOME`), not under `data/`. The `backups/` directory is created by
`ensureHomeDirs()` at `${home}/backups`.

---

## Medium — Env Var Names, Directory Paths, Minor Schema Drift

### M-1: `directory-structure.md` omits `config/guardian/` directory

**Doc tree (`directory-structure.md` lines 42–78):** Shows `config/assistant/`
and `config/automations/` but not `config/guardian/`.

**Reality:** `ensureHomeDirs()` in `packages/lib/src/control-plane/home.ts:85`
creates `config/guardian/` as part of the standard setup. It is absent from the
documented directory tree.

---

### M-2: `directory-structure.md` omits `backups/` at `OP_HOME` root

**Doc tree:** Shows `data/`, `config/`, `stack/`, `vault/`, `logs/` at the
`~/.openpalm/` root. No `backups/` directory.

**Reality:** `ensureHomeDirs()` creates `${home}/backups` and `resolveBackupsDir()`
in `home.ts:63` returns `${resolveOpenPalmHome()}/backups`. This is also where
`applyUpgrade()` stores backup archives.

---

### M-3: `directory-structure.md` omits `workspace/` at `OP_HOME` root

**Doc tree (`directory-structure.md` lines 73–74):** Shows `data/workspace/`
under `data/`.

**Reality:** `ensureHomeDirs()` creates BOTH `${home}/workspace/` (top-level,
for the assistant container's `/work` mount) AND the tree shows
`data/workspace/` under `data/`. The lib's `resolveWorkspaceDir()` returns
`${resolveOpenPalmHome()}/workspace`. This is separate from `data/workspace/`
shown in the doc's Durable Data Policy table.

---

### M-4: `directory-structure.md` omits `vault/stack/addons/` directory

**Doc tree (`directory-structure.md` lines 59–66):** Shows `vault/stack/` with
`stack.env`, `auth.json`, and `services/memory/managed.env`.

**Reality:** `ensureHomeDirs()` creates `vault/stack/addons/` and
`writeManagedEnvFiles()` in `spec-to-env.ts:129-131` writes per-addon
`managed.env` files to `vault/stack/addons/{addonName}/managed.env`. This
directory and pattern are undocumented.

---

### M-5: `directory-structure.md` shows `data/workspace/` but lib puts workspace at root

The doc's "Durable Data Policy" table (`directory-structure.md` line 130) lists
`data/workspace/` as used by `assistant, admin`. However `resolveWorkspaceDir()`
points to `~/.openpalm/workspace/` (root level). The assistant and admin addons
mount `/work` from different paths. This creates confusion about which path is
canonical for workspace.

---

### M-6: `MEMORY_AUTH_TOKEN` vs `OP_MEMORY_TOKEN` inconsistency

**`foundations.md`:** Uses `OP_MEMORY_TOKEN` for the memory service.

**`environment-and-mounts.md`:** Uses `MEMORY_AUTH_TOKEN` for the memory service
auth token in multiple places.

**Reality:** The lib (`memory-config.ts:293`) reads `process.env.MEMORY_AUTH_TOKEN`
to authenticate calls to the memory API. The generated `stack.env` fallback
in `config-persistence.ts:124` writes `OP_MEMORY_TOKEN`. These are two different
env vars for the same purpose — whichever is set takes precedence.

---

### M-7: `api-spec.md` lifecycle policy section references removed channel routes

**`api-spec.md` lines 61–64:**
```
Explicit mutation endpoints (POST /admin/connections,
POST /admin/channels/install, POST /admin/channels/uninstall,
POST /admin/setup) are the allowed write path
```

`/admin/channels/install` and `/admin/channels/uninstall` were removed (see C-1).
This policy statement is now incorrect.

---

### M-8: `data/` vs root-level `logs/` confusion in directory-structure.md

**Doc (`directory-structure.md` line 74):** Shows `data/workspace/` under `data/`.

**Reality in home.ts:** `data/stash/` exists (confirmed), but `data/workspace/`
is NOT created by `ensureHomeDirs()`. The actual workspace is at
`${home}/workspace` (root level, not under `data/`). The Guardian's data mount
is `data/guardian/`, not the workspace.

---

## Low — Wording Gaps and Undocumented Features

### L-1: `StackSpec v2` is undocumented in `api-spec.md`

The `stack.yaml` format (v2 capabilities schema with `llm`, `slm`, `embeddings`,
`memory`, `tts`, `stt`, `reranking`, `addons`) is documented in the lib
(`stack-spec.ts`) but has no corresponding documentation in `api-spec.md` or
`directory-structure.md`. The assignments API accepts `tts`, `stt`, `slm`, and
`reranking` but these are only documented as unrecognized keys that get rejected.
`api-spec.md` lines 789–790 lists them as valid keys for `POST /admin/connections/assignments`
but the doc example only shows `llm`/`embeddings`/`memory`.

---

### L-2: `OLLAMA_INSTACK_URL` override behavior is undocumented

During `performSetup()` in `setup.ts:167-169`, when Ollama is enabled as an
addon, the Ollama connection's `baseUrl` is automatically overridden to
`http://ollama:11434` (the Docker internal network name). This behavior is not
documented in `api-spec.md` or `core-principles.md`.

---

### L-3: `POST /admin/connections/test` accepts setup token

**Doc (`api-spec.md` lines 596–635):** Only mentions `baseUrl`, `apiKey`, `kind`
in the request body.

**Reality:** The handler uses `requireAdmin` which only accepts the admin token.
The doc says "Accepts setup token or admin token" but the implementation only
uses `requireAdmin`. (Note: some other endpoints use `requireAuth` which does
accept setup tokens. This inconsistency between the doc claim and implementation
should be verified.)

---

### L-4: Secret backend system is undocumented

The `secrets/` route family (`GET/POST/DELETE /admin/secrets`,
`POST /admin/secrets/generate`) exposes a pluggable secret backend system
(`detectSecretBackend()`, `backend.list()`, `backend.write()`, `backend.remove()`,
`backend.generate()`, `backend.capabilities`). This entire subsystem is absent
from `api-spec.md`.

---

### L-5: `logs/` directory mount for admin-audit.jsonl

**Doc (`directory-structure.md` lines 75–76, 139–142):** Lists
`logs/admin-audit.jsonl` and `logs/guardian-audit.log` as the audit log paths.

**Reality:** The audit route (`audit/+server.ts`) reads `state.logsDir` for the
guardian audit log. The admin audit is in-memory (not written to `admin-audit.jsonl`
on disk during the process lifetime — it's flushed from `state.audit[]`). The
on-disk file would only exist if an external writer creates it. The actual path
reference in `audit/+server.ts` is `join(logsDir, "guardian-audit.log")`, which
is correct. However `admin-audit.jsonl` is either written by a separate process
or the doc is aspirational.

---

## Cross-Cutting Issues

### X-1: `api-spec.md` introduction contradicts itself

The opening line of `api-spec.md` states:
> "This document describes the Admin API routes currently implemented in packages/admin/src/routes/**/+server.ts."

However multiple routes described (channels API, profiles API, setup variants)
**do not exist** in that directory. The document title claims "Current
Implementation" but describes a planned or historical API that was never built
or was removed.

**Recommendation:** Rename to `api-spec-planned.md` or do a full rewrite to
match actual routes. The doc should be regenerated from the actual route files.

---

### X-2: `StackSpec` capabilities drive the system but are not the source of truth documented for connections

The docs present connections management (profiles, assignments, keys) as the
primary abstraction. The actual system's source of truth is `stack.yaml`
(`StackSpec v2`) — capabilities are stored there, derived env files are written
from it, and the connections API primarily reads/writes `stack.yaml`.
Documentation should be reorganized around `stack.yaml` as the single source
of truth.

---

## Files That Are Accurate (No Misalignment Found)

- `docs/technical/core-principles.md` — Architectural rules match actual code patterns
- `docs/technical/code-quality-principles.md` — Engineering standards match code style
- `docs/technical/bunjs-rules.md` — Accurate for Bun usage patterns observed
- `docs/technical/sveltekit-rules.md` — Accurate for SvelteKit patterns observed
- `docs/technical/environment-and-mounts.md` — Broadly accurate with the M-6 token name exception
- `POST /admin/update`, `POST /admin/uninstall` — Response shapes match implementation
- `GET /admin/containers/list`, `POST /admin/containers/up/down/restart` — Match implementation
- `GET /admin/config/validate`, `GET /admin/artifacts`, `GET /admin/installed` — Match implementation
- `GET /admin/memory/config`, `POST /admin/memory/config`, `POST /admin/memory/reset-collection` — Match implementation (with H-6 caveat on models response shape)
- `GET /admin/providers/local` — Matches implementation

---

## Recommended Actions (Priority Order)

1. **Rewrite `api-spec.md`** from scratch by reading each `+server.ts` file.
   Remove phantom routes (C-1 through C-4). Add the 19 undocumented routes (H-7).

2. **Update `directory-structure.md`** to add `config/guardian/`, `backups/`,
   `workspace/` (at root), and `vault/stack/addons/` to the tree.

3. **Resolve `MEMORY_AUTH_TOKEN` vs `OP_MEMORY_TOKEN`** — pick one name, update
   `foundations.md` and `environment-and-mounts.md` to agree.

4. **Document `stack.yaml` (StackSpec v2)** as the primary configuration
   contract. Add a dedicated section to `api-spec.md` or a new
   `stack-spec.md` doc.

5. **Document the addons system** (`/admin/addons`, `/admin/addons/[name]`) as
   the replacement for the channels API.

6. **Document the secret backend** (`/admin/secrets`) including the pluggable
   backend abstraction.
