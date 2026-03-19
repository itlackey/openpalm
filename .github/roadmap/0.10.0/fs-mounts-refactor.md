# OpenPalm Stack Review: Mounts, Secrets & Simplification Proposal

**Version:** 3 — Final
**Date:** 2026-03-19

---

## TLDR

The current stack spreads state across 3 XDG directories, 30+ host subdirectories, ~20 bind mounts, and a 3-file env chain (secrets.env → stack.env → staged copies). This is architecturally correct but operationally heavy for a single-user self-hosted assistant.

**Simplification — six decisions:**

1. **Single root `~/.openpalm/`** — collapse 3 XDG trees into one. `config/` for user-editable non-secret config, `data/` for service-managed persistent data, `vault/` for all secrets, `logs/` for audit/debug output.

2. **Vault directory for secrets** — `vault/` holds `user.env` (user-editable, hot-reloadable), `system.env` (system-managed, never mounted into most containers), `ov.conf`, and their schemas. The admin mounts `vault/` read-write. The assistant mounts only `vault/user.env` read-only. All other containers get secrets exclusively via `${VAR}` substitution at creation time.

3. **Two env files, hard filesystem boundary** — `user.env` is for LLM keys, provider URLs, and other user-provided values. `system.env` is for admin token, HMAC secrets, paths, UID/GID, image tags. No comment separator to respect — they're different files with different access rules.

4. **Validate-in-place with snapshot rollback** — replace the staging tier with pre-write validation and a thin `~/.cache/openpalm/rollback/` directory holding previous known-good copies. Apply writes live files only after validation passes. Rollback is explicit and automated on failure.

5. **Hot-reload via mounted `user.env`** — the assistant picks up new LLM keys within seconds via file watcher. No restart, no lost context. Only the assistant and admin mount this file.

6. **Guardian restarts on channel install** — no bind-mounted secrets file. HMAC secrets come from `${VAR}` substitution only. Installing a channel triggers a guardian recreate (~2 seconds).

---

## Part 1: Current State Audit

### 1.1 Host Directory Inventory

The installer (`ensureXdgDirs`) pre-creates **31 directories** across three XDG roots:

```
CONFIG_HOME (~/.config/openpalm/)          — 5 subdirs
DATA_HOME   (~/.local/share/openpalm/)     — 9 subdirs
STATE_HOME  (~/.local/state/openpalm/)     — 5 subdirs
+ WORK_DIR  (~/openpalm/)                  — 1 dir
+ bin dir   (STATE_HOME/bin/)              — 1 dir
```

The cognitive load is high: `find ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm -type d` produces 20+ lines across three filesystem subtrees. `ls ~/.local/share/openpalm` alone shows: admin, assistant, automations, caddy, guardian, memory, opencode, plus schema files and env files. Many subdirectories exist solely to pre-create ownership before a container writes to them.

### 1.2 Bind Mount Inventory

Across the core compose file and admin overlay, there are **~21 unique bind mounts**:

| Container | Mounts | Notes |
|-----------|--------|-------|
| **memory** | 2 | data dir + config json |
| **assistant** | 6 | system config, user config, state, data, workdir, stash |
| **guardian** | 3 | data, audit log, secrets file |
| **scheduler** | 2 | automations (ro), artifacts (ro) |
| **caddy** | 4 | caddyfile, channels, data, config |
| **docker-socket-proxy** | 1 | docker.sock |
| **admin** | 3 | full CONFIG_HOME, DATA_HOME, STATE_HOME trees |

The assistant container is the most complex at 6 mounts, splitting OpenCode's XDG layout across two different host tiers (DATA_HOME for system config, CONFIG_HOME for user extensions, STATE_HOME for logs, DATA_HOME again for opencode data).

### 1.3 Secret & Env File Chain

Secrets flow through a **3-hop pipeline**:

1. **User edits** `CONFIG_HOME/secrets.env` (admin token, LLM keys)
2. **System generates** `DATA_HOME/stack.env` (paths, UID/GID, image tags, channel HMAC secrets)
3. **Admin stages copies** of both into `STATE_HOME/artifacts/` — these staged copies are what Docker Compose actually reads

Additionally:

- The guardian loads `stack.env` both via `env_file:` (at startup) AND via bind mount for runtime re-reads
- The admin loads BOTH staged env files via `env_file:` AND receives many of the same values via explicit `environment:` blocks
- LLM provider keys appear in `secrets.env`, get staged, then get explicitly passed through to 3 containers — each listing all 5 provider keys individually
- `OPENAI_API_KEY` appears in secrets.env, staged secrets.env, and the `environment:` blocks of assistant, memory, and admin
- The guardian receives LLM API keys via `env_file:` that it never uses
- The admin receives channel HMAC secrets via `env_file:` that it doesn't need for most operations

### 1.4 The Staging Tier Problem

The STATE_HOME "assembled runtime" tier exists so that CONFIG_HOME remains a clean user-owned source of truth and services never read directly from user-editable files. The implementation cost is high:

- Every config change requires an explicit "apply" that copies files between directories
- The admin container must mount all three XDG trees to perform the copy
- The admin uses identical host-to-container paths (e.g., `~/.config/openpalm` maps to `~/.config/openpalm` inside the container) — a clever but fragile pattern
- `manifest.json` tracks checksums of staged artifacts — infrastructure to maintain the staging layer itself
- Backup requires archiving 2 directories (CONFIG + DATA), restore requires the admin to regenerate STATE
- No automated rollback exists if a staged apply breaks the stack

For a single-user stack where the "user" and "admin" are the same person, the staging layer adds ceremony without meaningful safety gain.

---

## Part 2: Directory Layout

### 2.1 Proposed Filesystem Structure

```
$HOME/.openpalm/                             Root of all OpenPalm state
├── config/                                  User-editable, non-secret configuration
│   │                                        Mounts to assistant, admin at /etc/openpalm
│   ├── openpalm.yml                         Stack-level config: enabled components,
│   │                                        feature flags, stack name
│   ├── components/                          Compose overlays (one per component)
│   │   ├── core.yml                         Base stack (memory, assistant, guardian)
│   │   ├── admin.yml                        Admin overlay (caddy, socket-proxy, admin UI)
│   │   ├── channel-slack.yml                Channel overlays installed from registry
│   │   ├── channel-discord.yml                or manually dropped in
│   │   └── ...
│   ├── automations/                         Mounts to scheduler at /automations
│   │   ├── daily-briefing.yml
│   │   ├── health-check.yml
│   │   └── ...
│   └── assistant/                           User OpenCode extensions (tools, plugins, skills)
│       ├── opencode.json
│       ├── tools/
│       ├── plugins/
│       └── skills/
│
├── vault/                                   All secrets and secret-adjacent config
│   │                                        Admin mounts entire vault/ rw
│   │                                        Assistant mounts only vault/user.env ro
│   ├── user.env                             User-editable secrets: LLM keys, provider URLs
│   ├── user.env.schema                      Varlock schema for user.env
│   ├── system.env                           System-managed: admin token, HMAC secrets,
│   │                                        paths, UID/GID, image tags, memory auth token
│   ├── system.env.schema                    Varlock schema for system.env
│   └── ov.conf                              OpenViking / secrets backend config
│
├── data/                                    Service-managed persistent data
│   ├── assistant/                           Mounts to assistant at $HOME/.opencode
│   ├── admin/                               Mounts to admin at $HOME/.node (or similar)
│   ├── memory/                              Mounts to memory at /data
│   ├── guardian/                            Mounts to guardian at /app/data
│   ├── caddy/                               Caddy TLS certs, runtime config, Caddyfile
│   ├── stash/                               Mounts to assistant at ~/.akm
│   └── workspace/                           Mounts to assistant, admin at /work
│
└── logs/                                    Audit and debug logs
    ├── guardian-audit.log
    ├── admin-audit.jsonl
    └── opencode/                            OpenCode state/session logs


$HOME/.cache/openpalm/                       Ephemeral / regenerable cache
├── registry/                                Mounts to assistant, admin at /cache/registry
│                                            Cached extension/channel registry index
└── rollback/                                Previous known-good config snapshots
    ├── user.env
    ├── system.env
    ├── openpalm.yml
    ├── core.yml
    ├── admin.yml
    └── Caddyfile
```

### 2.2 Design Rationale

**`~/.openpalm/` as root.** Dot-prefixed so it doesn't clutter `ls ~` but is still easily accessible via `cd ~/.openpalm`. Everything that needs backing up or survives a reinstall lives here. One `tar` command archives the full stack.

**`config/` is non-secret.** Compose overlays, automations, OpenCode extensions, and the stack config file. Safe to mount broadly into assistant and admin at `/etc/openpalm`. Nothing in here requires access control.

**`vault/` is the secrets boundary.** Everything with a secret value lives here — `user.env`, `system.env`, `ov.conf`, and their schemas. The directory has strict mount rules: admin gets full read-write access, assistant gets only `vault/user.env` read-only, and no other container mounts anything from `vault/`. Guardian, scheduler, memory, and caddy receive secrets exclusively through `${VAR}` substitution at container creation time.

**`data/` is service-owned.** Each container has its own subdirectory. `stash/` lives here as the shared AKM asset directory (mounted into assistant at `~/.akm`). `workspace/` is the assistant's working directory for user projects.

**`logs/` consolidates all log output.** Guardian audit log, admin audit log, and OpenCode session logs all live in one browsable location.

**`~/.cache/openpalm/` is ephemeral.** Registry cache and rollback snapshots. Can be deleted without data loss — the cache rebuilds on next access, and rollback snapshots are only needed during apply operations. Follows XDG convention for cache data that doesn't need backing up.

### 2.3 `openpalm.yml` — Stack Configuration

A human-readable YAML file that defines what components are enabled and stack-level settings:

```yaml
# ~/.openpalm/config/openpalm.yml
name: my-assistant
version: 1

components:
  admin: true
  ollama: false

features:
  ssh: false
  voice: false

network:
  ingress_bind: 127.0.0.1
  ingress_port: 8080
```

The CLI/admin reads this file to determine which compose overlays to include in the compose invocation and which features to enable. It's user-editable and never overwritten by upgrades (only seeded with defaults on first install).

---

## Part 3: Secret Management

### 3.1 Two Env Files with Hard Filesystem Boundary

**`vault/user.env`** — user-editable, mounted read-only into assistant:

```env
# LLM Provider Configuration
# ──────────────────────────────────────────────────────────────────
# Edit these values directly. The assistant picks up changes within
# seconds via file watcher — no restart needed.

OPENAI_API_KEY=
OPENAI_BASE_URL=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=
GOOGLE_API_KEY=

# System LLM (used for memory categorization, etc.)
SYSTEM_LLM_PROVIDER=
SYSTEM_LLM_BASE_URL=
SYSTEM_LLM_MODEL=

# Embedding
EMBEDDING_MODEL=
EMBEDDING_DIMS=

# Memory
MEMORY_USER_ID=default_user

# Owner
OWNER_NAME=
OWNER_EMAIL=
```

**`vault/system.env`** — system-managed, never mounted except by admin:

```env
# System-managed — written by CLI/admin. Do not edit manually.
# ──────────────────────────────────────────────────────────────────

# Authentication
OPENPALM_ADMIN_TOKEN=

# Paths
OPENPALM_HOME=/home/user/.openpalm
OPENPALM_UID=1000
OPENPALM_GID=1000
OPENPALM_DOCKER_SOCK=/var/run/docker.sock

# Images
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=v0.9.2

# Service Auth
MEMORY_AUTH_TOKEN=
OPENCODE_SERVER_PASSWORD=

# Channel HMAC Secrets
CHANNEL_CHAT_SECRET=
CHANNEL_DISCORD_SECRET=
CHANNEL_SLACK_SECRET=

# Setup
OPENPALM_SETUP_COMPLETE=true
```

**Why two files instead of one:**

- Hard access boundary. The assistant can read `user.env` (it's mounted) but cannot access `system.env` (it's not). No reliance on comment separators.
- Clear ownership. Users know they own `user.env` and shouldn't touch `system.env`. The schemas enforce this — `system.env.schema` can flag everything as `@required` with no user action needed.
- Docker Compose reads both host-side. The compose invocation uses `--env-file vault/system.env --env-file vault/user.env` to resolve all `${VAR}` references. Neither file is mounted into containers that don't need it.

### 3.2 Per-Container Secret Access

| Container | `vault/` mount | `${VAR}` from system.env | `${VAR}` from user.env | What it sees |
|-----------|---------------|--------------------------|------------------------|-------------|
| **assistant** | `vault/user.env` → `/etc/openpalm/user.env` (ro) | `MEMORY_AUTH_TOKEN` | — | LLM keys (via file), memory token (via env) |
| **admin** | `vault/` → `/etc/openpalm/vault/` (rw) | everything it needs | everything it needs | Full access — it manages both files |
| **guardian** | none | `OPENPALM_ADMIN_TOKEN`, `CHANNEL_*_SECRET` | — | Admin token + HMAC secrets only |
| **memory** | none | `MEMORY_AUTH_TOKEN` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Memory auth + embedding provider only |
| **scheduler** | none | `OPENPALM_ADMIN_TOKEN` | — | Admin token only |
| **caddy** | none | — | — | No secrets (TLS config is file-based) |

Each container's compose `environment:` block is the explicit allowlist. The vault mount rules add a second layer: even if a container's `environment:` block references a variable, it can only read the file if it has a mount.

### 3.3 Hot-Reload via Mounted `user.env`

The assistant's entrypoint includes a file watcher:

```typescript
import { watch, readFileSync } from 'fs';

const ALLOWED_KEYS = new Set([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_API_KEY',
  'SYSTEM_LLM_PROVIDER', 'SYSTEM_LLM_BASE_URL', 'SYSTEM_LLM_MODEL',
  'EMBEDDING_MODEL', 'EMBEDDING_DIMS',
]);

function loadUserEnv() {
  try {
    const content = readFileSync('/etc/openpalm/user.env', 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && ALLOWED_KEYS.has(match[1])) {
        process.env[match[1]] = match[2];
      }
    }
  } catch { /* file not yet available */ }
}

loadUserEnv();
watch('/etc/openpalm/user.env', () => loadUserEnv());
```

The user flow for adding a key mid-session:

1. Open `~/.openpalm/vault/user.env` in any editor
2. Add `ANTHROPIC_API_KEY=sk-ant-...` and save
3. The assistant picks it up within seconds
4. No restart, no lost context, no CLI command needed

### 3.4 Channel HMAC Secret Handling

Channel HMAC secrets live in `vault/system.env`. They are:

1. Auto-generated by the admin/CLI when a channel is installed
2. Written to `system.env`
3. Injected into the guardian via `${VAR}` substitution at container creation

When a new channel is installed, the apply command writes the new secret to `system.env`, adds the `CHANNEL_<n>_SECRET: ${CHANNEL_<n>_SECRET}` entry to the guardian's `environment:` block in the channel's compose overlay, and recreates the guardian. This takes ~2 seconds and is a rare operation.

### 3.5 Compose Invocation

Docker Compose reads both env files host-side for variable substitution:

```bash
docker compose \
  --env-file ~/.openpalm/vault/system.env \
  --env-file ~/.openpalm/vault/user.env \
  -f ~/.openpalm/config/components/core.yml \
  -f ~/.openpalm/config/components/admin.yml \
  -f ~/.openpalm/config/components/channel-slack.yml \
  up -d
```

The CLI builds this command from `openpalm.yml` (which components are enabled) and the contents of `config/components/`. Users never need to type this — `openpalm start` handles it.

---

## Part 4: Validation & Rollback

### 4.1 Rollback Location

Rollback snapshots live in `~/.cache/openpalm/rollback/` — the XDG cache directory. This is appropriate because:

- Rollback data is regenerable (it's a copy of the previous live files)
- It doesn't need to be backed up
- It can be deleted without breaking the stack
- It's separate from the main `~/.openpalm/` tree, so a `tar` backup of `~/.openpalm/` doesn't include stale rollback data

### 4.2 Apply Flow

```
1. VALIDATE   — check proposed changes before writing anything
                 • varlock validates proposed user.env against user.env.schema (temp copy)
                 • varlock validates proposed system.env against system.env.schema (temp copy)
                 • docker compose config --dry-run validates proposed compose files
                 • caddy validate checks proposed Caddyfile
                 → if ANY check fails: abort, nothing touched, user gets error

2. SNAPSHOT   — copy current live files to ~/.cache/openpalm/rollback/
                 • user.env, system.env, openpalm.yml, component YAMLs, Caddyfile
                 • ~5-10 small files, a few KB total

3. WRITE      — write validated changes to live locations
                 • update vault/system.env with new system-managed values
                 • merge channel Caddy routes into data/caddy/channels/
                 • update data/caddy/Caddyfile if routes changed

4. DEPLOY     — docker compose up -d, caddy reload
                 → if services fail health checks: proceed to ROLLBACK

5. ROLLBACK   — copy ~/.cache/openpalm/rollback/ files back to live positions
   (on fail)    • docker compose up -d with restored files
                • caddy reload with restored Caddyfile
                • report what went wrong to the user
```

Validation runs against temp files — proposed changes are assembled in memory or `/tmp`, validated, and only written to live paths after all checks pass. This preserves the safety of the staging model without a permanent staging directory.

### 4.3 Rollback as First-Class Operation

```bash
openpalm rollback
```

This command restores the most recent snapshot from `~/.cache/openpalm/rollback/` and restarts the stack. It's available as both an automated response to failed deploys and a manual escape hatch.

---

## Part 5: Mount Map

### 5.1 Complete Mount Table

All host paths are relative to `~/.openpalm/` unless noted.

**Assistant:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `config/` | `/etc/openpalm` | ro | Non-secret stack config, extensions |
| `config/assistant/` | `/home/opencode/.config/opencode` | rw | User OpenCode extensions |
| `vault/user.env` | `/etc/openpalm/user.env` | ro | Hot-reload LLM keys and provider config |
| `data/assistant/` | `/home/opencode/.opencode` | rw | OpenCode data + system config |
| `data/stash/` | `/home/opencode/.akm` | rw | AKM shared stash |
| `data/workspace/` | `/work` | rw | Working directory |
| `logs/opencode/` | `/home/opencode/.local/state/opencode` | rw | OpenCode state/logs |
| `~/.cache/openpalm/registry/` | `/cache/registry` | rw | Cached registry index |

**Admin:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `config/` | `/etc/openpalm` | rw | Stack config (admin manages components) |
| `vault/` | `/etc/openpalm/vault` | rw | Full secrets access (read + write both env files) |
| `data/admin/` | `/home/node` | rw | Admin runtime home |
| `data/workspace/` | `/work` | rw | Shared working directory |
| `~/.cache/openpalm/registry/` | `/cache/registry` | rw | Cached registry index |

**Guardian:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `data/guardian/` | `/app/data` | rw | Guardian runtime data |
| `logs/` | `/app/audit` | rw | Audit log output |

**Memory:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `data/memory/` | `/data` | rw | SQLite + sqlite-vec persistent data |

**Scheduler:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `config/automations/` | `/automations` | ro | Automation YAML files |

**Caddy:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `data/caddy/Caddyfile` | `/etc/caddy/Caddyfile` | ro | Caddy config |
| `data/caddy/channels/` | `/etc/caddy/channels` | ro | Channel route snippets |
| `data/caddy/data/` | `/data/caddy` | rw | TLS certs + state |

**Docker Socket Proxy:**

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| `$OPENPALM_DOCKER_SOCK` | `/var/run/docker.sock` | ro | Docker daemon socket |

### 5.2 Mount Count Summary

| Container | Current | Proposed |
|-----------|---------|----------|
| assistant | 6 | 8 |
| admin | 3 | 5 |
| guardian | 3 | 2 |
| memory | 2 | 1 |
| scheduler | 2 | 1 |
| caddy | 4 | 3 |
| docker-socket-proxy | 1 | 1 |
| **Total** | **~21** | **~21** |

The total count is comparable, but the security properties are fundamentally different. In the current design, `env_file:` bulk-injects all secrets into guardian and admin, and the guardian bind-mounts the full `stack.env`. In the proposed design, no container except admin can access `system.env`, and the only mounted secrets file is `user.env` (LLM keys) into the assistant.

---

## Part 6: Backup, Restore & Upgrade

### 6.1 Backup

```bash
docker compose down
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz ~/.openpalm
docker compose up -d
```

One directory. One command. The `~/.cache/openpalm/` directory is intentionally excluded — it's regenerable cache data.

### 6.2 Restore

```bash
docker compose down
tar xzf openpalm-backup-YYYYMMDD.tar.gz -C ~/
sudo chown -R $(id -u):$(id -g) ~/.openpalm
docker compose up -d
```

No staging tier to reconstruct. The compose files and env files are live in `config/` and `vault/` — extract and start.

### 6.3 Upgrade

```bash
openpalm update
```

Under the hood:

1. Pull new images
2. Update `config/components/core.yml` and `config/components/admin.yml` (system-managed compose files)
3. Update system-managed values in `vault/system.env` (image tag, etc.)
4. Never touch `vault/user.env`
5. Never touch `openpalm.yml`, `config/automations/`, `config/assistant/`, or user-installed channel overlays
6. Validate → snapshot → write → deploy (standard apply flow)

### 6.4 Common Operations

| Task | Where |
|------|-------|
| Add an LLM API key (immediate) | Edit `vault/user.env` — picked up in seconds |
| Add an LLM API key (on restart) | Edit `vault/user.env` — applied on next container create |
| Change admin password | CLI regenerates in `vault/system.env`, restarts affected services |
| Add a channel | Drop `.yml` in `config/components/`, run `openpalm apply` |
| Add assistant extension | Drop files in `config/assistant/` |
| Add automation | Drop `.yml` in `config/automations/` |
| Browse AKM assets | `data/stash/` |
| View audit logs | `logs/` |
| View memory data | `data/memory/` |
| Enable/disable a component | Edit `config/openpalm.yml`, run `openpalm apply` |
| Roll back a failed apply | `openpalm rollback` |
| Full backup | `tar czf backup.tar.gz ~/.openpalm` |

---

## Part 7: Summary of Changes

| Aspect | Current | Proposed |
|--------|---------|----------|
| Root layout | 3 XDG roots + workdir (31 subdirs) | `~/.openpalm/` with 4 top-level dirs + `~/.cache/openpalm/` |
| Secret storage | `secrets.env` in CONFIG + `stack.env` in DATA + staged copies | `vault/user.env` + `vault/system.env` — no copies |
| Secret isolation | `env_file:` bulk-injects everything into guardian + admin | Per-container allowlists; vault mounted only to admin (rw) and assistant (user.env ro) |
| LLM key hot-reload | Not possible (container restart required) | File watcher on `vault/user.env` — seconds, no restart |
| Staging tier | Full copy CONFIG+DATA → STATE | Eliminated; validate-in-place with `~/.cache/openpalm/rollback/` |
| Rollback | Implicit (old STATE_HOME), not automated | Explicit `openpalm rollback` with automated restore on deploy failure |
| Stack config | Implicit (which compose files are present) | Explicit `openpalm.yml` with enabled components and feature flags |
| Guardian secrets | `env_file:` + bind mount + runtime re-read | `${VAR}` substitution only; restart on channel install |
| Backup | `tar` 2 directories + optional 3rd | `tar ~/.openpalm` |
| Cache / registry | No dedicated cache location | `~/.cache/openpalm/registry/` mounted into assistant + admin |
| AKM stash | Hidden in `config/stash` | `data/stash/` mounted at `~/.akm` in assistant |

### What Stays the Same

- File-based stack management (no databases for config)
- Docker Compose as the orchestration layer
- Caddy `import` for modular channel routes
- Guardian-only ingress with HMAC verification
- Docker socket proxy isolation
- Container UID/GID mapping
- Non-destructive upgrade for user-editable files
- Channel install via file-drop into `config/components/`
- OpenCode's system/user config split
- Varlock for schema validation and log redaction

### What This Does NOT Change

- The security model — it gets strictly more secure (per-container allowlists, vault boundary)
- The container architecture (same services, same roles)
- The admin UI functionality
- The channel plugin system
- The memory service internals

---

## Appendix A: `vault/user.env` Template

```env
# OpenPalm — User Configuration
# ──────────────────────────────────────────────────────────────────
# Edit these values directly. The assistant picks up changes within
# seconds via file watcher — no restart needed.

# ── LLM Providers ─────────────────────────────────────────────────
OPENAI_API_KEY=
OPENAI_BASE_URL=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=
GOOGLE_API_KEY=

# ── System LLM (memory categorization, etc.) ──────────────────────
SYSTEM_LLM_PROVIDER=
SYSTEM_LLM_BASE_URL=
SYSTEM_LLM_MODEL=

# ── Embedding ─────────────────────────────────────────────────────
EMBEDDING_MODEL=
EMBEDDING_DIMS=

# ── Memory ────────────────────────────────────────────────────────
MEMORY_USER_ID=default_user

# ── Owner ─────────────────────────────────────────────────────────
OWNER_NAME=
OWNER_EMAIL=
```

## Appendix B: `vault/system.env` Template

```env
# OpenPalm — System Configuration (managed by CLI/admin)
# ──────────────────────────────────────────────────────────────────
# Do not edit manually. These values are written by the CLI and
# admin, and may be overwritten on apply/upgrade.

# ── Authentication ────────────────────────────────────────────────
OPENPALM_ADMIN_TOKEN=

# ── Paths ─────────────────────────────────────────────────────────
OPENPALM_HOME=
OPENPALM_UID=1000
OPENPALM_GID=1000
OPENPALM_DOCKER_SOCK=/var/run/docker.sock

# ── Images ────────────────────────────────────────────────────────
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=latest

# ── Service Auth ──────────────────────────────────────────────────
MEMORY_AUTH_TOKEN=
OPENCODE_SERVER_PASSWORD=

# ── Channel HMAC Secrets ──────────────────────────────────────────
CHANNEL_CHAT_SECRET=
CHANNEL_DISCORD_SECRET=
CHANNEL_SLACK_SECRET=
CHANNEL_API_SECRET=

# ── Setup ─────────────────────────────────────────────────────────
OPENPALM_SETUP_COMPLETE=false
```

## Appendix C: `config/openpalm.yml` Template

```yaml
# OpenPalm — Stack Configuration
# ──────────────────────────────────────────────────────────────────
# Controls which components are enabled and stack-level settings.
# Edit this file and run `openpalm apply` to activate changes.

name: my-assistant
version: 1

components:
  admin: true
  ollama: false

features:
  ssh: false

network:
  ingress_bind: 127.0.0.1
  ingress_port: 8080
```

---

## Part 8: Migration (0.9.x → 0.10.0)

> Added 2026-03-19 by agent review consensus (5/5 unanimous). An automated migration tool is non-negotiable if the FS refactor ships.

### 8.1 `openpalm migrate` Command

The CLI provides a migration command that handles the XDG-to-`~/.openpalm/` transition atomically:

```bash
openpalm migrate
```

### 8.2 Migration Steps

```
1. DETECT     — scan for existing XDG directories
                 • Check ~/.config/openpalm/ (CONFIG_HOME)
                 • Check ~/.local/share/openpalm/ (DATA_HOME)
                 • Check ~/.local/state/openpalm/ (STATE_HOME)
                 • Check custom paths via OPENPALM_CONFIG_HOME / OPENPALM_DATA_HOME / OPENPALM_STATE_HOME
                 → if none found: skip migration, run fresh install

2. STOP       — docker compose down (stop all containers)

3. CREATE     — create ~/.openpalm/ directory structure
                 • config/, vault/, data/, logs/

4. MOVE       — relocate files from old to new locations
                 CONFIG_HOME/channels/*.yml     → config/components/channel-*.yml
                 CONFIG_HOME/opencode/          → config/assistant/
                 CONFIG_HOME/secrets.env        → (split into vault/user.env + vault/system.env)
                 DATA_HOME/admin/               → data/admin/
                 DATA_HOME/assistant/           → data/assistant/
                 DATA_HOME/memory/              → data/memory/
                 DATA_HOME/guardian/            → data/guardian/
                 DATA_HOME/caddy/              → data/caddy/
                 DATA_HOME/opencode/           → data/assistant/ (merge)
                 DATA_HOME/stack.env           → (merge system values into vault/system.env)
                 DATA_HOME/automations/        → config/automations/
                 STATE_HOME/opencode/          → logs/opencode/
                 STATE_HOME/artifacts/         → (discarded — staging tier eliminated)
                 ~/openpalm/ (WORK_DIR)        → data/workspace/

5. SPLIT ENV  — split secrets.env + stack.env into user.env + system.env
                 • LLM keys, provider URLs, MEMORY_USER_ID → vault/user.env
                 • ADMIN_TOKEN, HMAC secrets, paths, UID/GID, image tags → vault/system.env
                 • Generate user.env.schema + system.env.schema from templates

6. VALIDATE   — run the standard validate-in-place checks
                 • varlock validates both env files against schemas
                 • docker compose config validates compose files
                 → if validation fails: report errors, do NOT delete old directories

7. VERIFY     — start stack with new layout, run health checks
                 → if health checks pass: report success, print next steps
                 → if health checks fail: stop stack, report error

8. PRESERVE   — OLD directories are NOT deleted automatically
                 • Print: "Migration complete. Old directories preserved at:"
                 • Print: "  ~/.config/openpalm/"
                 • Print: "  ~/.local/share/openpalm/"
                 • Print: "  ~/.local/state/openpalm/"
                 • Print: "Run 'openpalm migrate --cleanup' to remove them after verifying."
```

### 8.3 Env File Splitting Rules

| Source | Variable | Destination |
|--------|----------|-------------|
| `secrets.env` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_API_KEY` | `vault/user.env` |
| `secrets.env` | `OPENAI_BASE_URL`, `SYSTEM_LLM_*`, `EMBEDDING_*` | `vault/user.env` |
| `secrets.env` | `ADMIN_TOKEN` | `vault/system.env` (as `OPENPALM_ADMIN_TOKEN`) |
| `secrets.env` | `OPENMEMORY_USER_ID` | `vault/user.env` (as `MEMORY_USER_ID`) |
| `stack.env` | `OPENPALM_HOME`, `OPENPALM_UID`, `OPENPALM_GID` | `vault/system.env` |
| `stack.env` | `OPENPALM_IMAGE_*` | `vault/system.env` |
| `stack.env` | `MEMORY_AUTH_TOKEN`, `OPENCODE_SERVER_PASSWORD` | `vault/system.env` |
| `stack.env` | `CHANNEL_*_SECRET` | `vault/system.env` |
| `stack.env` | `OPENPALM_DOCKER_SOCK` | `vault/system.env` |

### 8.4 Legacy Environment Variable Handling

If the user has `OPENPALM_CONFIG_HOME`, `OPENPALM_DATA_HOME`, or `OPENPALM_STATE_HOME` set in their shell environment:

```
WARNING: Legacy environment variables detected:
  OPENPALM_CONFIG_HOME=/custom/path/config
  OPENPALM_DATA_HOME=/custom/path/data

OpenPalm 0.10.0 uses OPENPALM_HOME (~/.openpalm by default).
Remove these variables from your shell profile and re-run migration.
```

The migration tool refuses to proceed with legacy env vars set, to prevent confusion about which paths are authoritative.

### 8.5 Combined Migration

Since 0.10.0 also introduces the component system (replacing legacy channels), `openpalm migrate` handles both transitions:

1. Directory relocation (XDG → `~/.openpalm/`)
2. Env file splitting (`secrets.env` + `stack.env` → `user.env` + `system.env`)
3. Channel-to-component conversion (`.yml` overlays move to `config/components/`)

Users do NOT need to run separate migration commands for the filesystem and component changes.