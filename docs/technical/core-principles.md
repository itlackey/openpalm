# Core Principles

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

The foundation of the OpenPalm stack is simply a set of conventions used to manage Docker compose overlay files, .env files, and configuration files related to specific services in the stack. That is it. That is what the entire stack is built upon.

There is one always-on core container, the assistant, an OpenCode-based service. The assistant uses the akm CLI (with the host `knowledge/` directory bind-mounted at `/stash`) for persistent memory, skills, lessons, and knowledge — there is no separate memory service. The guardian is a second OpenCode-based service, but it is **not** a core container: it is profile-gated in `portals.compose.yml` and Compose deploys it only when a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, or `gateway`) is enabled. Once deployed, the guardian verifies and forwards portal traffic; its bundled OpenCode runtime additionally powers **content validation** of inbound messages, which the shipped compose turns on by default (see § Guardian-only ingress for the fail-closed policy and the code-vs-compose default split). When the guardian is running, both OpenCode runtimes share one provider-credential file (`knowledge/secrets/auth.json`). Automation scheduling runs as a Bun co-process inside the assistant container (no separate service, no network port).

The stack allows for three primary extension points.

1. **Addons** are Docker compose overlay files to add services to the stack.
2. **Assistant extensions** are standard OpenCode resources that are mounted into the assistant container.
3. **Automations** that run on the scheduler co-process inside the assistant container and have direct in-container access to the assistant to execute workflows on a recurring basis.

The stack defines a special type of addon, referred to as a portal-style ingress addon. These services use the `openpalm/portal` docker image for baked protocol adapters such as Discord and Slack, while guardian-hosted ingress surfaces such as the OpenAI-compatible API and MCP gateway run from the `openpalm/guardian` image. These are the entry points to the stack for external protocols. Addons that provide services/tools to the rest of the stack can also be added — these can be any container you have access to pull (ollama for example, or the voice static file server which serves a browser UI without a guardian pipeline).

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
    - Assistant name, email, persona (there is no "assistant token" — the assistant holds no admin credential; the admin UI's own session is an `httpOnly` cookie, not a user-managed token)
  - Editor for addon configurations/environments
    - This is for the standard .env.schema and any specific configuration files needed by the addon.

All of this functionality exists to simplify managing files under the OP_HOME directory. The base line is managing compose and schema files under OP_HOME/config/stack, non-secret runtime env in OP_HOME/knowledge/env/stack.env, file-based service secrets under OP_HOME/knowledge/secrets, user-managed AKM env data under OP_HOME/knowledge/env, configuration/automation files under OP_HOME/config, and service-specific files under OP_HOME/data. These tasks should be achievable by a technical user without the tooling by manually editing files and placing them in the proper locations.

## Security invariants

These are hard constraints that must never be violated during development. See also the Security boundaries summary in `foundations.md`, which provides a condensed version of these rules for quick reference.

1. **Host CLI or admin is the orchestrator.** The host CLI manages Docker Compose directly on the host. The admin UI is a host process (a Bun.serve server started by `openpalm`) that serves the `@openpalm/ui` SvelteKit build (resolved from `OP_HOME/data/ui`, seeded on install/update from the npm registry) and manages Docker Compose via the host Docker socket. There is no admin container. Only one orchestrator should manage compose operations at a time. The Docker socket is never exposed to any container.
2. **Guardian-only ingress.** The guardian is deployed on demand (Compose profile-gated in `portals.compose.yml`, not present in `core.compose.yml`) whenever a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, `gateway`) is enabled; when deployed, all portal traffic enters through it, which enforces principal authentication (HTTP Basic + constant-time sha256 token compare against a per-principal hash, `auth.ts`), endpoint allowlisting, ownership checks, rate limiting, and content validation. No portal may communicate directly with the assistant. Principal secrets are distributed during addon install (see § Addon secret lifecycle below). The `x-openpalm-user` header, when present on an authenticated request, is trusted as the acting user id without further verification — isolation is between *principals* (one token per portal deployment), and a portal fronts many end users under that one principal token, so the header is a documented design property of that model, not a bug. The guardian additionally runs a **content-validation** stage before forwarding: a deterministic heuristic pre-screen escalates suspicious messages to a local OpenCode moderator (loopback, small model, shared provider creds) that returns an allow/flag/block verdict. The policy is **fail-closed** — an escalated message the moderator cannot classify is blocked. This stage's default is split across two layers: the guardian package's own code fallback is off when `GUARDIAN_CONTENT_VALIDATION` is completely unset, but the shipped `portals.compose.yml` sets `GUARDIAN_CONTENT_VALIDATION:-1`, so every install using the shipped compose runs with content validation **on** unless an operator explicitly opts out. The guardian also runs a separate authenticated admin listener (port 3831, `GUARDIAN_ADMIN_TOKEN_FILE`) for principal CRUD (`/admin/principals`) — a Bearer token compared constant-time, empty-configured-token denies all.
3. **Assistant isolation.** The assistant has no Docker socket and no broad host filesystem access beyond its designated mounts: `system/assistant/ -> /etc/opencode` (`OPENCODE_CONFIG_DIR`, the managed OpenCode config OpenCode actually loads instructions/plugins from), `config/assistant/ -> /home/opencode/.config/opencode` (the user's own OpenCode global config, nested over `HOME`), `config/akm/ -> /etc/akm`, `knowledge/secrets/auth.json -> /home/opencode/.local/share/opencode/auth.json`, `data/assistant/ -> /home/opencode`, `knowledge/ -> /stash` (shared akm knowledge), `data/akm/cache/ -> /opt/akm/cache`, `data/akm/data/ -> /opt/akm/data`, `workspace/ -> /work`, `data/assistant/tools/ -> /opt/openpalm/tools` (operator-pinnable tool packages), the `assistant-artifacts` named volume at `/opt/openpalm` (platform artifact cache), and the `assistant-persistent` named volume at `/opt/persistent`. The host AKM secondary stash (`OP_HOST_AKM_STASH`, or an always-present empty directory when unset) is always mounted at `/host-stash`; the container never chowns it. There is no `/etc/vault/` mount; user secrets are read via `akm env:user`. The assistant has no network path to the host admin process (which binds to `127.0.0.1` only) and no admin tools — it cannot perform stack operations. Stack operations are handled exclusively by the host CLI and admin UI.
4. **Host only by default.** Admin interfaces, dashboards, and portals are host-restricted by default. Nothing is exposed to the network or internet without explicit user opt-in. The admin UI uses an `httpOnly` `SameSite=Strict` session cookie (no `localStorage` token). A `Host` header allowlist on every handler closes DNS rebinding. The admin process binds to `127.0.0.1` only by default and is not exposed unless the operator opts in via `OP_ALLOW_REMOTE_SETUP=1`, which binds the UI server to `0.0.0.0` and relaxes the Host/Origin allowlist and the setup-localhost-only gate for genuine LAN access — it is an explicit, documented opt-in (see `environment-and-mounts.md`), not an impossibility, and should only be enabled on a trusted network behind a firewall. **OpenCode auth (`OPENCODE_AUTH`) is disabled by default** because all host port bindings default to `127.0.0.1` (loopback-only) and the guardian communicates with the assistant over Docker's `assistant_net` network without credentials. If a user changes `OP_ASSISTANT_BIND_ADDRESS` to `0.0.0.0`, that is outside the supported hardening path for 0.12.0's guardian-managed ingress; the assistant no longer has guardian-side upstream auth plumbing to pair with `OPENCODE_AUTH`.
5. **Scheduler access is scoped to automation needs.** The scheduler co-process inherits the assistant container's mounts and environment and shares `knowledge/tasks/`, `data/akm/cache/`, and `data/akm/data/`. It calls `http://localhost:4096` for `assistant`-type actions only. Stack-level cron jobs run via host OS cron using the CLI (`openpalm` commands), not via an in-container admin API call.
6. **Admin is host-only by default.** Admin binds to `127.0.0.1` by default and is not reachable from the Docker bridge network or any container in that default configuration. This is not absolute: `OP_ALLOW_REMOTE_SETUP=1` is the sanctioned opt-in that binds the admin process to `0.0.0.0` for LAN access (§ Host only by default above), and the assistant container's `extra_hosts: host.docker.internal:host-gateway` gives it a route to the host once that bind is `0.0.0.0`. The admin process manages Docker Compose directly on the host via the host Docker socket — there is no docker-socket-proxy container.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **writing whole files** or **targeted edits** — never by string interpolation, template expansion, or dynamic code generation. The CLI or admin validates proposed changes, writes them to live paths, and uses Docker Compose natively for variable substitution. All control-plane logic lives in `@openpalm/lib` — both CLI and admin import from this shared library. OpenCode core config is image-baked at `/etc/opencode`, with user extensions mounted from `config/assistant/`.

All OpenPalm state lives under a single root: **`~/.openpalm/`** (configurable via `OP_HOME`). Ephemeral cache lives at `~/.cache/openpalm/`.

### 1) Config (user-owned, non-secret)

**Location:** `~/.openpalm/config/`
**Purpose:** user-editable, non-secret configuration. Automations, OpenCode extensions, and user-managed stack settings.

Subtrees:

- `assistant/` — user OpenCode extensions for the assistant (tools, plugins, skills); mounted at the assistant's `/etc/opencode`
- `guardian/` — the operator-tunable moderation **model** setting (`opencode.json`); mounted at the guardian's `~/.config/opencode` (`HOME=/opt/openpalm/guardian`)
- `akm/` — AKM configuration (LLM, embedding, and related settings in `config.json`)
- `endpoints.json` — OpenCode connection list (URL, label, optional password per endpoint) used by the admin UI's connection switcher; mode 0600. Survives `data/` wipes by design.

**Rule:** allowed writers are: user direct edits and explicit admin UI/API config actions. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults or make targeted updates.

**Guardian managed config (moderation.md is not user-editable):** the moderation classifier's instructions (`instructions/moderation.md`) and the guardian's `opencode.jsonc` live in the MANAGED `system/guardian/` tree, bind-mounted at the guardian's `OPENCODE_CONFIG_DIR=/etc/opencode` — the same managed tree as the rest of `system/`. Like every other file there, `overwriteSystemTree` (`packages/lib/src/control-plane/core-assets.ts`) overwrites it on every install/update/hot-swap refresh whenever its content differs from the shipped default, backing up the previous copy first; there is no skip-if-user-modified exception. It was deliberately **not** relocated to `config/guardian/` (the user tree): that directory mounts at the guardian's `~/.config/opencode`, a different path than `OPENCODE_CONFIG_DIR=/etc/opencode`, so relocating the file there would silently stop OpenCode from loading it. Operators who need different moderation behavior tune the **model** via `config/guardian/opencode.json` (the `guardian/` subtree above); the classifier instructions text itself is managed, not user-editable.

### 1b) Stack (system-managed runtime assembly)

**Location:** `~/.openpalm/config/stack/`
**Purpose:** live Docker Compose assembly used to run the stack.

Subtrees:

- `core.compose.yml` — base compose definition for core assistant runtime services
- `services.compose.yml` — system-managed first-party optional services, profile-gated
- `portals.compose.yml` — system-managed first-party optional portals, profile-gated
- `custom.compose.yml` — user-editable custom services and overlays, seeded once and never overwritten automatically

First-party optional services are enabled by updating `OP_ENABLED_ADDONS` in `knowledge/env/stack.env`; OpenPalm resolves those names to Compose profiles when it builds the Docker Compose command. Explicit manual `--profile` arguments remain valid for ad hoc Docker Compose use. OpenPalm does not generate `addons.compose.yml`, does not write `enabled-addons.json`, and does not use a runtime registry catalog.

### 2) Knowledge / Vaults (user-managed secrets and knowledge)

**Location:** `~/.openpalm/knowledge/`
**Purpose:** AKM knowledge base and user-managed secrets. The `knowledge/` directory is bind-mounted into the assistant at `/stash`.

Subtrees:

- `env/user.env` — AKM env backing file for user-managed secrets. It is not a Compose `--env-file`; secrets are accessible inside the assistant container via `akm env:user`.
- `tasks/` — AKM YAML task files for scheduled automations. AKM owns task enablement state.

System-managed runtime configuration and secrets live under `knowledge/`:
- `knowledge/env/stack.env` — system-managed non-secret configuration: paths, ports, image tags, profiles, and feature flags. Written by CLI/admin. Advanced users may edit directly with understanding of the compose substitution model.
- `knowledge/secrets/` — system-managed file secrets. Compose grants each service only the files it needs; containers receive secret paths through `*_FILE` variables.

**Rule:** the assistant reads user secrets via `akm env:user` from its knowledge bind mount (host `knowledge/` at `/stash`). There is no separate `/etc/vault/` container mount. Guardian, portals, assistant, and any admin-adjacent service receive system secrets only as Compose secret files, never as broad env files or raw secret environment variables. The scheduler co-process inherits the assistant container's mounts and environment.

### 3) Data (service-managed, durable)

**Location:** `~/.openpalm/data/`
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

Subtrees: `assistant/`, `guardian/`, `akm/cache/`, `akm/data/`, `logs/`, `backups/`, `rollback/`.

Shared user knowledge lives in `knowledge/` (not `data/`) — see § Stash / Vaults above.
Ephemeral regenerable artifacts live outside `OP_HOME` under `~/.cache/openpalm/`.
The shared work area lives in `workspace/`.

**Write policy:** Each container may write only to its own designated subdirectories via its mounts. The assistant writes to `data/assistant/`, `knowledge/`, `data/akm/cache/`, `data/akm/data/`, `workspace/`, and `/opt/persistent`; the guardian writes to `data/guardian/` and `data/logs/`; and so on. No container may access another service's data directories. Stack-wide data operations require the host CLI or admin UI.

### 4) Logs (audit and debug)

**Location:** `~/.openpalm/data/logs/`
**Purpose:** consolidated log output from all services.

Files: `guardian-audit.log` (portal ingress — guardian's own audit), plus
OpenCode session and tool-invocation logs under
`data/assistant/.local/state/opencode/` and `data/admin-opencode/log/`.

The OpenPalm-side `admin-audit.jsonl` writer was removed in v0.11.0
(Phase 6 of `auth-and-proxy-refactor-plan.md` / D6a). OpenCode session
logs are the audit trail for chat + tool activity. UI/admin actions
(login, config writes) log to application stderr via
`createLogger('admin.*')`.

### 5) Rollback

**Location:** `~/.openpalm/data/rollback/`
**Purpose:** previous known-good config snapshots for automated rollback on deploy failure.

Ephemeral system cache, when needed, belongs under `~/.cache/openpalm/`, not in the user-facing `OP_HOME` layout.

### 6) Backups

**Location:** `~/.openpalm/data/backups/`
**Purpose:** durable upgrade backup snapshots created by lifecycle operations before destructive transitions.

**Rule:** CLI/admin writes backup snapshots here before upgrades and major lifecycle changes. These are user-accessible for manual restore and should be treated as durable operator state.

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining the fixed Compose file set with Compose's native multi-file merge rules. ([Docker Documentation][3])
**Implication:** the default file list is `core.compose.yml`, `services.compose.yml`, `portals.compose.yml`, and `custom.compose.yml`. First-party optional services are activated with Compose profiles. Custom containers and overlays belong in `custom.compose.yml`; rerunning Docker Compose with the same fixed file list and updated profiles applies changes.

### B) OpenCode: core precedence via baked-in `/etc/opencode`

- The assistant container includes core extensions/config at **`/etc/opencode`**.
- The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
- Advanced users *may* bind-mount a host directory over `/etc/opencode` to override core behavior, but this is discouraged because bind-mounting replaces/obscures the container's original contents. ([Docker Documentation][5])
- The guardian image likewise sets `OPENCODE_CONFIG_DIR=/etc/opencode`, bind-mounted from the MANAGED `system/guardian/` tree (instructions, permissions, plugin config — the malicious-message taxonomy the content-validation stage uses). The operator-tunable moderation **model** setting is separate: `config/guardian/opencode.json`, bind-mounted from the USER tree at the guardian's `~/.config/opencode`.

### C) Non-destructive lifecycle sync is enforced by directory boundaries

To guarantee lifecycle operations never clobber user configuration:

- **`config/` is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults or does targeted updates and never overwrites existing user files. Explicit mutation paths — user direct edits and CLI/admin UI/API config actions — may create/update/remove files as requested. A **layout migration** is the one automatic path permitted to *remove* files, and only SYSTEM-managed inert ones (e.g. a renamed/retired compose overlay the control plane no longer loads) via an explicit allowlist in `migrations.ts` — never user data, never a heuristic sweep, and only because the layout-migration path takes a full OP_HOME backup first (abort-if-fails), so a stamped layout bump is always recoverable. An inert file that *holds* user data is relocated, not dropped.
- **`config/stack/` is the live runtime assembly.** Automatic lifecycle sync may update `core.compose.yml`, `services.compose.yml`, and `portals.compose.yml`. `custom.compose.yml` is seeded once and user edits always win. Non-secret runtime configuration lives in `knowledge/env/stack.env`.
- **`knowledge/env/` has strict access rules.** The assistant accesses user secrets via `akm env:user` from its `/stash` stash mount. There is no separate `/etc/vault/` mount. No container mounts `knowledge/env/` directly. Lifecycle operations never overwrite `knowledge/env/user.env`; they may update non-secret `knowledge/env/stack.env` and system-managed secret files in `knowledge/secrets/`.
- **`data/` is service-writable within ownership boundaries.** Each container owns its designated data subdirectories. No container may access another service's data directories. Stack-wide data operations require the admin API.
- **Apply uses validate-in-place with snapshot rollback.** Changes are validated against temp copies (in `/tmp/openpalm`) before writing to live paths (`$OP_HOME/config/stack`). A snapshot of the current stack configuration is saved to `$OP_HOME/data/rollback/` before any write. If deployment fails health checks, the snapshot is automatically restored. See § Rollback scope below for what is included in the snapshot.

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

## Thin-harness boundary (Electron) and harness-contract discipline

The Electron desktop app is a **thin native harness**, not a copy of the control plane. Re-downloading the app is required **only when the native harness surface itself changes** — `BrowserWindow` / `Tray` / IPC channels / preload bridge / native modules / entitlements / PATH shims. Everything else self-updates in place over npm (`@openpalm/ui` → `data/ui`) and `compose pull` (stack images) with **no app re-download**: the admin UI build, the `@openpalm/lib` control plane (including `RELEASE_MIGRATIONS` and the lifecycle deploy path), and the CLI's view of the served UI.

**Hard rules:**

- **The frozen harness bundle runs no migrations.** `packages/electron/dist/main.js` (inlined into the asar) MUST contain **zero** mutating control-plane symbols (`ensureReleaseMigrated`, `RELEASE_MIGRATIONS`, `performUpgrade`, `applyTagChange`). Every state-mutating operation runs in the spawned `data/ui` control plane, which carries its own inlined `@openpalm/lib`. The CI guard `scripts/validate-thin-harness-boundary.sh` enforces this (and that the UI build *does* carry those symbols).
- **`main.ts` imports only the bootstrap allowlist from `@openpalm/lib`** — path resolvers, `ensureHomeDirs`, `seedOpenPalmDir`, `seedUiBuild`, `checkAndUpdateUiBuild`, `uiUpdateChannel`, `parseEnvFile`, `PLATFORM_VERSION`, and the Docker preflight probes (`checkDocker`/`checkDockerCompose`). Adding any mutating control-plane symbol to that import set fails CI. This is the mechanical expression of "the harness is bootstrap-only."
- **`data/ui` is the steady-state executor.** Supervisors (the Electron harness and `openpalm ui serve`) call `checkAndUpdateUiBuild` before resolving + spawning, so a strictly-newer `data/ui` always wins. A de-route back to the frozen bundled lib (missing/stale stamp) MUST be logged, never silent (`resolveUiBuildDir`).
- **Two independent version lines.** `PLATFORM_VERSION` (in `@openpalm/lib`, travels with `data/ui`) bumps on every control-plane/migration/UI release and **never** forces a re-download. `HARNESS_CONTRACT_VERSION` (a single integer in `packages/electron/src/harness-contract.ts`) bumps **only** when the §5.1 contract surface — renderer IPC bridge, spawn-env keys, or FS/spawn conventions — changes name/argument/return/required-key, and **does** force a re-download. Never feed `app.getVersion()` into control-plane inputs.
- **Self-update-vs-redownload gate.** A published `@openpalm/ui` build declares `minHarnessContract`. The harness self-updates only when `minHarnessContract ≤ HARNESS_CONTRACT_VERSION`; otherwise it refuses the pull and prompts a re-download (running newer-UI-on-older-harness fails at runtime).
- **Harness-contract discipline.** When you change anything in the §5.1 surface (see `harness-contract.ts`), bump `HARNESS_CONTRACT_VERSION` **and** update the `HARNESS_CONTRACT` description in the same change. A snapshot test fails CI until the bump is intentional — it enforces that a change was *noticed*, not that the bump is semantically right; that judgement is the contributor's.

Full rationale and the file-level history live in [`electron-thin-harness-design.md`](./electron-thin-harness-design.md) and the deployment/upgrade UX findings in [`deployment-upgrade-ux-review.md`](./deployment-upgrade-ux-review.md).

---

## Service port assignments

Host-exposed OpenPalm services default to a small localhost-friendly port set. Core services use the `38xx` range and addon edges map their internal ports onto nearby host ports for manual use.

| Service | Internal Port | Default Host Bind | Purpose |
|---------|--------------|-------------------|---------|
| **Assistant** (OpenCode) | 4096 | `127.0.0.1:3800` | OpenCode web UI + API |
| **Voice addon** | 8880 | `127.0.0.1:8880` (`OP_VOICE_BIND_ADDRESS`) | Voice interface (TTS/STT) |
| **Admin** | n/a — host process, not a container | `127.0.0.1:3880` | Admin UI + API (`openpalm ui serve`) |
| **Guardian gateway** | 8080 | (internal only — no `ports:` publication) | Principal auth, `/oc/*` proxy, rate limiting, content validation |
| **Guardian moderator** (OpenCode) | 4097 | (loopback only) | Local content-moderation model |
| **Guardian direct listener** | 3830 | `127.0.0.1:3830` (`OP_BIND_ADDRESS`) | Direct (non-portal) ingress; the port is always published, but the listener itself 404s everything unless `GUARDIAN_DIRECT_INGRESS=true` (default `false`) |
| **Guardian admin listener** | 3831 | `127.0.0.1:3831` (hardcoded, not bind-overridable) | Principal CRUD (`/admin/principals`), Bearer-token auth via `GUARDIAN_ADMIN_TOKEN_FILE` |
| **Chat addon** (OpenAI-compatible) | 8182 | `127.0.0.1:3820` (`OP_CHAT_BIND_ADDRESS`) | Maps to the **same** internal 8182 listener as the API addon below — there is one OpenAI-compatible server (`GUARDIAN_OPENAI_PORT=8182`) inside the guardian container, published on two host ports |
| **API addon** (OpenAI/Anthropic-compatible) | 8182 | `127.0.0.1:3821` (`OP_API_BIND_ADDRESS`) | Same internal 8182 listener as the chat addon above |

Port assignments are defined via `OP_*_PORT` variables in non-secret `knowledge/env/stack.env` and referenced in compose files via `${VAR}` substitution. The guardian's internal `/stats` endpoint (served on the gateway listener above) currently has **no authentication** and the listener binds all interfaces rather than a single network — see the tracked hardening item for this gap; it is not yet fixed.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly.

Admin is a host binary (not a Docker service). The `@openpalm/ui` SvelteKit app is **independently versioned and published to npm** (it lives in `independentNpmPackages` in `.github/release-package-groups.json`, not in `platformManifests`). The CLI seeds it into `OP_HOME/data/ui` on install/update by fetching the npm registry tarball, verifying the `dist.integrity` sha512 hash fail-closed, and atomically swapping the build into place. The Electron desktop app additionally bundles a copy of the UI build at compile time via `extraResources` and auto-updates it from npm at launch via `checkAndUpdateUiBuild`.

### Guardian + Portals (Bun runtime)

These Dockerfiles install each service's own dependencies directly inside the image:

This ensures each service's local runtime dependencies are available at runtime.

**Rules:**

- Every Dockerfile that bakes a service from the workspace must install that service's declared runtime dependencies during the image build.
- Guardian-local helpers stay in `packages/guardian/src/` (`@openpalm/guardian`); adapter-local helpers stay inside the adapter package that uses them.
- The assistant **and the guardian** images install the OpenCode binary (the guardian uses it for content validation). Keep `OPENCODE_VERSION` in lockstep between `containers/assistant/Dockerfile` and `containers/guardian/Dockerfile`.

---

## Addon secret lifecycle

When a portal addon is installed, the following secret distribution flow occurs:

1. **Generation:** a per-principal shared secret is generated by the CLI or admin during addon install.
2. **Guardian side:** the secret is written as a `0600` file under `knowledge/secrets/` and granted only to the guardian through Compose `secrets:`. Guardian uses those files to seed principal records at boot.
3. **Portal side:** the same secret is granted only to the matching portal service through Compose `secrets:`. The portal receives the path through `PRINCIPAL_SECRET_FILE` and authenticates every `/oc/*` call with Basic auth.
4. **Verification:** on every inbound request, guardian authenticates the principal, enforces allowlist/ownership/rate-limit checks, and, when content validation is enabled, screens prompt-bearing traffic before forwarding to the assistant.

Secret grants are intentionally narrow: assistant services may receive assistant/provider/user secret files, guardian may receive guardian and portal verification secret files, portal services may receive only their own portal secret files, and admin host processes read required secrets directly from the host filesystem. `stack.env` must not contain secret-like keys, Compose services must not use broad `env_file`, and secret-like container variables must be `*_FILE` paths.

Both sides must have the same secret value. Rotating a portal principal secret requires updating both secret files, then recreating the guardian and affected portal services so both read the new value.

---

## Addon conflict detection

Addon overlays may extend core services by injecting environment variables or volumes into core service definitions via Compose multi-file merge. This is standard Docker Compose merge behavior — no custom merging logic is involved. ([Docker Documentation][3])

**Known limitation:** the validate-in-place step checks that the assembled compose config is syntactically valid, but it does not detect semantic conflicts between addons — for example, two addons setting different values for the same environment variable on a core service. In such cases, Compose's last-file-wins merge order determines the final value. Users installing multiple addons that target the same core service env vars should review the assembled config.

---

## Rollback scope

When the CLI or admin performs an apply operation, a snapshot is saved to `$OP_HOME/data/rollback/` before any writes. The snapshot includes:

- `config/stack/` — the full live compose assembly, non-secret runtime env, file-based system secrets, and compose files (`core.compose.yml`, `portals.compose.yml`, `services.compose.yml`, `custom.compose.yml`, `stack.env`, `secrets/`)

The snapshot does **not** include `config/` user files outside `config/stack/` (non-destructive for user edits), `knowledge/env/user.env` (never overwritten by lifecycle operations), or `data/` (service-owned runtime data).

On health check failure after deploy, the snapshot is automatically restored and the stack is restarted. Manual rollback is available via `openpalm rollback`.

---

## Operational behavior

- **Add an addon:** update `OP_ENABLED_ADDONS` in `~/.openpalm/knowledge/env/stack.env` (for first-party addons) or add a service block to `custom.compose.yml` (for custom services), then rerun the compose command with the appropriate `--profile addon.<name>` arguments. ([Docker Documentation][3])
- **Add an extension (user):** copy OpenCode assets into `config/assistant/` following OpenCode's directory structure. ([OpenCode][1])
- **Core precedence:** core extensions live in `/etc/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
- **Apply changes:** the CLI or admin validates proposed changes (compose config and secret-audit rules) before writing anything. If validation passes, a snapshot of current live files is saved to `$OP_HOME/data/rollback/` (see § Rollback scope), changes are written to live paths, and `docker compose up -d` is run. If services fail health checks, the snapshot is automatically restored. No string interpolation or template expansion — just whole-file writes and Compose native `--env-file` substitution for non-secret values. Compose is normally invoked with non-secret `knowledge/env/stack.env`; service secrets live under `knowledge/secrets/` and are granted via Compose `secrets:`. `knowledge/env/user.env` is not a Compose env-file. Automatic lifecycle apply (startup/install/update/setup reruns/upgrades) is non-destructive for `config/` user files and `knowledge/env/user.env`; it may seed missing defaults, do targeted updates, and update system-managed files in `config/stack/`.
- **Addon overlays may extend core services.** Addon compose files can inject environment variables or volumes into core service definitions via Compose multi-file merge. For example, an addon can add environment entries to the assistant service by defining an `assistant:` block with additional `environment:` entries in its overlay. This is standard Docker Compose merge behavior — no custom merging logic is involved. See § Addon conflict detection for limitations.
- **API key changes require restart:** provider API keys live as files under `knowledge/secrets/` or in OpenCode auth state, depending on the provider path, and containers receive file paths through `*_FILE` variables. Changing keys requires a stack restart (`docker compose up -d`) for services that read the file only at startup.
- **Rollback:** `openpalm rollback` restores the most recent snapshot from `$OP_HOME/data/rollback/` and restarts the stack. Available both as an automated response to failed deploys and as a manual escape hatch. See § Rollback scope for snapshot contents.
- **Backup/restore:** `tar czf backup.tar.gz ~/.openpalm` archives the entire stack. Restore is extract and `docker compose up -d` — no staging tier to reconstruct.

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"

[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"
