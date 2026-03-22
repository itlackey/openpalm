# Core Principles

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

The foundation of the OpenPalm stack is simply a set of conventions used to manage Docker compose overlay files, .env files, and configuration files related to specific services in the stack. That is it. That is what the entire stack is built upon.

There are four core containers, the guardian, the assistant, the memory, and the scheduler. These container vary in complexity but are designed to do one thing each. The guardian and the assistant are OpenCode servers, the memory is the shared agentic memory server, and the scheduler is the stacks cron service that handles running automations.

The stack allows for three primary extension points.

1. **Addons** are Docker compose overlay files to add services to the stack.
2. **Assistant extensions** are standard OpenCode resources that are mounted into the assistant container.
3. **Automations** that run on the scheduler and have access to the assistant to execute workflows on a recurring basis.

The stack defines a special type of addon, referred to as a channel. These are services that use the openpalm/channel docker image with a know entry point that uses the openpalm/channels-sdk. These containers are meant to be the entry point to the stack, and provide services like Discord/Slack/Telegram bots, MCP/API servers, voice chat, etc. Addons that provide services/tools to the rest of the stack can also be added. These can be any container you have access to pull, ollama for example.

## File System

Golden rules:

- **Convention over configuration** is a foundational principle in this repo. Simplicity and predictability are key features.
- **Tooling is a thin wrapper over existing tech** and should be as simple and light weight as possible. The goal is for CLI, admin, setup wizard and other management tools to be additive convenience tools, not required infrastructure tooling. This means making the most of foundational dependencies like Docker compose, varlock, etc.
- **Leverage Docker Compose and OpenCode configuration features** to avoid custom config/orchestration implementations.
- **Manual management should be easy** for users familiar with Docker compose and opencode configuration. Tooling beyond docker compose (or compatible) should not be required.
- **Add containers and routes by file-drop** into known host locations (no code changes required).
- **Add assistant extensions by copying OpenCode assets** into known host locations.
- **Core container and routing configuration is stored on the host** for advanced users.
- **No template rendering** — manage configuration by copying whole files and editing existing configuration files, not by string interpolation or code generation.
- **Never overwrite existing user-modified files in `~/.openpalm/config/` during automatic lifecycle operations** (install/update/startup apply/setup reruns/upgrades); only seed missing defaults or do controlled updates upon user request.
- **All persistent container data lives on the host** for backup/restore.
- **All host-stored container files are user-accessible** (ownership/permissions contract - not owned by root).
- **Core assistant extensions are baked into the assistant container** and loaded from a fixed OpenCode config directory to ensure core extensions take precedence.

For (9), OpenCode supports a custom config directory via `OPENCODE_CONFIG_DIR`; it is searched like a standard `.opencode` directory for agents/commands/tools/skills/plugins. ([OpenCode][1])

---

## Tooling

- Simplified docker compose commands
- Assists in managing secrets
- Admin provides:
  - Way to manage addons by copying the compose file to the stack if needed and providing an easy way to provide values or assign secrets to the addons required environment variables.
  - Editor for automation configuration files, simple yaml editor/form and copy from registry function.
  - Editor the memory configuration file.
  - Editor to manage global connections
  - Editor to manage account/assistant details
    - Assistant name, email, persona
    - Admin and assistant tokens
  - Editor for addon on configurations/environments
    - This is for the standard .env.schema and any specific configuration files needed by the addon. ie. memory configuration json, OpenViking conf file, etc.

All of this functionality exists to simplify managing files under the OP_HOME directory. The base line is managing the compose and schema files under OP_HOME/stack, the .env files under OP_HOME/vault, configuration/automation files under OP_HOME/config, possibly service specific files under OP_HOME/data. These tasks should be achievable by a technical user without the tooling by manually editing files and placing them in the proper locations.

## Security invariants

These are hard constraints that must never be violated during development. See also the Security boundaries summary in `foundations.md`, which provides a condensed version of these rules for quick reference.

1. **Host CLI or admin is the orchestrator.** The host CLI manages Docker Compose directly on the host. The admin container, when present, provides a web UI and API for remote/assistant-driven stack operations via docker-socket-proxy. Only one orchestrator should manage compose operations at a time. The Docker socket is never exposed to any other container.
2. **Guardian-only ingress.** All channel traffic enters through the guardian, which enforces HMAC verification, timestamp skew rejection, replay detection, and rate limiting. No channel may communicate directly with the assistant. Channel secrets are distributed during addon install (see § Addon secret lifecycle below).
3. **Assistant isolation.** The assistant has no Docker socket and no broad host filesystem access beyond its designated mounts: `config/ -> /etc/openpalm`, `config/assistant/ -> /home/opencode/.config/opencode`, `vault/stack/auth.json`, `vault/user/ -> /etc/vault/` (directory, rw), `data/assistant/`, `data/stash/`, `data/workspace/`, and `logs/opencode/`. When the admin service is present, the assistant interacts with the stack through the admin API. When admin is absent, assistant stack-management tools are unavailable — the assistant operates with memory tools only.
4. **Host only by default.** Admin interfaces, dashboards, and channels are host-restricted by default. Nothing is exposed to the network or internet without explicit user opt-in.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **writing whole files** or **targeted edits** — never by string interpolation, template expansion, or dynamic code generation. The CLI or admin validates proposed changes, writes them to live paths, and uses Docker Compose natively for variable substitution. All control-plane logic lives in `@openpalm/lib` — both CLI and admin import from this shared library. OpenCode core config is image-baked at `/etc/opencode`, with user extensions mounted from `config/assistant/`.

All OpenPalm state lives under a single root: **`~/.openpalm/`** (configurable via `OP_HOME`). Ephemeral cache lives at `~/.cache/openpalm/`.

### 1) Config (user-owned, non-secret)

**Location:** `~/.openpalm/config/`
**Purpose:** user-editable, non-secret configuration. Automations, OpenCode extensions, and user-managed stack settings.

Subtrees:

- `automations/` — automation YAML files (mounted to scheduler)
- `assistant/` — user OpenCode extensions (tools, plugins, skills)
- `stack.yaml` — tooling metadata such as preferred addons and higher-level settings

**Rule:** allowed writers are: user direct edits; explicit admin UI/API config actions; assistant calls through authenticated/allowlisted admin APIs on user request. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults or making targeted updates.

### 1b) Stack (system-managed runtime assembly)

**Location:** `~/.openpalm/stack/`
**Purpose:** live Docker Compose assembly used to run the stack.

Subtrees:

- `core.compose.yml` — base compose definition for core services
- `addons/<n>/compose.yml` — addon overlays such as `chat`, `api`, `voice`, `admin`

**Rule:** the CLI/admin may write and update files here as part of lifecycle operations and explicit addon install/uninstall actions. Users may inspect or edit them directly, but this tree is system-assembled runtime state rather than the primary user config surface.

### 2) Vault (secrets boundary)

**Location:** `~/.openpalm/vault/`
**Purpose:** all secrets and secret-adjacent configuration. Hard filesystem boundary — only admin mounts the full directory (rw); assistant mounts only `vault/user/` (the directory, rw); no other container mounts anything from vault.

Subtrees:

- `user/user.env` — user-editable secrets: LLM API keys, provider URLs, embedding config, owner info. Hot-reloadable by the assistant via file watcher.
- `stack/stack.env` — system-managed secrets: admin token, HMAC secrets, paths, UID/GID, image tags, service auth tokens. Written only by CLI/admin or manually by advanced users.

Env schemas and example files live in the repo at `vault/` (committed, no secret values).

**Rule:** no container except admin may mount `vault/` as a directory. The assistant receives only a bind mount of `vault/user/` (the directory, rw). Guardian, scheduler, and memory receive secrets exclusively through `${VAR}` substitution at container creation time and optional service-specific managed env files located under `vault/stack/services/<service-name>/`.

### 3) Data (service-managed, durable)

**Location:** `~/.openpalm/data/`
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

Subtrees: `assistant/`, `admin/`, `memory/`, `guardian/`, `stash/` (AKM assets), `workspace/` (shared working directory).

**Write policy:** Each container may write only to its own designated `data/` subdirectories via its mounts. The assistant writes to `data/assistant/`, `data/stash/`, and `data/workspace/`; the memory service writes to `data/memory/`; and so on. No container may access another service's data directories. Stack-wide data operations (creating new data subtrees, managing other services' data) require the admin API.

### 4) Logs (audit and debug)

**Location:** `~/.openpalm/logs/`
**Purpose:** consolidated log output from all services.

Files: `guardian-audit.log`, `admin-audit.jsonl`, `opencode/` (OpenCode state/session logs).

### 5) Cache (ephemeral)

**Location:** `~/.cache/openpalm/`
**Purpose:** regenerable cache data that does not need backing up.

Subtrees: `rollback/` (previous known-good config snapshots for automated rollback on deploy failure).

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining a base Compose file with addon overlays using Compose's native multi-file mechanisms (merge rules and/or `include`). ([Docker Documentation][3])
**Implication:** adding an addon is dropping a `compose.yml` overlay into `stack/addons/<n>/`, then rerunning `docker compose` with the updated file list.

### B) OpenCode: core precedence via baked-in `/etc/opencode`

- The assistant container includes core extensions/config at **`/etc/opencode`**.
- The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
- Advanced users *may* bind-mount a host directory over `/etc/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container's original contents. ([Docker Documentation][5])

### C) Non-destructive lifecycle sync is enforced by directory boundaries

To guarantee lifecycle operations never clobber user configuration:

- **`config/` is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults or does targeted updates and never overwrites existing user files. Explicit mutation paths — user direct edits, CLI/admin UI/API config actions, authenticated/allowlisted assistant calls to admin API on user request — may create/update/remove files as requested.
- **`stack/` is the live runtime assembly.** Automatic lifecycle sync may update `core.compose.yml` and addon overlays there to keep runtime assets aligned with the current release and installed addon set.
- **`vault/` has strict access rules.** Only admin mounts the full directory (rw). The assistant mounts only `vault/user/` (the directory, rw). No other container mounts anything from `vault/`. Lifecycle operations never overwrite `vault/user/user.env`; they may update `vault/stack/stack.env` (system-managed).
- **`data/` is service-writable within ownership boundaries.** Each container owns its designated data subdirectories. No container may access another service's data directories. Stack-wide data operations require the admin API.
- **Apply uses validate-in-place with snapshot rollback.** Changes are validated against temp copies (in `/tmp/openpalm`) before writing to live paths (`$OP_HOME/stack`). A snapshot of the current state is saved to `~/.cache/openpalm/rollback/` before any write. If deployment fails health checks, the snapshot is automatically restored. See § Rollback scope below for what is included in the snapshot.

### D) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### E) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---

## Shared control-plane library (`@openpalm/lib`)

All portable control-plane logic — lifecycle management, addon operations, secret resolution, path helpers, validation, Docker invocation, and configuration assembly — lives in `packages/lib/` (`@openpalm/lib`). Both the CLI and admin import from this package. **No control-plane logic may be duplicated between consumers.**

**Rules:**

- New control-plane functionality MUST be implemented in `@openpalm/lib`, not in CLI or admin source directly.
- The CLI calls lib functions directly. The admin calls them from API route handlers. The scheduler calls them for automation execution. All get identical behavior.
- If a function exists in the admin that should be reusable (e.g., compose invocation, env file parsing, component discovery), it must be extracted to lib.
- Test coverage for control-plane logic belongs in lib's test suite, not duplicated across consumer test suites.

**Rationale:** The CLI must work without the admin container. The admin must work without the CLI. The scheduler must work without either. If control-plane logic is scattered across consumers, these guarantees break and behavior diverges.

---

## Service port assignments

Host-exposed OpenPalm services default to a small localhost-friendly port set. Core services use the `38xx` range and addon edges map their internal ports onto nearby host ports for manual use.

| Service | Internal Port | Default Host Bind | Purpose |
|---------|--------------|-------------------|---------|
| **Assistant** (OpenCode) | 4096 | `127.0.0.1:3800` | OpenCode web UI + API |
| **Voice addon** | 8186 | `127.0.0.1:3810` | Voice interface (TTS/STT) |
| **Admin** | 8100 | `127.0.0.1:3880` | Admin UI + API |
| **Admin OpenCode** | 3881 | `127.0.0.1:3881` | Admin-side OpenCode runtime |
| **Guardian** | 8080 | (internal only) | HMAC verification + rate limiting |
| **Scheduler** | 8090 | `127.0.0.1:3897` | Automation scheduler |
| **Memory** | 8765 | `127.0.0.1:3898` | Memory service API |
| **Chat addon** | 8181 | `127.0.0.1:3820` | OpenAI-compatible chat edge |
| **API addon** | 8182 | `127.0.0.1:3821` | OpenAI/Anthropic-compatible API edge |

Port assignments are defined via `OP_*_PORT` variables in `vault/stack/stack.env` and referenced in compose files via `${VAR}` substitution.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly. **This pattern is mandatory; do not deviate.** See [`docker-dependency-resolution.md`](docker-dependency-resolution.md) for the full rationale and background behind these rules.

### Admin (SvelteKit/Node build)

The admin Dockerfile uses **plain `npm install`** (not Bun) at a workspace root directory so `node_modules/` lands at a common ancestor of admin source paths. This gives standard Node module resolution a real directory tree with no symlinks. The build output is a self-contained SvelteKit adapter-node bundle — no runtime `node_modules` needed.

**Rules:**

- Never use Bun to install dependencies in the admin Docker build — Bun's symlink-based `node_modules` layout is fragile under Node/Vite resolution.
- `node_modules` must be at a common ancestor of all source directories that Vite resolves (admin source, stack).
- `PATH` must include `node_modules/.bin` so build tool binaries (svelte-kit, vite) are available from subdirectories.

### Guardian + Channels (Bun runtime)

These Dockerfiles copy `packages/channels-sdk` source into `/app/node_modules/@openpalm/channels-sdk` and install sdk dependencies afterward:

```dockerfile
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
```

This ensures sdk transitive dependencies are available at runtime. Since these services run on Bun (which created the install), there is no cross-tool resolution concern.

**Rules:**

- Every Dockerfile that copies `packages/channels-sdk` must run `bun install --production` inside the copied sdk directory.
- If `packages/channels-sdk/package.json` gains new dependencies, all service Dockerfiles automatically pick them up — no per-service changes needed.

---

## Addon secret lifecycle

When a channel addon is installed, the following secret distribution flow occurs:

1. **Generation:** a shared HMAC secret is generated by the CLI or admin during addon install.
2. **Guardian side:** the secret is written as a `CHANNEL_<n>_SECRET` entry — either appended to `vault/stack/stack.env` or to the file at `GUARDIAN_SECRETS_PATH` (if configured). If using `GUARDIAN_SECRETS_PATH`, the guardian picks up the new secret via mtime-based hot-reload without restart.
3. **Channel side:** the secret is written to the channel addon's env configuration (typically the addon's `.env` or injected via the addon compose overlay) so the channels-sdk can sign outbound requests.
4. **Verification:** on every inbound request, guardian verifies the HMAC signature using the channel's secret, rejects replayed nonces, and enforces rate limits before forwarding to the assistant.

Both sides must have the same secret value. Rotating a channel secret requires updating both the guardian's secret store and the channel's env, then restarting the channel (guardian picks up the change via hot-reload if using `GUARDIAN_SECRETS_PATH`).

---

## Addon conflict detection

Addon overlays may extend core services by injecting environment variables or volumes into core service definitions via Compose multi-file merge. This is standard Docker Compose merge behavior — no custom merging logic is involved. ([Docker Documentation][3])

**Known limitation:** the validate-in-place step checks that the assembled compose config is syntactically valid and that Varlock schemas pass, but it does not detect semantic conflicts between addons — for example, two addons setting different values for the same environment variable on a core service. In such cases, Compose's last-file-wins merge order determines the final value. Users installing multiple addons that target the same core service env vars should review the assembled config.

---

## Rollback scope

When the CLI or admin performs an apply operation, a snapshot is saved to `~/.cache/openpalm/rollback/` before any writes. The snapshot includes:

- `stack/` — the full live compose assembly (core.compose.yml + addon overlays)
- `vault/stack/` — system-managed secrets and env files (stack.env, service-specific managed env files)

The snapshot does **not** include `config/` (user-owned, not modified by apply), `vault/user/` (never overwritten by lifecycle operations), or `data/` (service-owned runtime state).

On health check failure after deploy, the snapshot is automatically restored and the stack is restarted. Manual rollback is available via `openpalm rollback`.

---

## Operational behavior

- **Add an addon:** drop `compose.yml` into `stack/addons/<n>/`, then rerun `docker compose up -d` with that addon included. ([Docker Documentation][3])
- **Add an extension (user):** copy OpenCode assets into `config/assistant/` following OpenCode's directory structure. ([OpenCode][1])
- **Core precedence:** core extensions live in `/etc/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
- **Apply changes:** the CLI or admin validates proposed changes (Varlock schema, compose config) before writing anything. If validation passes, a snapshot of current live files is saved to `~/.cache/openpalm/rollback/` (see § Rollback scope), changes are written to live paths, and `docker compose up -d` is run. If services fail health checks, the snapshot is automatically restored. No string interpolation or template expansion — just whole-file writes and Compose native `--env-file` substitution. Compose is normally invoked with `vault/stack/stack.env` (system-managed: admin token, HMAC secrets, paths, UID/GID, image tags, bind ports) and `vault/user/user.env` (user-managed: LLM keys, provider URLs); individual services may additionally load service-specific managed env files such as `vault/stack/services/memory/managed.env`. Automatic lifecycle apply (startup/install/update/setup reruns/upgrades) is non-destructive for `config/` and `vault/user/user.env`; it may seed missing defaults, do targeted updates, and update system-managed files in `stack/` and `vault/stack/`.
- **Addon overlays may extend core services.** Addon compose files can inject environment variables or volumes into core service definitions via Compose multi-file merge. For example, the OpenViking addon adds `OPENVIKING_URL` and `OPENVIKING_API_KEY` to the assistant service by defining an `assistant:` block with additional `environment:` entries in its overlay. This is standard Docker Compose merge behavior — no custom merging logic is involved. See § Addon conflict detection for limitations.
- **Hot-reload LLM keys:** the assistant watches the bind-mounted `vault/user/` directory. Editing `user.env` on the host takes effect within seconds — no container restart needed, no lost context.
- **Rollback:** `openpalm rollback` restores the most recent snapshot from `~/.cache/openpalm/rollback/` and restarts the stack. Available both as an automated response to failed deploys and as a manual escape hatch. See § Rollback scope for snapshot contents.
- **Backup/restore:** `tar czf backup.tar.gz ~/.openpalm` archives the entire stack. Restore is extract and `docker compose up -d` — no staging tier to reconstruct.

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"

[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"