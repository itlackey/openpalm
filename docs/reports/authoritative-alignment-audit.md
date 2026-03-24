# Authoritative Documentation Alignment Audit (Rev 4)

**Branch:** `release/0.10.0`
**Date:** 2026-03-22
**Scope:** Compare implementation and non-authoritative docs against updated `docs/technical/authoritative/`

---

## Revision Notes

**Rev 4** — Integrated external feedback. Added rollback scope implementation mismatch (MF-14: `rollback.ts` snapshots files outside the authoritative rollback scope). Added code location evidence for backups/ (MF-10).

**Rev 3** — All design decisions finalized with project owner. Clarifications on: memory env source acknowledgment, channel secret location (`vault/stack/guardian.env`), three-env-file compose invocation, scheduler retaining OPENCODE_API_URL + PASSWORD, and backups/ as a distinct top-level directory separate from rollback.

**Rev 2** — Re-audited after authoritative docs were updated. Identified compose drift, internal spec contradictions, and remaining doc cascade needs.

**Rev 1** — Initial audit. Identified 5 critical issues, 8 warnings.

---

## Summary

| Category | Status | Must-Fix | Should-Fix |
|----------|--------|----------|------------|
| Compose vs authoritative spec | **FAIL** | 5 | 0 |
| Authoritative internal consistency | **FAIL** | 4 | 0 |
| Shared control-plane (lib) | **FAIL** | 2 | 0 |
| CLAUDE.md drift | **FAIL** | 1 | 1 |
| Non-authoritative doc drift | **FAIL** | 0 | 2 |
| Docker dependency resolution | PASS | 0 | 0 |
| Ports, networks, healthchecks | PASS | 0 | 1 |
| Assistant container & extensions | PASS | 0 | 0 |

**Total: 12 must-fix, 4 should-fix**

---

## Must-Fix: Compose vs Authoritative Spec

### MF-1. Assistant vault/user mount — file/ro instead of directory/rw

| Aspect | Authoritative Spec | Current Compose (`core.compose.yml:78`) |
|--------|--------------------|-----------------------------------------|
| Host path | `$OP_HOME/vault/user/` | `$OP_HOME/vault/user/user.env` |
| Container path | `/etc/vault/` | `/etc/openpalm-vault/user.env` |
| Permissions | rw | `:ro` |

**References:** `foundations.md:135`, `core-principles.md:61`, `core-principles.md:100`

**Required compose change:**
```yaml
# OLD
- ${OP_HOME}/vault/user/user.env:/etc/openpalm-vault/user.env:ro
# NEW
- ${OP_HOME}/vault/user:/etc/vault
```

**Cascading code changes:**
- `core/assistant/entrypoint.sh` — update references from `/etc/openpalm-vault/user.env` to `/etc/vault/user.env`
- Any assistant code reading from the old container path

---

### MF-2. Assistant data mount — /home/opencode/data instead of /home/opencode/

| Aspect | Authoritative Spec | Current Compose (`core.compose.yml:79`) |
|--------|--------------------|-----------------------------------------|
| Container path | `/home/opencode/` | `/home/opencode/data` |

**Reference:** `foundations.md:129`

**Required compose change:**
```yaml
# OLD
- ${OP_HOME}/data/assistant:/home/opencode/data
# NEW
- ${OP_HOME}/data/assistant:/home/opencode
```

**Note:** Other mounts target /home/opencode subdirectories (`.akm`, `.config/opencode`, `.local/state/opencode`). Docker handles nested bind mounts correctly — more specific mounts overlay the parent.

---

### MF-3. Channel addons — load vault env_files instead of using ${VAR} substitution

All 5 channel addons load `vault/stack/stack.env` and `vault/user/user.env` as `env_file` entries, violating the vault boundary.

**Authoritative rule** (`core-principles.md:109`):
> "No container except admin may mount `vault/` as a directory. The assistant receives only a bind mount of `vault/user/` (the directory, rw). Guardian, scheduler, and memory receive secrets exclusively through `${VAR}` substitution at container creation time and optional service-specific managed env files."

**Owner decision:** Channel secrets live in `vault/stack/guardian.env`. This file is:
1. Loaded by guardian as `env_file` (and via `GUARDIAN_SECRETS_PATH` for hot-reload)
2. Passed as a third compose `--env-file` so `${CHANNEL_<NAME>_SECRET}` resolves for channel composes
3. Channels receive only their own secret via `${VAR}` substitution in their `environment:` block

**Required change for each channel compose:**
```yaml
# REMOVE entire env_file block:
#   env_file:
#     - path: ${OP_HOME}/vault/stack/stack.env
#       required: false
#     - path: ${OP_HOME}/vault/user/user.env
#       required: false

# ADD to environment block:
environment:
  # ... existing vars ...
  CHANNEL_SECRET: ${CHANNEL_CHAT_SECRET:-}   # channel-specific var name
```

**Affected files:**
- `.openpalm/stack/addons/chat/compose.yml` — `CHANNEL_SECRET: ${CHANNEL_CHAT_SECRET:-}`
- `.openpalm/stack/addons/api/compose.yml` — `CHANNEL_SECRET: ${CHANNEL_API_SECRET:-}`
- `.openpalm/stack/addons/voice/compose.yml` — `CHANNEL_SECRET: ${CHANNEL_VOICE_SECRET:-}`
- `.openpalm/stack/addons/discord/compose.yml` — `CHANNEL_SECRET: ${CHANNEL_DISCORD_SECRET:-}`
- `.openpalm/stack/addons/slack/compose.yml` — `CHANNEL_SECRET: ${CHANNEL_SLACK_SECRET:-}`

---

### MF-4. Scheduler — missing MEMORY_AUTH_TOKEN, needs OPENCODE_API_URL + PASSWORD restored in spec

The compose is missing `MEMORY_AUTH_TOKEN`. Additionally, the updated spec removed `OPENCODE_API_URL` and `OPENCODE_SERVER_PASSWORD`, but the owner confirmed the scheduler still needs both (it sends prompts to the assistant for automation actions).

| Item | Authoritative Spec | Current Compose | Required State |
|------|-------------------|-----------------|----------------|
| `MEMORY_AUTH_TOKEN` | Listed | **Missing** | Add to compose |
| `OPENCODE_API_URL` | **Missing from spec** | Present (line 140) | Keep in compose, re-add to spec |
| `OPENCODE_SERVER_PASSWORD` | **Missing from spec** | Present (line 141) | Keep in compose, re-add to spec |
| Host port | **Missing from spec** | Present (line 144) | Remove from compose |

**Required compose change:**
```yaml
environment:
  # ADD:
  MEMORY_AUTH_TOKEN: ${OP_MEMORY_TOKEN:-}
  # KEEP (already present):
  OPENCODE_API_URL: http://assistant:4096
  OPENCODE_SERVER_PASSWORD: ${OP_OPENCODE_PASSWORD:-}
# REMOVE ports: block
```

**Required spec change** (see MF-9): re-add `OPENCODE_API_URL` and `OPENCODE_SERVER_PASSWORD` to scheduler key env in `foundations.md`.

---

### MF-5. Guardian — stack.env env_file should be replaced with guardian.env + GUARDIAN_SECRETS_PATH

**Owner decision:** Guardian loads `vault/stack/guardian.env` (containing `CHANNEL_<NAME>_SECRET` entries) both as an `env_file` and via `GUARDIAN_SECRETS_PATH` for hot-reload. Non-secret config (`OP_ADMIN_TOKEN`) stays in `environment:` via `${VAR}` substitution.

**Current compose (`core.compose.yml:105-107`):**
```yaml
env_file:
  - path: ${OP_HOME}/vault/stack/stack.env
    required: false
```

**Required compose change:**
```yaml
env_file:
  - path: ${OP_HOME}/vault/stack/guardian.env
    required: false
environment:
  # ... existing vars (OP_ADMIN_TOKEN already present via ${VAR}) ...
  GUARDIAN_SECRETS_PATH: /app/secrets/guardian.env
volumes:
  # ... existing volumes ...
  - ${OP_HOME}/vault/stack/guardian.env:/app/secrets/guardian.env:ro
```

**Compose invocation change:** The standard startup becomes three `--env-file` flags:
```
--env-file vault/stack/stack.env
--env-file vault/user/user.env
--env-file vault/stack/guardian.env
```

---

## Must-Fix: Authoritative Internal Consistency

These are places where the authoritative documents contradict themselves or the confirmed design decisions.

### MF-6. foundations.md Addon Edge Pattern says "load stack.env and user.env"

**Current text** (`foundations.md:333`):
> "load `stack.env` and `user.env`"

This contradicts:
- The vault boundary rule (`core-principles.md:109`)
- The addon secret lifecycle (`core-principles.md:237-246`)
- The confirmed design: channels get only their own HMAC secret via `${VAR}` substitution

**Required change:** Replace with:
> "receive their channel HMAC secret via `${VAR}` substitution from `vault/stack/guardian.env` (passed as a compose `--env-file`)"

---

### MF-7. foundations.md Guardian env sources doesn't mention guardian.env or GUARDIAN_SECRETS_PATH

**Current text** (`foundations.md:172-175`):
```
Env sources:
- `stack.env`
- direct compose env
```

**Required change:**
```
Env sources:
- direct compose `environment:` block (non-secret config via ${VAR} substitution)
- `vault/stack/guardian.env` as compose `env_file` (channel HMAC secrets)
- same file mounted at `GUARDIAN_SECRETS_PATH` for mtime-based hot-reload
```

---

### MF-8. foundations.md Memory env sources should acknowledge user.env via ${VAR}

**Current text** (`foundations.md:74-77`):
```
Env sources:
- `stack.env` (via compose ${VAR} substitution — includes OP_CAP_* resolved capabilities and raw API keys)
```

The memory compose maps `OP_CAP_LLM_*` and `OP_CAP_EMBEDDINGS_*` vars from `stack.env` to service-specific env var names via compose `environment:` block substitution.

**Status:** Resolved — all config consolidated in stack.env.

---

### MF-9. foundations.md Scheduler key env must re-add OPENCODE_API_URL + PASSWORD

**Current text** (`foundations.md:243-250`):
```
Key env:
- PORT=8090
- OP_HOME=/openpalm
- OP_ADMIN_TOKEN=${OP_ADMIN_TOKEN:-}
- OP_ADMIN_API_URL
- MEMORY_API_URL=http://memory:8765
- MEMORY_AUTH_TOKEN
```

**Owner decision:** Scheduler still talks to assistant. Re-add both vars.

**Required change — add:**
```
- OPENCODE_API_URL=http://assistant:4096
- OPENCODE_SERVER_PASSWORD
```

Also add below the scheduler ports section:
```
Ports and network:
- host: none
- container: 8090
- network: `assistant_net`
```

(Currently the spec has no port line and no container port listed, which could be misread as "no internal port".)

---

## Must-Fix: Authoritative — New Content Needed

### MF-10. core-principles.md: add backups/ as top-level directory

**Owner decision:** `OP_HOME/backups/` is a new top-level directory, distinct from `~/.cache/openpalm/rollback/`.

- **Rollback** (cache): auto-saved pre-deploy snapshots, auto-restored on failure, ephemeral
- **Backups** (OP_HOME): explicit upgrade backup snapshots, user-accessible, durable

**Implementation already exists** — the code actively creates and uses this directory:
- `packages/lib/src/control-plane/home.ts:63` — `resolveBackupsDir()` returns `${OP_HOME}/backups`
- `packages/lib/src/control-plane/home.ts:105-106` — directory created by `ensureDirectoryStructure()`
- `packages/lib/src/control-plane/core-assets.ts:145` — `refreshCoreAssets()` writes timestamped backup snapshots here before overwriting managed assets

**Required addition to core-principles.md after § 4 Logs (line 128):**
```markdown
### 6) Backups

**Location:** `~/.openpalm/backups/`
**Purpose:** durable upgrade backup snapshots created by lifecycle operations before destructive transitions.

**Rule:** CLI/admin writes backup snapshots here before upgrades and major lifecycle changes. These are user-accessible for manual restore and are included in `tar` backups of `~/.openpalm/`. Unlike rollback snapshots (in `~/.cache/openpalm/rollback/`), backups are durable and not automatically cleaned up.
```

**Required update to foundations.md filesystem tree (line 23-30):**
```
~/.openpalm/
├── config/     user-editable non-secret config
├── stack/      live compose assembly
├── vault/      secrets boundary
├── data/       durable service data
├── logs/       audit and debug logs
└── backups/    durable upgrade backup snapshots
```

---

### MF-11. core-principles.md/foundations.md: document three-env-file compose invocation

The standard compose invocation now uses three `--env-file` flags. This should be documented.

**Current text** (`core-principles.md:276`):
> "Compose is normally invoked with `vault/stack/stack.env` (system-managed) and `vault/user/user.env` (user-managed)"

**Required change:**
> "Compose is normally invoked with `vault/stack/stack.env` (system-managed: admin token, paths, UID/GID, image tags, bind ports, API keys, provider URLs), `vault/user/user.env` (empty placeholder for custom user extensions), and `vault/stack/guardian.env` (channel HMAC secrets)."

**Also update** the Compose env sources section in `foundations.md` (lines 36-43):
```
The standard startup path uses:
- `vault/stack/stack.env`
- `vault/user/user.env`
- `vault/stack/guardian.env`

Individual services may additionally load service-specific managed env files...
```

---

## Must-Fix: Shared Control-Plane Library

### MF-12. Admin registry install duplicates automation logic

**Location:** `packages/admin/src/routes/admin/registry/install/+server.ts` (lines 63-79)

Implements its own `mkdirSync`/`writeFileSync` instead of calling `installAutomationFromRegistry()` from `@openpalm/lib`. The uninstall route correctly uses lib's `uninstallAutomation()`.

**Authoritative rule** (`core-principles.md:173`):
> "No control-plane logic may be duplicated between consumers."

**Required change:** Refactor to call `installAutomationFromRegistry()` from lib.

---

### MF-14. Rollback scope implementation includes files outside authoritative contract

**Location:** `packages/lib/src/control-plane/rollback.ts:14-18`

The `SNAPSHOT_FILES` array includes files that the authoritative rollback scope section explicitly excludes:

```typescript
const SNAPSHOT_FILES = [
  "vault/user/user.env",    // ← VIOLATION: spec excludes vault/user/
  "vault/stack/stack.env",  // ← OK: spec includes vault/stack/
  "config/stack.yaml",      // ← VIOLATION: spec excludes config/
];
```

**Authoritative rule** (`core-principles.md:258-265`, § Rollback scope):
> The snapshot includes:
> - `stack/` — the full live compose assembly
> - `vault/stack/` — system-managed secrets and env files
>
> The snapshot does **not** include `config/` (user-owned, not modified by apply), `vault/user/` (never overwritten by lifecycle operations), or `data/` (service-owned runtime state).

The code also correctly snapshots `stack/core.compose.yml` and `stack/addons/*/compose.yml` (lines 45-60), which aligns with the spec.

**Required change:**
```typescript
const SNAPSHOT_FILES = [
  "vault/stack/stack.env",
  "vault/stack/guardian.env",   // add after MF-5 creates this file
];
```

Remove `vault/user/user.env` (user-owned, never overwritten) and `config/stack.yaml` (user-owned config) from the snapshot list. The `stack/` directory snapshots (compose files) are handled separately and are already correct.

---

## Must-Fix: CLAUDE.md

### MF-13. Vault boundary description contradicts authoritative spec

**Current text** (`CLAUDE.md:165`):
```
- **`vault/` boundary.** Only admin mounts full `vault/` (rw). Assistant mounts only
  `vault/user/user.env` (ro). No other container mounts vault. Guardian/scheduler
  get secrets via `${VAR}` substitution only.
```

**Corrected text:**
```
- **`vault/` boundary.** Only admin mounts full `vault/` (rw). Assistant mounts
  `vault/user/` directory (rw) to `/etc/vault/`. No other container mounts anything
  from vault. Guardian loads `vault/stack/guardian.env` as env_file (channel HMAC
  secrets with hot-reload via GUARDIAN_SECRETS_PATH). Scheduler, memory, and channels
  get secrets via `${VAR}` substitution only. Channels receive only their own HMAC
  secret.
```

---

## Should-Fix Items

### SF-1. Non-authoritative docs: cascade all corrections

After implementing compose changes and authoritative doc updates, cascade to:

| File | Changes |
|------|---------|
| `docs/technical/directory-structure.md` | vault/user/ -> /etc/vault/ (rw); data/assistant -> /home/opencode/; move data/backups/ to top-level OP_HOME/backups/; add guardian.env to vault tree |
| `docs/technical/environment-and-mounts.md` | Same mount corrections; update memory env sources to acknowledge user.env via ${VAR}; update scheduler env vars (add MEMORY_AUTH_TOKEN, keep OPENCODE_API_URL + PASSWORD, remove host port); update guardian env model |

---

### SF-2. Missing setup wizard port in CLAUDE.md

`foundations.md:364` documents the setup wizard port (`127.0.0.1:8190`, `OP_SETUP_PORT`). CLAUDE.md does not mention this.

---

### SF-3. Unused OP_GUARDIAN_PORT in stack.env generation

`packages/lib/src/control-plane/stack-spec.ts` generates `OP_GUARDIAN_PORT=3899`. Guardian is internal-only with no host port. No compose file references it. Remove from `SPEC_DEFAULTS` or document as reserved.

---

### SF-4. Scheduler port variable in SPEC_DEFAULTS

After MF-4 removes the scheduler's host port from compose, verify whether `OP_SCHEDULER_PORT` should also be removed from `SPEC_DEFAULTS` in `stack-spec.ts`.

---

## Fully Compliant Areas

### Docker Dependency Resolution
- **Admin:** `npm install` at workspace root, no Bun in build, self-contained adapter-node output
- **Guardian:** channels-sdk copied then `bun install --production`
- **Channel:** channels-sdk copied then `bun install --production`
- **Memory:** memory package copied then `bun install --production`
- **Scheduler:** lib copied then `bun install --production`

### Docker Compose (structure)
- All 4 core services: memory, assistant, guardian, scheduler
- Networks: `assistant_net`, `channel_lan`, `channel_public`, `admin_docker_net`
- Port defaults match authoritative table (where applicable)
- Guardian correctly has no host port
- All host bindings default to `127.0.0.1`
- Healthchecks on all services
- Addon metadata labels compliant

### Security Invariants (status after all fixes)
- **Invariant 1 (Host orchestrator):** PASS — only docker-socket-proxy mounts Docker socket
- **Invariant 2 (Guardian-only ingress):** PASS — channels on channel_lan only, guardian sole bridge
- **Invariant 3 (Assistant isolation):** PASS after MF-1 + MF-2
- **Invariant 4 (Host-only default):** PASS after MF-3

### Assistant Container
- Core extensions baked at `/etc/opencode`
- `OPENCODE_CONFIG_DIR=/etc/opencode` correctly set
- User extensions at `config/assistant/ -> /home/opencode/.config/opencode`
- Provider-key pruning in entrypoint
- SSH hardened, gated by `OPENCODE_ENABLE_SSH=1`
- Varlock dual-layer redaction
- assistant-tools: memory tools; admin-tools: admin API tools (conditional)

### Shared Control-Plane Library (after MF-12)
- All lifecycle ops flow through `@openpalm/lib`
- Admin `docker.ts` is thin wrapper
- CLI delegates to lib
- Scheduler uses `loadAutomations()` + `executeAction()` from lib
- Guardian has zero lib imports

### New Authoritative Content (verified correct)
- Addon secret lifecycle (`core-principles.md:237-246`)
- Addon conflict detection (`core-principles.md:250-254`)
- Rollback scope (`core-principles.md:258-267`)
- Data write policy (`core-principles.md:120`)

---

## Implementation Order

1. **MF-1 + MF-2** — Compose mount corrections (assistant vault + data). Test with dev stack.
2. **MF-3 + MF-5** — Channel vault fix + guardian env_file migration to `guardian.env`. Create `vault/stack/guardian.env`, update compose invocation to three `--env-file` flags. Verify channels sign correctly and guardian hot-reload works.
3. **MF-4** — Scheduler: add MEMORY_AUTH_TOKEN, remove host port. Keep OPENCODE_API_URL + PASSWORD.
4. **MF-14** — Rollback scope: remove `vault/user/user.env` and `config/stack.yaml` from `SNAPSHOT_FILES`, add `vault/stack/guardian.env`. Run lib tests.
5. **MF-6 through MF-11** — Authoritative doc fixes (addon edge pattern, guardian env, memory env, scheduler env, backups dir, three-env-file invocation).
6. **MF-12** — Admin registry install lib extraction. Run admin tests.
7. **MF-13 + SF-1 through SF-4** — CLAUDE.md + non-authoritative doc cascade.
