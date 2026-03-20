## Core goals

The filesystem and volume-mount contract exists to guarantee:

1. **Add containers and routes by file-drop** into known host locations (no code changes required).
2. **Add assistant extensions by copying OpenCode assets** into known host locations.
3. **Core container and routing configuration is stored on the host** for advanced users.
4. **Leverage Docker Compose, Caddy, and OpenCode configuration features** to avoid custom config/orchestration implementations.
5. **No template rendering** — manage configuration by copying whole files, not by string interpolation or code generation.
6. **Never overwrite existing user-modified files in CONFIG_HOME during automatic lifecycle operations** (install/update/startup apply/setup reruns/upgrades); only seed missing defaults.
7. **All persistent container data lives on the host** for backup/restore.
8. **All host-stored container files are user-accessible** (ownership/permissions contract).
9. **Core assistant extensions are baked into the assistant container** and loaded from a fixed OpenCode config directory to ensure core extensions take precedence.

For (9), OpenCode supports a custom config directory via `OPENCODE_CONFIG_DIR`; it is searched like a standard `.opencode` directory for agents/commands/tools/skills/plugins. ([OpenCode][1])

---

## Security invariants

These are hard constraints that must never be violated during development:

1. **Host CLI or admin is the orchestrator.** The host CLI manages Docker Compose directly on the host. The admin container, when present, provides a web UI and API for remote/assistant-driven stack operations via docker-socket-proxy. Only one orchestrator should manage compose operations at a time. The Docker socket is never exposed to any other container.
2. **Guardian-only ingress.** All channel traffic enters through the guardian, which enforces HMAC verification, timestamp skew rejection, replay detection, and rate limiting. No channel may communicate directly with the assistant.
3. **Assistant isolation.** The assistant has no Docker socket, no host filesystem access beyond its designated mounts (`config/` ro, `vault/user.env` ro, `data/assistant/`, `data/stash/`, `data/workspace/`, `logs/opencode/`). When the admin service is present, the assistant interacts with the stack through the admin API. When admin is absent, assistant stack-management tools are unavailable — the assistant operates with memory tools only.
4. **LAN-first by default.** Admin interfaces, dashboards, and channels are LAN-restricted by default. Nothing is publicly exposed without explicit user opt-in.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **writing whole files** — never by string interpolation, template expansion, or dynamic code generation. The CLI or admin validates proposed changes, writes them to live paths, and uses Docker Compose natively for variable substitution. All control-plane logic lives in `@openpalm/lib` — both CLI and admin import from this shared library. OpenCode core config is image-baked at `/etc/opencode`, with user extensions mounted from `config/assistant/`.

All OpenPalm state lives under a single root: **`~/.openpalm/`** (configurable via `OPENPALM_HOME`). Ephemeral cache lives at `~/.cache/openpalm/`.

### 1) Config (user-owned, non-secret)

**Location:** `~/.openpalm/config/`
**Purpose:** user-editable, non-secret configuration. Compose overlays, automations, OpenCode extensions, and the stack config file.

Subtrees:

* `components/` — compose overlays (one `.yml` per component: `core.yml`, `admin.yml`, `channel-discord.yml`, etc.)
* `automations/` — automation YAML files (mounted to scheduler)
* `assistant/` — user OpenCode extensions (tools, plugins, skills)
* `openpalm.yml` — stack-level config: enabled components, feature flags, network settings

**Rule:** allowed writers are: user direct edits; explicit admin UI/API config actions; assistant calls through authenticated/allowlisted admin APIs on user request. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults. System-managed compose files (`core.yml`, `admin.yml`) may be updated on upgrade.

### 2) Vault (secrets boundary)

**Location:** `~/.openpalm/vault/`
**Purpose:** all secrets and secret-adjacent configuration. Hard filesystem boundary — only admin mounts the full directory (rw); assistant mounts only `vault/user.env` (ro); no other container mounts anything from vault.

Files:

* `user.env` — user-editable secrets: LLM API keys, provider URLs, embedding config, owner info. Hot-reloadable by the assistant via file watcher.
* `user.env.schema` — Varlock schema for `user.env`
* `system.env` — system-managed secrets: admin token, HMAC secrets, paths, UID/GID, image tags, service auth tokens. Written only by CLI/admin.
* `system.env.schema` — Varlock schema for `system.env`

**Rule:** no container except admin may mount `vault/` as a directory. The assistant receives only a file-level bind mount of `vault/user.env` (read-only). Guardian, scheduler, memory, and caddy receive secrets exclusively through `${VAR}` substitution at container creation time.

### 3) Data (service-managed, durable)

**Location:** `~/.openpalm/data/`
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

Subtrees: `assistant/`, `admin/`, `memory/`, `guardian/`, `caddy/`, `stash/` (AKM assets), `workspace/` (shared working directory).

**Write policy:** Containers own their durable runtime data. The CLI or admin manages system-policy files (`data/caddy/Caddyfile`, `data/caddy/channels/`). The assistant must not write to `data/` directly — when admin is present, it interacts through the admin API.

### 4) Logs (audit and debug)

**Location:** `~/.openpalm/logs/`
**Purpose:** consolidated log output from all services.

Files: `guardian-audit.log`, `admin-audit.jsonl`, `opencode/` (OpenCode state/session logs).

### 5) Cache (ephemeral)

**Location:** `~/.cache/openpalm/`
**Purpose:** regenerable cache data that does not need backing up.

Subtrees: `registry/` (cached extension/channel registry index), `rollback/` (previous known-good config snapshots for automated rollback on deploy failure).

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining a base Compose file with component overlays using Compose’s native multi-file mechanisms (merge rules and/or `include`). ([Docker Documentation][3])
**Implication:** adding a component is dropping a `.yml` compose overlay into `config/components/`, then running `openpalm apply` which validates the change, snapshots current state, and runs Docker Compose with the updated overlay chain.

### B) Caddy: modular by native `import`

Caddy loads a stable root Caddyfile that uses `import` (with globs) to include snippets from `data/caddy/channels/`. ([Caddy Web Server][4])
**Implication:** adding an HTTP route for a component is including a `.caddy` snippet in its compose overlay directory. The apply command stages the snippet into `data/caddy/channels/` and reloads Caddy. If no `.caddy` file is present, the component has no HTTP route and is only accessible on the Docker network.

### C) OpenCode: core precedence via baked-in `/etc/opencode`

* The assistant container includes core extensions/config at **`/etc/opencode`**.
* The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
* Advanced users *may* bind-mount a host directory over `/etc/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container’s original contents. ([Docker Documentation][5])

### D) Non-destructive lifecycle sync is enforced by directory boundaries

To guarantee lifecycle operations never clobber user configuration:

* **`config/` is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults and never overwrites existing user files. Explicit mutation paths — user direct edits, admin UI/API config actions, authenticated/allowlisted assistant calls to admin API on user request — may create/update/remove files as requested. System-managed compose files (`core.yml`, `admin.yml`) may be updated on upgrade.
* **`vault/` has strict access rules.** Only admin mounts the full directory (rw). The assistant mounts only `vault/user.env` (ro file-level mount). No other container mounts anything from `vault/`. Lifecycle operations never overwrite `vault/user.env`; they may update `vault/system.env` (system-managed).
* **`data/` is admin- and service-writable.** Containers own durable data; the admin manages system-policy files (`data/caddy/Caddyfile`, `data/caddy/channels/`) directly. The assistant may not write to `data/` directly — it must go through the admin API.
* **Apply uses validate-in-place with snapshot rollback.** Changes are validated against temp copies before writing to live paths. A snapshot of the current state is saved to `~/.cache/openpalm/rollback/` before any write. If deployment fails health checks, the snapshot is automatically restored.

### E) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### F) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---

## Shared control-plane library (`@openpalm/lib`)

All portable control-plane logic — lifecycle management, component operations, secret resolution, path helpers, validation, Docker invocation, and configuration assembly — lives in `packages/lib/` (`@openpalm/lib`). Both the CLI and admin import from this package. **No control-plane logic may be duplicated between consumers.**

**Rules:**

* New control-plane functionality MUST be implemented in `@openpalm/lib`, not in CLI or admin source directly.
* The CLI calls lib functions directly. The admin calls them from API route handlers. The scheduler calls them for automation execution. All get identical behavior.
* If a function exists in the admin that should be reusable (e.g., compose invocation, env file parsing, component discovery), it must be extracted to lib.
* Thin wrapper modules in consumers (e.g., `packages/admin/src/lib/server/control-plane.ts`) are acceptable for re-exporting lib symbols with consumer-specific initialization, but must not contain independent logic.
* Test coverage for control-plane logic belongs in lib's test suite, not duplicated across consumer test suites.

**Rationale:** The CLI must work without the admin container. The admin must work without the CLI. The scheduler must work without either. If control-plane logic is scattered across consumers, these guarantees break and behavior diverges.

---

## Service port assignments

All OpenPalm services use the **38XX port range** to avoid conflicts with common development tools and other self-hosted services.

| Service | Internal Port | Default Host Bind | Purpose |
|---------|--------------|-------------------|---------|
| **Assistant** (OpenCode) | 3800 | `127.0.0.1:3800` | OpenCode web UI + API |
| **Voice channel** | 3810 | `127.0.0.1:3810` | Voice interface (TTS/STT) |
| **Admin** | 3880 | `127.0.0.1:3880` | Admin UI + API |
| **Admin OpenCode** (#304) | 3881 | `127.0.0.1:3881` | Admin OpenCode web UI + API (host-only) |
| **Ingress** (Caddy) | 80 | `127.0.0.1:3080` → Caddy → services | Reverse proxy (maps to 38XX internally) |
| **Guardian** | 3899 | (internal only) | HMAC verification + rate limiting |
| **Scheduler** | 3897 | (internal only) | Automation scheduler |
| **Memory** | 3898 | (internal only) | Memory service API |
| **Channel Chat** | 3820 | (internal only) | Chat channel adapter |

Port assignments are defined via `OPENPALM_*_PORT` variables in `vault/system.env` and referenced in compose files via `${VAR}` substitution. The ingress port (Caddy's external bind) defaults to `3080` but is configurable via `OPENPALM_INGRESS_PORT`.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly. **This pattern is mandatory; do not deviate.** See [`docker-dependency-resolution.md`](docker-dependency-resolution.md) for full rationale.

### Admin (SvelteKit/Node build)

The admin Dockerfile uses **plain `npm install`** (not Bun) at a workspace root directory so `node_modules/` lands at a common ancestor of admin source paths. This gives standard Node module resolution a real directory tree with no symlinks. The build output is a self-contained SvelteKit adapter-node bundle — no runtime `node_modules` needed.

**Rules:**
* Never use Bun to install dependencies in the admin Docker build — Bun's symlink-based `node_modules` layout is fragile under Node/Vite resolution.
* `node_modules` must be at a common ancestor of all source directories that Vite resolves (admin source, assets, registry).
* `PATH` must include `node_modules/.bin` so build tool binaries (svelte-kit, vite) are available from subdirectories.

### Guardian + Channels (Bun runtime)

These Dockerfiles copy `packages/channels-sdk` source into `/app/node_modules/@openpalm/channels-sdk` and install sdk dependencies afterward:

```dockerfile
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
```

This ensures sdk transitive dependencies are available at runtime. Since these services run on Bun (which created the install), there is no cross-tool resolution concern.

**Rules:**
* Every Dockerfile that copies `packages/channels-sdk` must run `bun install --production` inside the copied sdk directory.
* If `packages/channels-sdk/package.json` gains new dependencies, all service Dockerfiles automatically pick them up — no per-service changes needed.

---

## Operational behavior

* **Add a component:** drop a `.yml` compose overlay into `config/components/`, run `openpalm apply`. The CLI validates the overlay, snapshots current state, writes the Caddy snippet (if any) to `data/caddy/channels/`, and runs `docker compose up -d` with the updated overlay chain. ([Docker Documentation][3], [Caddy Web Server][4])
* **Add an extension (user):** copy OpenCode assets into `config/assistant/` following OpenCode’s directory structure. ([OpenCode][1])
* **Core precedence:** core extensions live in `/etc/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
* **Apply changes:** the CLI or admin validates proposed changes (Varlock schema, compose config, Caddy config) before writing anything. If validation passes, a snapshot of current live files is saved to `~/.cache/openpalm/rollback/`, changes are written to live paths, and `docker compose up -d` is run. If services fail health checks, the snapshot is automatically restored. No string interpolation or template expansion — just whole-file writes and Compose native `--env-file` substitution. Compose is invoked with two env files: `vault/system.env` (system-managed: admin token, HMAC secrets, paths, UID/GID, image tags) and `vault/user.env` (user-managed: LLM keys, provider URLs). Automatic lifecycle apply (startup/install/update/setup reruns/upgrades) is non-destructive for `config/` and `vault/user.env`; it may seed missing defaults and update system-managed files (`vault/system.env`, `config/components/core.yml`).
* **Hot-reload LLM keys:** the assistant watches `vault/user.env` (mounted read-only) via file watcher. Editing `user.env` on the host takes effect within seconds — no container restart needed, no lost context.
* **Rollback:** `openpalm rollback` restores the most recent snapshot from `~/.cache/openpalm/rollback/` and restarts the stack. Available both as an automated response to failed deploys and as a manual escape hatch.
* **Backup/restore:** `tar czf backup.tar.gz ~/.openpalm` archives the entire stack. Restore is extract and `docker compose up -d` — no staging tier to reconstruct.

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[2]: https://specifications.freedesktop.org/basedir/latest/?utm_source=chatgpt.com "XDG Base Directory Specification"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"
[4]: https://caddyserver.com/docs/caddyfile/directives/import?utm_source=chatgpt.com "import (Caddyfile directive)"
[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"
