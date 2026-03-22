# Documentation vs. Implementation Misalignment Report

Generated: 2026-03-22  
Audited sources: `docs/technical/api-spec.md`, `docs/technical/environment-and-mounts.md`,
`docs/technical/directory-structure.md`, `docs/technical/foundations.md`,
`docs/technical/undocumented-details.md`, and all
`packages/admin/src/routes/**`, `packages/lib/`, `.openpalm/stack/` files.

---

## Summary

| Category | Count |
|---|---|
| Routes in docs that do not exist in code | 5 |
| Routes in code that are not in docs | 20+ |
| Response/payload shape mismatches | 9 |
| Compose / environment variable mismatches | 4 |
| Mount path mismatches | 2 |
| Docs describe correct behavior (no gap) | Many |

---

## Part 1 — Routes Documented But Not Implemented

### 1.1 `GET /admin/channels` — Route does not exist

**Docs claim (`api-spec.md:198-211`):**  
A `GET /admin/channels` endpoint that returns `{ installed: [...], available: [...] }`.

**Implementation:**  
There is no `packages/admin/src/routes/admin/channels/` directory.  
Channel discovery was replaced by the component/instance system (`/api/instances`, `/api/components`).

---

### 1.2 `POST /admin/channels/install` — Route does not exist

**Docs claim (`api-spec.md:218-242`):**  
Copies registry files into `stack/addons/`, ensures HMAC secret, runs compose up.  
Accepts `{ "channel": "chat" }`.

**Implementation:**  
No such route. Channel installation is now `POST /api/instances` via the component system.  
`POST /admin/registry/install` explicitly rejects `type: "channel"` with a 400 error:  
> "Channel installation is now handled via POST /api/instances."

---

### 1.3 `POST /admin/channels/uninstall` — Route does not exist

**Docs claim (`api-spec.md:244-268`):**  
Accepts `{ "channel": "chat" }`, removes addon directory, clears HMAC secret, stops service.

**Implementation:**  
No such route. Channel uninstallation is now `DELETE /api/instances/:instanceId`.  
`POST /admin/registry/uninstall` explicitly rejects `type: "channel"`:  
> "Channel uninstallation is now handled via DELETE /api/instances/:id."

---

### 1.4 `/admin/connections/profiles` CRUD — Routes do not exist

**Docs claim (`api-spec.md:637-760`):**  
Full CRUD at `/admin/connections/profiles`:
- `GET /admin/connections/profiles`
- `POST /admin/connections/profiles`
- `PUT /admin/connections/profiles`
- `DELETE /admin/connections/profiles`
- `GET /admin/connections/profiles/:id`
- `PUT /admin/connections/profiles/:id`
- `DELETE /admin/connections/profiles/:id`

**Implementation:**  
There is no `profiles/` subdirectory under `packages/admin/src/routes/admin/connections/`.  
The `connections/` directory contains only:
`+server.ts`, `assignments/`, `export/`, `network/` (actually `network/` is under admin separately), `status/`, `test/`

None of the profiles endpoints exist.

---

### 1.5 Setup-token route variants — Routes do not exist

**Docs claim (`api-spec.md:853-861`):**  
```
GET/POST/PUT/DELETE /admin/setup/connections/profiles
GET/POST /admin/setup/connections/assignments
```

**Implementation:**  
There is no `setup/` directory under `packages/admin/src/routes/admin/`.

---

## Part 2 — Routes Implemented But Not in Docs

The following routes exist in `packages/admin/src/routes/` but are **absent from `api-spec.md`**:

| Route | Verb(s) | Auth | Notes |
|---|---|---|---|
| `GET /admin/logs` | GET | requireAuth | Returns admin audit log lines |
| `GET /admin/containers/stats` | GET | requireAuth | Live Docker container stats |
| `GET /admin/containers/events` | GET | requireAuth | Docker event log stream |
| `GET /admin/network/check` | GET | requireAdmin | Checks inter-container connectivity |
| `GET /admin/opencode/status` | GET | requireAdmin | OpenCode process status |
| `POST /admin/opencode/status` | POST | requireAdmin | Restart OpenCode process |
| `GET /admin/opencode/model` | GET | requireAdmin | Current OpenCode model config |
| `POST /admin/opencode/model` | POST | requireAdmin | Update OpenCode model |
| `GET /admin/opencode/providers` | GET | requireAdmin | Lists OpenCode providers with auth status |
| `GET /admin/opencode/providers/[id]/auth` | GET | requireAdmin | Provider auth details |
| `GET /admin/opencode/providers/[id]/models` | GET | requireAdmin | Provider model list |
| `GET /admin/secrets` | GET | requireAdmin | Lists secret key names (values masked) |
| `POST /admin/secrets` | POST | requireAdmin | Set/update a secret |
| `DELETE /admin/secrets` | DELETE | requireAdmin | Delete a secret by key |
| `POST /admin/secrets/generate` | POST | requireAdmin | Generate a random secret |
| `GET /api/instances` | GET | requireAdmin | List all component instances |
| `POST /api/instances` | POST | requireAdmin | Create/install a component instance |
| `GET /api/instances/:instanceId` | GET | requireAdmin | Instance detail |
| `PUT /api/instances/:instanceId` | PUT | requireAdmin | Configure instance .env |
| `DELETE /api/instances/:instanceId` | DELETE | requireAdmin | Delete (archive) an instance |
| `GET /api/instances/:instanceId/health` | GET | requireAdmin | Instance health check |
| `GET /api/instances/:instanceId/logs` | GET | requireAdmin | Instance container logs |
| `POST /api/instances/:instanceId/restart` | POST | requireAdmin | Restart instance container |
| `POST /api/instances/:instanceId/start` | POST | requireAdmin | Start instance container |
| `POST /api/instances/:instanceId/stop` | POST | requireAdmin | Stop instance container |
| `GET /api/instances/:instanceId/schema` | GET | requireAdmin | Instance .env.schema as JSON |
| `GET /api/components` | GET | requireAdmin | List discovered components |
| `GET /api/components/:componentId` | GET | requireAdmin | Component detail + schema |
| `GET /admin/memory/models` | POST | requireAuth | List provider models (proxy) |
| `GET /admin/memory/reset-collection` | POST | requireAdmin | Delete vector store data |
| `GET /admin/connections/export/mem0` | GET | requireAdmin | Export mem0 config as JSON |
| `GET /admin/connections/export/opencode` | GET | requireAdmin | Export opencode.json |
| `GET /admin/automations` | GET | requireAuth | List automation configs |

Note: `export/mem0` and `export/opencode` do appear in `api-spec.md` but are listed above as a cross-check; they are correctly documented.  
`GET /admin/automations` is partially documented (response shape is slightly wrong — see Part 3).

---

## Part 3 — Response / Payload Shape Mismatches

### 3.1 `GET /admin/connections` — Completely different response shape

**Docs claim (`api-spec.md:429-479`):**  
Returns `{ profiles: [...], assignments: {...}, connections: {...} }` with full canonical DTO plus legacy map.

**Implementation (`packages/admin/src/routes/admin/connections/+server.ts`):**  
Returns `{ capabilities, secrets }` — `capabilities` is the `stack.yaml` capabilities spec, `secrets` is a masked map of secret key values from `user.env`.  
There is no `profiles`, `assignments`, or `connections` key at this endpoint.

This is the most significant misalignment in the API surface.

---

### 3.2 `POST /admin/connections` — Only one of three payload shapes is implemented

**Docs claim (`api-spec.md:499-574`):**  
Three payload shapes are accepted:
1. Canonical DTO (with `profiles`/`assignments`)
2. Unified save (with `provider` key)
3. Legacy key patch (raw `ALLOWED_CONNECTION_KEYS` map)

**Implementation:**  
Only the **unified save** shape (with `provider` key) is handled.  
The canonical DTO path (`profiles`/`assignments`) and legacy raw key-patch path are not implemented at this endpoint.

---

### 3.3 `GET /admin/registry` — Response key `channels` → `components`, different item shape

**Docs claim (`api-spec.md:274-290`):**  
```json
{
  "channels": [
    { "name": "chat", "type": "channel", "installed": true, "hasRoute": true, "description": "..." }
  ],
  "automations": [...],
  "source": "remote"
}
```

**Implementation:**  
```json
{
  "components": [
    { "id": "chat", "type": "channel" }
  ],
  "automations": [...],
  "source": "bundled"
}
```

Differences:
- Top-level key `channels` → `components`
- Component item shape: `id` instead of `name`, no `installed`, no `hasRoute`, no `description`
- `source` value: docs show `"remote"` as example; implementation only ever returns `"bundled"` (git pull result aside)

---

### 3.4 `POST /admin/registry/install` — Channel type rejected; docs say it's supported

**Docs claim (`api-spec.md:296-324`):**  
`type` must be `"channel"` or `"automation"`. A channel install copies addon files, generates HMAC secret, runs compose up.

**Implementation (`packages/admin/src/routes/admin/registry/install/+server.ts`):**  
Explicitly rejects `type: "channel"` with HTTP 400:  
> "Channel installation is now handled via POST /api/instances."  
Only `type: "automation"` is handled.

---

### 3.5 `POST /admin/registry/uninstall` — Channel type rejected; docs say it's supported

**Docs claim (`api-spec.md:351-383`):**  
Same as install: both `"channel"` and `"automation"` types are accepted.

**Implementation (`packages/admin/src/routes/admin/registry/uninstall/+server.ts`):**  
Rejects `type: "channel"` with HTTP 400.  
Only `type: "automation"` is handled.

---

### 3.6 `GET /admin/automations` — Response is missing `scheduler` status

**Docs claim (`api-spec.md:388-421`):**  
Response includes both `automations` array AND a `scheduler` object:
```json
{
  "automations": [...],
  "scheduler": { "running": true, "jobCount": 1 }
}
```

**Implementation (`packages/admin/src/routes/admin/automations/+server.ts:49`):**  
Returns only `{ automations }`. No `scheduler` key is included.

---

### 3.7 `POST /admin/install` — Response missing `artifactsDir`

**Docs claim (`api-spec.md:74-83`):**  
Response includes `artifactsDir: "/home/user/.openpalm/data"`.

**Implementation (`packages/admin/src/routes/admin/install/+server.ts`):**  
Returns `{ ok, started, dockerAvailable, composeResult }`. No `artifactsDir` field.

---

### 3.8 `GET /admin/connections/assignments` — `llm` field format

**Docs claim (`api-spec.md:762-780`):**  
`capabilities.llm` is a string like `"openai/gpt-4.1-mini"`.

**Implementation:**  
This is correct. The implementation reads from `stack.yaml` which stores `llm` as a `"provider/model"` string.  
However, the docs example only shows `llm`, `embeddings`, and `memory` in the GET response,  
while the implementation may also return `slm`, `tts`, `stt`, `reranking` if set in `stack.yaml`.  
The docs GET response example is incomplete — it does not show the full capability key set.

---

### 3.9 `GET /admin/connections` vs `GET /admin/connections/assignments` — Conflation

**Docs claim:**  
`GET /admin/connections` returns `profiles`, `assignments`, `connections`.  
`GET /admin/connections/assignments` returns `{ capabilities: {...} }`.

**Implementation:**  
`GET /admin/connections` returns `{ capabilities, secrets }` — which is essentially what docs say `GET /admin/connections/assignments` returns.  
The `/connections` and `/connections/assignments` endpoints appear to have overlapping or swapped semantics versus what the docs describe.

---

## Part 4 — Compose / Environment Variable Mismatches

### 4.1 Scheduler `OP_ADMIN_TOKEN` substitution source

**Docs claim (`environment-and-mounts.md:210`, `foundations.md`):**  
```yaml
OP_ADMIN_TOKEN: ${OP_ASSISTANT_TOKEN:-}
```
The scheduler's admin token is sourced from `OP_ASSISTANT_TOKEN`.

**Implementation (`.openpalm/stack/core.compose.yml:135`):**  
```yaml
OP_ADMIN_TOKEN: ${OP_ADMIN_TOKEN:-}
```
The scheduler's admin token is sourced from `OP_ADMIN_TOKEN`, not `OP_ASSISTANT_TOKEN`.

---

### 4.2 Assistant data mount path

**Docs claim (`directory-structure.md:94`, `environment-and-mounts.md:112`):**  
`$OP_HOME/data/assistant -> /home/opencode`  
(mounts to the opencode user's home directory root)

**Implementation (`.openpalm/stack/core.compose.yml:76`):**  
```yaml
- ${OP_HOME}/data/assistant:/home/opencode/data
```
Mounts to `/home/opencode/data`, not `/home/opencode`.

---

### 4.3 `AKM_STASH_DIR` value mismatch

**Docs claim (`environment-and-mounts.md:136`):**  
`AKM_STASH_DIR: /stash`

**Implementation (`core.compose.yml:60`):**  
`AKM_STASH_DIR: /home/opencode/.akm`

The actual value differs from the documentation.

---

### 4.4 OpenViking `ov.conf` mount not in compose file

**Docs claim (`environment-and-mounts.md:299`):**  
```
openviking: Mounts $OP_HOME/vault/user/ov.conf:/app/ov.conf:ro
```

**Implementation (`.openpalm/stack/addons/openviking/compose.yml`):**  
The openviking compose file does **not** mount `ov.conf` from `vault/user/`.  
Instead it uses `OPENVIKING_CONFIG_FILE: /app/ov.conf` env var without a corresponding bind mount in the file.  
The `ov.conf` mount referenced in the docs is absent from the actual compose file.

---

## Part 5 — Docs Reference Non-Existent Docs Files

The following files are referenced in docs but do not exist in this repository:

| Referenced file | Referenced from |
|---|---|
| `docs/how-it-works.md` | `undocumented-details.md` (multiple entries) |
| `docs/channels/community-channels.md` | `undocumented-details.md` |
| `docs/password-management.md` | `undocumented-details.md` |
| `docs/managing-openpalm.md` | `undocumented-details.md` |
| `docs/setup-guide.md` | `undocumented-details.md` |
| `docs/setup-walkthrough.md` | `undocumented-details.md` |
| `docs/installation.md` | `undocumented-details.md` |
| `docs/operations/manual-compose-runbook.md` | `environment-and-mounts.md`, `directory-structure.md` |
| `.openpalm/README.md` | `undocumented-details.md` |
| `.openpalm/config/README.md` | `undocumented-details.md` |
| `.openpalm/vault/README.md` | `undocumented-details.md` |

---

## Part 6 — Accurately Documented (No Gap Found)

The following are correctly described in the docs:

- `GET /health` and `GET /guardian/health` — response shape matches
- `POST /admin/install` behavior (directory seeding, compose up) — correct (minus `artifactsDir`)
- `POST /admin/update`, `POST /admin/uninstall`, `POST /admin/upgrade` — behavior descriptions are accurate
- `GET /admin/containers/list` — response shape matches
- `POST /admin/containers/up`, `down`, `restart` — body/response match; allowlist behavior correct
- `POST /admin/containers/pull` — behavior correct
- `GET /admin/connections/status` — response `{ complete, missing }` matches implementation
- `POST /admin/connections/test` — request/response shape matches
- `GET /admin/connections/assignments` — response shape matches (with caveat in 3.8)
- `POST /admin/connections/assignments` — payload and response match; supported keys match
- `GET /admin/connections/export/mem0` — behavior matches (returns attachment JSON)
- `GET /admin/connections/export/opencode` — behavior matches
- `GET /admin/memory/config` — response shape matches
- `POST /admin/memory/config` — request/response shape matches
- `POST /admin/memory/models` — request/response shape matches
- `POST /admin/memory/reset-collection` — response shape matches
- `POST /admin/registry/refresh` — behavior and response match
- `GET /admin/installed` — response `{ installed, activeServices }` matches
- `GET /admin/artifacts`, `GET /admin/artifacts/manifest`, `GET /admin/artifacts/:name` — correct
- `GET /admin/audit` — correct
- `GET /admin/config/validate` — correct
- `GET /admin/providers/local` — correct
- Core service env vars, port bindings, and network topology in `environment-and-mounts.md` — correct (with exceptions noted in Part 4)
- Docker network layout — correct
- XDG directory structure — correct (with exception noted in Part 4.2)
- Guardian env wiring — correct
- Channel addon compose structure (labels, healthcheck, ports) — correct; `openpalm.*` label contract is real
- Scheduler mount and network config — correct (with exception noted in Part 4.1)

---

## Recommended Priority for Fixes

### P0 — Docs contradict shipped code (will mislead callers today)

1. **`GET /admin/connections` response shape** — Docs show `profiles/assignments/connections`; code returns `capabilities/secrets`. Update docs or align the endpoint.
2. **`POST /admin/connections` payload shapes** — Docs describe 3 shapes; only 1 is implemented. Remove unimplemented shapes from docs or implement them.
3. **`GET /admin/registry` response** — Docs use `channels[]` with `name/installed/hasRoute/description`; code returns `components[]` with `id/type` only.
4. **`/admin/channels` routes** — Remove the entire Channel Management section (`GET /admin/channels`, `POST /admin/channels/install`, `POST /admin/channels/uninstall`) from docs; these routes don't exist. Replace with `/api/instances` and `/api/components` documentation.
5. **`/admin/connections/profiles` CRUD** — Remove all profiles sub-routes from docs; none are implemented.
6. **Setup-token variants** — Remove `/admin/setup/connections/*` from docs; no `setup/` directory exists.

### P1 — Missing documentation for implemented routes

7. **Document the entire `/api/instances` surface** — 8 routes managing component lifecycle (CRUD + health/logs/start/stop/restart/schema).
8. **Document `/api/components` and `/api/components/:id`** — Component discovery and detail.
9. **Document `/admin/secrets` CRUD** (GET/POST/DELETE + generate).
10. **Document `/admin/opencode/*`** — status, model, providers, providers/[id]/auth, providers/[id]/models.
11. **Document `/admin/logs`**, **`/admin/containers/stats`**, **`/admin/containers/events`**.
12. **Document `/admin/network/check`**.
13. **Document `/admin/automations`** and fix the missing `scheduler` key in the response.

### P2 — Compose / mount correctness

14. Fix `environment-and-mounts.md` scheduler `OP_ADMIN_TOKEN` substitution source.
15. Fix `directory-structure.md` and `environment-and-mounts.md` assistant data mount path (`/home/opencode` vs `/home/opencode/data`).
16. Fix `environment-and-mounts.md` `AKM_STASH_DIR` value (`/stash` vs `/home/opencode/.akm`).
17. Fix `environment-and-mounts.md` openviking `ov.conf` mount claim.

### P3 — Cross-references to non-existent files

18. Fix or create the referenced documentation files listed in Part 5, or remove the dead references.
