# Authoritative Documentation Alignment Audit

**Branch:** `release/0.10.0`
**Date:** 2026-03-22
**Scope:** Compare all implementation and non-authoritative docs against `docs/technical/authoritative/`

---

## Summary

| Category | Status | Critical Issues | Warnings |
|----------|--------|-----------------|----------|
| Compose files & ports | PASS | 0 | 1 |
| Security invariants | **FAIL** | 2 | 1 |
| Docker dependency resolution | PASS | 0 | 0 |
| Shared control-plane (lib) | PASS | 0 | 1 |
| Assistant container & extensions | PASS | 0 | 2 |
| Non-authoritative doc drift | **FAIL** | 2 | 2 |
| CLAUDE.md drift | **FAIL** | 1 | 1 |

**Total: 5 critical issues, 8 warnings/minor items**

---

## 1. CRITICAL: Authoritative Spec vs Actual Implementation Mismatch

The authoritative `foundations.md` documents mount paths that **do not match** what the compose file actually implements. This is the most important finding — the authoritative source of truth is out of sync with the running system.

### 1a. Assistant vault/user mount path

| Source | Value |
|--------|-------|
| **Authoritative** (`foundations.md:135`) | `$OP_HOME/vault/user/ -> /etc/vault/` |
| **Actual compose** (`core.compose.yml:78`) | `$OP_HOME/vault/user/user.env:/etc/openpalm-vault/user.env:ro` |

**Discrepancy:** The authoritative doc says the **entire directory** is mounted to `/etc/vault/`. The compose mounts only the **single file** `user.env` to `/etc/openpalm-vault/user.env` with read-only access.

### 1b. Assistant data mount path

| Source | Value |
|--------|-------|
| **Authoritative** (`foundations.md:129`) | `$OP_HOME/data/assistant -> /home/opencode/` |
| **Actual compose** (`core.compose.yml:79`) | `$OP_HOME/data/assistant:/home/opencode/data` |

**Discrepancy:** The authoritative doc says data mounts to the assistant's entire HOME directory `/home/opencode/`. The compose mounts it to a subdirectory `/home/opencode/data`.

### 1c. Assistant vault/user mount permissions (rw vs ro)

| Source | Value |
|--------|-------|
| **Authoritative** (`core-principles.md:61`) | `vault/user/user.env (rw)` — explicitly states read-write |
| **Authoritative** (`core-principles.md:100`) | "assistant mounts only `vault/user/` (rw)" |
| **Actual compose** (`core.compose.yml:78`) | `:ro` — read-only |

**Discrepancy:** The authoritative spec says the assistant gets **read-write** access to vault/user for hot-reload. The compose implements **read-only**. The hot-reload described in the spec ("Editing `user.env` on the host takes effect within seconds") still works because the file watcher detects host-side edits even through a read-only bind mount, so this may be intentional tightening. However the spec needs updating.

**Recommendation:** Either update the authoritative docs to match the compose, or update the compose to match the spec. The compose implementation (file-only, read-only) is arguably more secure and should probably become the documented standard.

---

## 2. CRITICAL: Vault Boundary Violation — Channels Load Vault Files

### Description

All channel addon compose files (`chat`, `api`, `voice`, `discord`, `slack`) load both `vault/stack/stack.env` and `vault/user/user.env` as `env_file` entries.

**Authoritative rule** (`core-principles.md:109`):
> "No container except admin may mount `vault/` as a directory. The assistant receives only a bind mount of `vault/user/`. **Guardian, scheduler, and memory receive secrets exclusively through `${VAR}` substitution** at container creation time and an optional service-specific .env file."

Channels are not mentioned in the authorized list. Loading vault env files gives channels access to:
- `OP_ADMIN_TOKEN` (admin authentication)
- `OP_ASSISTANT_TOKEN` (assistant authentication)
- `OP_MEMORY_TOKEN` (memory service auth)
- `CHANNEL_*_SECRET` (HMAC secrets — channels should know only their own)
- All user LLM API keys from `user.env`

### Affected files

| File | Lines |
|------|-------|
| `.openpalm/stack/addons/chat/compose.yml` | 6-10 |
| `.openpalm/stack/addons/api/compose.yml` | 6-10 |
| `.openpalm/stack/addons/voice/compose.yml` | 6-10 |
| `.openpalm/stack/addons/discord/compose.yml` | 6-10 |
| `.openpalm/stack/addons/slack/compose.yml` | 6-10 |

### Recommended fix

Channels should receive only their specific required variables via `${VAR}` substitution in compose `environment:` blocks, not by loading the full vault env files. If a channel needs its HMAC secret, it should be passed as a single explicit env var, not by loading the file that contains all secrets.

---

## 3. CRITICAL: CLAUDE.md Contains Contradictions with Authoritative Spec

### 3a. Vault boundary description is wrong

**CLAUDE.md line 165:**
> "Assistant mounts only `vault/user/user.env` (ro). No other container mounts vault. Guardian/scheduler get secrets via `${VAR}` substitution only."

**Authoritative** (`core-principles.md:100`):
> "assistant mounts only `vault/user/` (rw)"

CLAUDE.md says `user.env` file specifically (matching compose), but says `ro` (matching compose) while authoritative says `rw`. CLAUDE.md omits that memory also loads vault env files. And the statement "No other container mounts vault" is violated by the channel addons loading vault env files (see item 2).

### 3b. Missing setup wizard port

The authoritative `foundations.md:362` documents the setup wizard port (`127.0.0.1:8190`, configurable via `OP_SETUP_PORT`). CLAUDE.md does not mention this.

---

## 4. WARNING: Non-Authoritative Documentation Drift

### 4a. `docs/technical/directory-structure.md`

| Issue | Detail |
|-------|--------|
| Lists `data/backups/` directory | Not documented in authoritative `core-principles.md` data subtrees (which list: assistant/, admin/, memory/, guardian/, stash/, workspace/) |
| Mount paths | Uses compose-accurate paths (`/home/opencode/data`, `/etc/openpalm-vault/user.env:ro`) which are correct but conflict with authoritative `foundations.md` |

### 4b. `docs/technical/environment-and-mounts.md`

| Issue | Detail |
|-------|--------|
| Mount paths | Uses compose-accurate paths, conflicting with authoritative spec |
| Vault/user description | Shows file-level mount (correct vs compose) but doesn't align with authoritative directory-level mount description |

**Root cause:** The non-authoritative docs were updated to match the actual implementation while the authoritative docs were not. The authoritative docs are now the ones that are wrong.

---

## 5. WARNING: Control-Plane Library Minor Violation

### Admin registry install duplicates automation logic

**Location:** `packages/admin/src/routes/admin/registry/install/+server.ts` (lines 63-79)

The admin registry install route implements its own automation file-writing logic (`mkdirSync`, `writeFileSync`) instead of calling the canonical `installAutomationFromRegistry()` function from `@openpalm/lib`.

**Authoritative rule** (`core-principles.md:173`):
> "All portable control-plane logic lives in `packages/lib/`. No control-plane logic may be duplicated between consumers."

The lib function exists and is used by the uninstall route, but the install route duplicates it.

---

## 6. WARNING: Unused Guardian Port Variable

**Location:** `packages/lib/src/control-plane/stack-spec.ts`

The code generates `OP_GUARDIAN_PORT=3899` and writes it to `stack.env`. The guardian is documented as internal-only with no host port binding. No compose file references this variable.

Not a violation, but unnecessary state generation that could confuse users inspecting `stack.env`.

---

## 7. PASS: Areas Fully Compliant

### Docker Compose (ports, networks, services)
- All 4 core services present: memory, assistant, guardian, scheduler
- All 3 networks correct: assistant_net, channel_lan, admin_docker_net
- All port defaults match authoritative table (assistant:3800, admin:3880, memory:3898, scheduler:3897, chat:3820, api:3821, voice:3810)
- Guardian correctly has no host port
- All host bindings default to `127.0.0.1`
- Healthchecks present on all services
- Addon metadata labels compliant

### Docker Dependency Resolution
- Admin Dockerfile: `npm install` at workspace root, no Bun in build stage
- Guardian Dockerfile: channels-sdk copied then `bun install --production`
- Channel Dockerfile: channels-sdk copied then `bun install --production`
- Memory Dockerfile: memory package copied then `bun install --production`
- Scheduler Dockerfile: lib copied then `bun install --production`

### Security Invariants (3 of 4 pass)
- **Invariant 1 (Host orchestrator):** PASS — only docker-socket-proxy mounts Docker socket
- **Invariant 2 (Guardian-only ingress):** PASS — all channels on channel_lan only, guardian is sole bridge to assistant_net
- **Invariant 3 (Assistant isolation):** PASS with mount path documentation issues (see item 1)
- **Invariant 4 (Host-only default):** PASS for port bindings; **FAIL** for vault boundary (see item 2)

### Assistant Container
- Core extensions baked at `/etc/opencode` via Dockerfile
- `OPENCODE_CONFIG_DIR=/etc/opencode` set correctly
- User extensions mount at `config/assistant/ -> /home/opencode/.config/opencode`
- Provider-key pruning implemented in entrypoint
- SSH hardened and gated by `OPENCODE_ENABLE_SSH=1`
- Varlock dual-layer redaction (process + shell level)
- assistant-tools plugin provides memory tools
- admin-tools plugin provides admin API tools (conditional on admin presence)

### Shared Control-Plane Library
- All lifecycle operations (install/update/upgrade/uninstall) flow through `@openpalm/lib`
- Admin docker.ts is a thin wrapper with preflight enforcement
- CLI delegates to lib for all control-plane ops
- Scheduler uses only `loadAutomations()` and `executeAction()` from lib
- Guardian has zero lib imports (correct — pure HTTP handler)

---

## Action Items

### Must Fix (Critical)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Authoritative `foundations.md` vault/user mount path wrong | Update line 135: `$OP_HOME/vault/user/ -> /etc/vault/` to `$OP_HOME/vault/user/user.env -> /etc/openpalm-vault/user.env:ro` |
| 2 | Authoritative `foundations.md` data/assistant mount path wrong | Update line 129: `$OP_HOME/data/assistant -> /home/opencode/` to `$OP_HOME/data/assistant -> /home/opencode/data` |
| 3 | Authoritative `core-principles.md` says vault/user is rw | Update to `:ro` to match compose, or change compose to `:rw` to match spec. Decide which is correct. |
| 4 | Channel addons load vault env files | Remove `env_file` entries from all channel composes; pass only needed vars via `environment:` + `${VAR}` substitution |
| 5 | CLAUDE.md vault boundary description contradicts authoritative | Update to match whichever direction items 3-4 resolve |

### Should Fix (Warnings)

| # | Issue | Fix |
|---|-------|-----|
| 6 | Admin registry install duplicates lib automation logic | Refactor to call `installAutomationFromRegistry()` from lib |
| 7 | `data/backups/` in directory-structure.md not in authoritative | Either add to authoritative or remove from directory-structure.md |
| 8 | Unused `OP_GUARDIAN_PORT` in stack.env generation | Remove from SPEC_DEFAULTS or document as reserved |
| 9 | Non-authoritative docs use compose paths conflicting with authoritative | After fixing authoritative docs (items 1-3), cascade changes to directory-structure.md and environment-and-mounts.md |
| 10 | Missing setup wizard port in CLAUDE.md | Add `OP_SETUP_PORT` / `:8190` to CLAUDE.md |
