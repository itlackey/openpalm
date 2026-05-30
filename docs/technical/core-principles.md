# Core Principles

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

The foundation of the OpenPalm stack is simply a set of conventions used to manage Docker compose overlay files, .env files, and configuration files related to specific services in the stack. That is it. That is what the entire stack is built upon.

There are two core containers, the guardian and the assistant. These containers are designed to do one thing each. Both are OpenCode-based services. The assistant uses the akm CLI (with a stash bind-mounted from the host) for persistent memory, skills, lessons, and knowledge — there is no separate memory service. Automation scheduling runs as a Bun co-process inside the assistant container (no separate service, no network port).

The stack allows for three primary extension points.

1. **Addons** are Docker compose overlay files to add services to the stack.
2. **Assistant extensions** are standard OpenCode resources that are mounted into the assistant container.
3. **Automations** that run on the scheduler co-process inside the assistant container and have direct in-container access to the assistant to execute workflows on a recurring basis.

The stack defines a special type of addon, referred to as a channel. These are services that use the openpalm/channel docker image with a known entry point that uses the openpalm/channels-sdk. These containers are meant to be the entry point to the stack, and provide services like Discord/Slack/Telegram bots and MCP/API servers. Addons that provide services/tools to the rest of the stack can also be added — these can be any container you have access to pull (ollama for example, or the `channel-voice` static file server which serves a voice chat UI directly from the browser without a guardian pipeline).

## File System

Golden rules:

- **Convention over configuration** is a foundational principle in this repo. Simplicity and predictability are key features.
- **Tooling is a thin wrapper over existing tech** and should be as simple and light weight as possible. The goal is for CLI, admin, setup wizard and other management tools to be additive convenience tools, not required infrastructure tooling. This means making the most of foundational dependencies like Docker compose, etc.
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
  - Way to manage addon activation state and custom compose overlays, while providing an easy way to set values or assign secrets required by addon environment variables.
  - Editor for automation configuration files, simple yaml editor/form and copy from registry function.
  - Editor to manage AKM configuration (LLM, embedding settings)
  - Editor to manage account/assistant details
    - Assistant name, email, persona
    - Admin and assistant tokens
  - Editor for addon configurations/environments
    - This is for the standard .env.schema and any specific configuration files needed by the addon.

All of this functionality exists to simplify managing files under the OP_HOME directory. The base line is managing compose and schema files under OP_HOME/config/stack, non-secret runtime env in OP_HOME/config/stack/stack.env, file-based service secrets under OP_HOME/stash/vaults/secrets, user-managed AKM vault data under OP_HOME/stash/vaults, configuration/automation files under OP_HOME/config, and service-specific files under OP_HOME/state. These tasks should be achievable by a technical user without the tooling by manually editing files and placing them in the proper locations.

## Security invariants

These are hard constraints that must never be violated during development. See also the Security boundaries summary in `foundations.md`, which provides a condensed version of these rules for quick reference.

1. **Host CLI or admin is the orchestrator.** The host CLI manages Docker Compose directly on the host. The admin UI is a host process (a Bun.serve server started by `openpalm`) that embeds the SvelteKit UI as a pre-built tarball and manages Docker Compose via the host Docker socket. There is no admin container. Only one orchestrator should manage compose operations at a time. The Docker socket is never exposed to any container.
2. **Guardian-only ingress.** All channel traffic enters through the guardian, which enforces HMAC verification, timestamp skew rejection, replay detection, and rate limiting. No channel may communicate directly with the assistant. Channel secrets are distributed during addon install (see § Addon secret lifecycle below).
3. **Assistant isolation.** The assistant has no Docker socket and no broad host filesystem access beyond its designated mounts: `config/ -> /etc/openpalm`, `config/assistant/ -> /home/opencode/.config/opencode`, `config/auth.json -> /home/opencode/.local/share/opencode/auth.json`, `state/assistant/ -> /home/opencode/`, `stash/ -> /akm` (shared akm stash), `state/akm/ -> /akm-op`, `cache/akm/ -> /akm-cache`, `workspace/ -> /work`, `state/logs/opencode/ -> /home/opencode/.local/state/opencode`, and `state/logs/ -> /openpalm/logs`. There is no `/etc/vault/` mount; user secrets are read via `akm vault:user`. The assistant has no network path to the host admin process (which binds to `127.0.0.1` only) and no admin tools — it cannot perform stack operations. Stack operations are handled exclusively by the host CLI and admin UI.
4. **Host only by default.** Admin interfaces, dashboards, and channels are host-restricted by default. Nothing is exposed to the network or internet without explicit user opt-in. The admin UI uses an `httpOnly` `SameSite=Strict` session cookie (no `localStorage` token). A `Host` header allowlist on every handler closes DNS rebinding. The admin process binds to `127.0.0.1` only and is never publicly exposed. **OpenCode auth (`OPENCODE_AUTH`) is disabled by default** because all host port bindings default to `127.0.0.1` (loopback-only) and the guardian communicates with the assistant over Docker's `assistant_net` network without credentials. If a user changes `OP_ASSISTANT_BIND_ADDRESS` to `0.0.0.0`, they must provide the OpenCode password as a file-based secret and enable `OPENCODE_AUTH` — the compose comments document this requirement.
5. **Scheduler access is scoped to automation needs.** The scheduler co-process inherits the assistant container's mounts and environment and shares `stash/tasks/`, `cache/akm/`, `state/akm/`, and `state/logs/`. It calls `http://localhost:4096` for `assistant`-type actions only. Stack-level cron jobs run via host OS cron using the CLI (`openpalm` commands), not via an in-container admin API call.
6. **Admin is host-only.** Admin binds exclusively to `127.0.0.1` and is never reachable from the Docker bridge network or any container. Containers cannot reach admin under any configuration. The admin process manages Docker Compose directly on the host via the host Docker socket — there is no docker-socket-proxy container.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **writing whole files** or **targeted edits** — never by string interpolation, template expansion, or dynamic code generation. The CLI or admin validates proposed changes, writes them to live paths, and uses Docker Compose natively for variable substitution. All control-plane logic lives in `@openpalm/lib` — both CLI and admin import from this shared library. OpenCode core config is image-baked at `/etc/opencode`, with user extensions mounted from `config/assistant/`.

All OpenPalm state lives under a single root: **`~/.openpalm/`** (configurable via `OP_HOME`). Ephemeral cache lives at `~/.cache/openpalm/`.

### 1) Config (user-owned, non-secret)

**Location:** `~/.openpalm/config/`
**Purpose:** user-editable, non-secret configuration. Automations, OpenCode extensions, and user-managed stack settings.

Subtrees:

- `automations/` — automation YAML files (read by the scheduler co-process inside the assistant container)
- `assistant/` — user OpenCode extensions (tools, plugins, skills)
- `akm/` — AKM configuration (LLM, embedding, and related settings in `config.json`)
- `endpoints.json` — OpenCode connection list (URL, label, optional password per endpoint) used by the admin UI's connection switcher; mode 0600. Survives `state/` wipes by design.

**Rule:** allowed writers are: user direct edits; explicit admin UI/API config actions; assistant calls through authenticated/allowlisted admin APIs on user request. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults or making targeted updates.

### 1b) Stack (system-managed runtime assembly)

**Location:** `~/.openpalm/config/stack/`
**Purpose:** live Docker Compose assembly and stack configuration used to run the stack.

Subtrees:

- `stack.yml` — stack schema marker and enabled first-party addon names (`version: 2`, optional `addons: []`)
- `stack.env` — system-managed non-secret environment variables written by CLI/admin (paths, ports, image tags, hardware profile selections, feature flags)
- `core.compose.yml` — base compose definition for core assistant runtime services
- `services.compose.yml` — system-managed first-party optional services, profile-gated
- `channels.compose.yml` — system-managed first-party optional channels, profile-gated
- `custom.compose.yml` — user-editable custom services and overlays, seeded once and never overwritten automatically

First-party optional services are enabled by adding their addon names to `stack.yml`; OpenPalm resolves those names to Compose profiles when it builds the Docker Compose command. Explicit manual `--profile` arguments remain valid for ad hoc Docker Compose use. OpenPalm does not generate `addons.compose.yml`, does not write `enabled-addons.json`, and does not use a runtime registry catalog.

### 2) Stash / Vaults (user-managed secrets and knowledge)

**Location:** `~/.openpalm/stash/`
**Purpose:** AKM knowledge base and user-managed secrets. The `stash/` directory is bind-mounted into the assistant at `/akm`.

Subtrees:

- `vaults/user.env` — AKM vault backing file for user-managed secrets. It is not a Compose `--env-file`; secrets are accessible inside the assistant container via `akm vault:user`.
- `tasks/` — AKM YAML task files for scheduled automations. AKM owns task enablement state.

System-managed runtime files live in `config/stack/`:
- `config/stack/stack.env` — system-managed non-secret configuration: paths, ports, image tags, profiles, and feature flags. Written by CLI/admin. Advanced users may edit directly with understanding of the compose substitution model.
- `stash/vaults/secrets/` — system-managed file secrets. Compose grants each service only the files it needs; containers receive secret paths through `*_FILE` variables.

**Rule:** the assistant reads user secrets via `akm vault:user` from its `/akm` stash bind mount. There is no separate `/etc/vault/` container mount. Guardian, channels, assistant, and any admin-adjacent service receive system secrets only as Compose secret files, never as broad env files or raw secret environment variables. The scheduler co-process inherits the assistant container's mounts and environment.

### 3) State (service-managed, durable)

**Location:** `~/.openpalm/state/`
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

Subtrees: `assistant/`, `guardian/`, `akm/` (akm operational state and state.db), `logs/` (consolidated log output).

Shared user knowledge lives in `stash/` (not `state/`) — see § Stash / Vaults above.
Regenerable artifacts live in `cache/akm/` — see § Cache below.
The shared work area lives in `workspace/`.

**Write policy:** Each container may write only to its own designated subdirectories via its mounts. The assistant writes to `state/assistant/`, `stash/`, `state/akm/`, `cache/akm/`, and `workspace/`; the guardian writes to `state/guardian/`; and so on. No container may access another service's data directories. Stack-wide data operations (creating new subtrees, managing other services' data) require the admin API.

### 4) Logs (audit and debug)

**Location:** `~/.openpalm/state/logs/`
**Purpose:** consolidated log output from all services.

Files: `guardian-audit.log` (channel ingress — guardian's own audit), plus
OpenCode session and tool-invocation logs under
`state/assistant/opencode/log/` and `state/admin-opencode/log/`.

The OpenPalm-side `admin-audit.jsonl` writer was removed in v0.11.0
(Phase 6 of `auth-and-proxy-refactor-plan.md` / D6a). OpenCode session
logs are the audit trail for chat + tool activity. UI/admin actions
(login, config writes) log to application stderr via
`createLogger('admin.*')`.

### 5) Cache (regenerable)

**Location:** `~/.openpalm/cache/` (and ephemeral system cache at `~/.cache/openpalm/`)
**Purpose:** regenerable data that does not need backing up.

Subtrees:
- `cache/akm/` — regenerable akm registry artifacts and per-run task logs; bind-mounted at `/akm-cache` in the assistant container.
- `cache/rollback/` — previous known-good config snapshots for automated rollback on deploy failure (also mirrored to `~/.cache/openpalm/rollback/`).

### 6) Backups

**Location:** `~/.openpalm/state/backups/`
**Purpose:** durable upgrade backup snapshots created by lifecycle operations before destructive transitions.

**Rule:** CLI/admin writes backup snapshots here before upgrades and major lifecycle changes. These are user-accessible for manual restore and are included in `tar` backups of `~/.openpalm/`. Unlike rollback snapshots (in `~/.cache/openpalm/rollback/`), backups are durable and not automatically cleaned up.

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining the fixed Compose file set with Compose's native multi-file merge rules. ([Docker Documentation][3])
**Implication:** the default file list is `core.compose.yml`, `services.compose.yml`, `channels.compose.yml`, and `custom.compose.yml`. First-party optional services are activated with Compose profiles. Custom containers and overlays belong in `custom.compose.yml`; rerunning Docker Compose with the same fixed file list and updated profiles applies changes.

### B) OpenCode: core precedence via baked-in `/etc/opencode`

- The assistant container includes core extensions/config at **`/etc/opencode`**.
- The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
- Advanced users *may* bind-mount a host directory over `/etc/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container's original contents. ([Docker Documentation][5])

### C) Non-destructive lifecycle sync is enforced by directory boundaries

To guarantee lifecycle operations never clobber user configuration:

- **`config/` is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults or does targeted updates and never overwrites existing user files. Explicit mutation paths — user direct edits, CLI/admin UI/API config actions, authenticated/allowlisted assistant calls to admin API on user request — may create/update/remove files as requested.
- **`config/stack/` is the live runtime assembly and system-managed configuration.** Automatic lifecycle sync may update `core.compose.yml`, `services.compose.yml`, `channels.compose.yml`, and non-secret `stack.env`. `custom.compose.yml` is seeded once and user edits always win.
- **`stash/vaults/` has strict access rules.** The assistant accesses user secrets via `akm vault:user` from its `/akm` stash mount. There is no separate `/etc/vault/` mount. No container mounts `stash/vaults/` directly. Lifecycle operations never overwrite `stash/vaults/user.env`; they may update non-secret `config/stack/stack.env` and system-managed secret files in `stash/vaults/secrets/`.
- **`state/` is service-writable within ownership boundaries.** Each container owns its designated state subdirectories. No container may access another service's data directories. Stack-wide data operations require the admin API.
- **Apply uses validate-in-place with snapshot rollback.** Changes are validated against temp copies (in `/tmp/openpalm`) before writing to live paths (`$OP_HOME/config/stack`). A snapshot of the current state is saved to `~/.cache/openpalm/rollback/` before any write. If deployment fails health checks, the snapshot is automatically restored. See § Rollback scope below for what is included in the snapshot.

### D) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### E) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---

## Shared control-plane library (`@openpalm/lib`)

All portable control-plane logic — lifecycle management, addon operations, secret resolution, path helpers, validation, Docker invocation, and configuration assembly — lives in `packages/lib/` (`@openpalm/lib`). Both the CLI and admin import from this package. **No control-plane logic may be duplicated between consumers.**

**Rules:**

- New control-plane functionality MUST be implemented in `@openpalm/lib`, not in CLI or admin source directly.
- The CLI calls lib functions directly. The admin calls them from API route handlers. The scheduler co-process calls them for automation execution. All get identical behavior.
- If a function exists in the admin that should be reusable (e.g., compose invocation, env file parsing, component discovery), it must be extracted to lib.
- Test coverage for control-plane logic belongs in lib's test suite, not duplicated across consumer test suites.

**Rationale:** The CLI must work without the admin UI process. The admin UI must work without the CLI. The scheduler must work without either. If control-plane logic is scattered across consumers, these guarantees break and behavior diverges.

---

## Service port assignments

Host-exposed OpenPalm services default to a small localhost-friendly port set. Core services use the `38xx` range and addon edges map their internal ports onto nearby host ports for manual use.

| Service | Internal Port | Default Host Bind | Purpose |
|---------|--------------|-------------------|---------|
| **Assistant** (OpenCode) | 4096 | `127.0.0.1:3800` | OpenCode web UI + API |
| **Voice addon** | 8186 | `127.0.0.1:3810` | Voice interface (TTS/STT) |
| **Admin** | 8100 | `127.0.0.1:3880` | Admin UI + API |
| **Guardian** | 8080 | (internal only) | HMAC verification + rate limiting |
| **Chat addon** | 8181 | `127.0.0.1:3820` | OpenAI-compatible chat edge |
| **API addon** | 8182 | `127.0.0.1:3821` | OpenAI/Anthropic-compatible API edge |

Port assignments are defined via `OP_*_PORT` variables in non-secret `config/stack/stack.env` and referenced in compose files via `${VAR}` substitution.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly.

Admin is a host binary (not a Docker service). Its SvelteKit build runs on the host via `npm run build` and is embedded in the CLI binary as a tarball.

### Guardian + Channels (Bun runtime)

These Dockerfiles copy `packages/channels-sdk` source into `/app/node_modules/@openpalm/channels-sdk` and install sdk dependencies afterward:

```dockerfile
RUN cd /app/node_modules/@openpalm/channels-sdk && bun install --production
```

This ensures sdk transitive dependencies are available at runtime.

**Rules:**

- Every Dockerfile that copies `packages/channels-sdk` must run `bun install --production` inside the copied sdk directory.
- If `packages/channels-sdk/package.json` gains new dependencies, all service Dockerfiles automatically pick them up — no per-service changes needed.

---

## Addon secret lifecycle

When a channel addon is installed, the following secret distribution flow occurs:

1. **Generation:** a shared HMAC secret is generated by the CLI or admin during addon install.
2. **Guardian side:** the secret is written as a `0600` file under `stash/vaults/secrets/` and granted only to the guardian through Compose `secrets:`. Guardian receives the path through a `*_FILE` environment variable.
3. **Channel side:** the same secret is granted only to the matching channel service through Compose `secrets:`. The channel receives the path through a `*_FILE` environment variable so the channels-sdk can sign outbound requests.
4. **Verification:** on every inbound request, guardian verifies the HMAC signature using the channel's secret, rejects replayed nonces, and enforces rate limits before forwarding to the assistant.

Secret grants are intentionally narrow: assistant services may receive assistant/provider/user secret files, guardian may receive guardian and channel verification secret files, channel services may receive only their own channel secret files, and admin host processes read required secrets directly from the host filesystem. `stack.env` must not contain secret-like keys, Compose services must not use broad `env_file`, and secret-like container variables must be `*_FILE` paths.

Both sides must have the same secret value. Rotating a channel secret requires updating both the guardian's secret store and the channel's env, then restarting the channel (guardian picks up the change via hot-reload if using `GUARDIAN_SECRETS_PATH`).

---

## Addon conflict detection

Addon overlays may extend core services by injecting environment variables or volumes into core service definitions via Compose multi-file merge. This is standard Docker Compose merge behavior — no custom merging logic is involved. ([Docker Documentation][3])

**Known limitation:** the validate-in-place step checks that the assembled compose config is syntactically valid, but it does not detect semantic conflicts between addons — for example, two addons setting different values for the same environment variable on a core service. In such cases, Compose's last-file-wins merge order determines the final value. Users installing multiple addons that target the same core service env vars should review the assembled config.

---

## Rollback scope

When the CLI or admin performs an apply operation, a snapshot is saved to `~/.cache/openpalm/rollback/` before any writes. The snapshot includes:

- `config/stack/` — the full live compose assembly, non-secret runtime env, file-based system secrets, and addon overlays (`core.compose.yml`, `stack.env`, `secrets/`, `addons/`)

The snapshot does **not** include `config/` user files (non-destructive for user edits), `stash/vaults/user.env` (never overwritten by lifecycle operations), or `state/` (service-owned runtime state).

On health check failure after deploy, the snapshot is automatically restored and the stack is restarted. Manual rollback is available via `openpalm rollback`.

---

## Operational behavior

- **Add an addon:** drop `compose.yml` into `stack/addons/<n>/`, then rerun `docker compose up -d` with that addon included. ([Docker Documentation][3])
- **Add an extension (user):** copy OpenCode assets into `config/assistant/` following OpenCode's directory structure. ([OpenCode][1])
- **Core precedence:** core extensions live in `/etc/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
- **Apply changes:** the CLI or admin validates proposed changes (compose config and secret-audit rules) before writing anything. If validation passes, a snapshot of current live files is saved to `~/.cache/openpalm/rollback/` (see § Rollback scope), changes are written to live paths, and `docker compose up -d` is run. If services fail health checks, the snapshot is automatically restored. No string interpolation or template expansion — just whole-file writes and Compose native `--env-file` substitution for non-secret values. Compose is normally invoked with non-secret `config/stack/stack.env`; service secrets live under `stash/vaults/secrets/` and are granted via Compose `secrets:`. `stash/vaults/user.env` is not a Compose env-file. Automatic lifecycle apply (startup/install/update/setup reruns/upgrades) is non-destructive for `config/` user files and `stash/vaults/user.env`; it may seed missing defaults, do targeted updates, and update system-managed files in `config/stack/`.
- **Addon overlays may extend core services.** Addon compose files can inject environment variables or volumes into core service definitions via Compose multi-file merge. For example, an addon can add environment entries to the assistant service by defining an `assistant:` block with additional `environment:` entries in its overlay. This is standard Docker Compose merge behavior — no custom merging logic is involved. See § Addon conflict detection for limitations.
- **API key changes require restart:** provider API keys live as files under `stash/vaults/secrets/` or in OpenCode auth state, depending on the provider path, and containers receive file paths through `*_FILE` variables. Changing keys requires a stack restart (`docker compose up -d`) for services that read the file only at startup.
- **Rollback:** `openpalm rollback` restores the most recent snapshot from `~/.cache/openpalm/rollback/` and restarts the stack. Available both as an automated response to failed deploys and as a manual escape hatch. See § Rollback scope for snapshot contents.
- **Backup/restore:** `tar czf backup.tar.gz ~/.openpalm` archives the entire stack. Restore is extract and `docker compose up -d` — no staging tier to reconstruct.

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"

[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"
