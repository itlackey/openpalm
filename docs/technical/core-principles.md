# Core Principles

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

The foundation of the OpenPalm stack is simply a set of conventions used to manage Docker compose overlay files, .env files, and configuration files related to specific services in the stack. That is it. That is what the entire stack is built upon.

There is one always-on core container, the assistant, an OpenCode-based service. The assistant uses the akm CLI (with the host `knowledge/` directory bind-mounted at `/stash`) for persistent memory, skills, lessons, and knowledge; there is no separate memory service. Guardian is also OpenCode-based, but it is **not** a core container: it is profile-gated in `portals.compose.yml` and Compose deploys it only when a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, or `gateway`) is enabled. Once deployed, Guardian authenticates and forwards portal traffic; its bundled OpenCode runtime powers content validation, which defaults on in both package code and shipped Compose. The assistant bind-mounts provider `knowledge/secrets/auth.json`; Guardian receives that same file as one Compose secret and mounts no `knowledge/` tree. Automation scheduling uses BusyBox `crond` plus `akm tasks sync` inside the assistant container, with no separate service or network port.

The stack allows for three primary extension points.

1. **Addons** are profile-gated services in managed Compose or user-defined services in `config/stack/custom.compose.yml`.
2. **Assistant extensions** are standard OpenCode resources that are mounted into the assistant container.
3. **Automations** defined as AKM YAML task files and registered with BusyBox `crond` by `akm tasks sync`. Supported targets are `command`, `prompt`, and `workflow`.

The stack defines a special type of addon, referred to as a portal-style ingress addon. These services use the `openpalm/portal` docker image for baked protocol adapters such as Discord and Slack, while guardian-hosted ingress surfaces such as the OpenAI-compatible API and MCP gateway run from the `openpalm/guardian` image. These are the entry points to the stack for external protocols. Addons that provide services/tools to the rest of the stack can also be added — these can be any container you have access to pull (Ollama, for example, or the loopback-only Voice API reached through the host UI's `/voice` pass-through).

## File System

Golden rules:

- **Convention over configuration** is a foundational principle in this repo. Simplicity and predictability are key features.
- **Tooling is a thin wrapper over existing tech** and should be as simple and light weight as possible. The goal is for CLI, admin, setup wizard and other management tools to be additive convenience tools, not required infrastructure tooling. This means making the most of foundational dependencies like Docker compose, etc.
- **Leverage Docker Compose and OpenCode configuration features** to avoid custom config/orchestration implementations.
- **Manual management should be easy** for users familiar with Docker compose and opencode configuration. Tooling beyond docker compose (or compatible) should not be required.
- **Add containers and routes by file-drop** into known host locations (no code changes required).
- **Add assistant extensions by copying OpenCode assets** into known host locations.
- **Core container and routing configuration is stored on the host** for advanced users.
- **Every file on disk is a real, complete, hand-editable file** — never a template awaiting expansion. Variable substitution is Docker Compose's native `${VAR}` against an `--env-file`, done by Compose at runtime, not a rendering step OpenPalm performs. What the app may do to produce a file depends on who owns it: a file in a **user-owned** tree is only ever seeded-if-missing or edited in place, so user edits and comments survive; a file the **app owns outright** (e.g. `state/stack.env`) may be regenerated wholesale from its recorded inputs. Regenerating an app-owned file is not "template rendering" and is usually simpler than mutating it, because it needs no migration when the file's shape changes.
- **Never overwrite existing user-modified files in `~/.openpalm/config/` during automatic lifecycle operations** (install/update/startup apply/setup reruns/upgrades); only seed missing defaults or do controlled updates upon user request.
- **All persistent container data lives on the host** for backup/restore.
- **All host-stored container files are user-accessible** (ownership/permissions contract - not owned by root).
- **Core assistant extensions ship in the skeleton at `system/assistant`**, bind-mounted into the container at the fixed `OPENCODE_CONFIG_DIR` (`/etc/opencode`) so core extensions take precedence. The tree is managed: install/update overwrite it, and the assistant does not edit it. User-owned OpenCode assets live in `config/assistant/` instead.

On that last rule: OpenCode supports a custom config directory via `OPENCODE_CONFIG_DIR`; it is searched like a standard `.opencode` directory for agents/commands/tools/skills/plugins. ([OpenCode][1])

---

## Tooling

All tooling (CLI, admin UI, setup wizard) exists to simplify managing files under `OP_HOME`. The baseline is managed Compose under `system/stack/`, the one user overlay at `config/stack/custom.compose.yml`, the one non-secret app record at `state/stack.env`, provider auth at `knowledge/secrets/auth.json`, delegated credentials under `private/secrets/`, AKM user env and tasks under `knowledge/`, Paperclip-specific agent values under `knowledge/paperclip/`, and service files under `data/`. A technical user must be able to understand and manage these files without hidden infrastructure.

## Security invariants

These are hard constraints that must never be violated during development. See also the Security boundaries summary in `foundations.md`, which provides a condensed version of these rules for quick reference.

1. **Host CLI or admin is the orchestrator.** The host CLI manages Docker Compose directly on the host. An admin-capable UI is an adapter-node host process launched by Electron or `openpalm admin`; it serves the `@openpalm/ui` build and manages Compose through the host Docker socket. There is no admin container. Only one orchestrator should manage Compose operations at a time, and the Docker socket is never exposed to a container.
2. **Guardian-only ingress.** Guardian is deployed on demand from `portals.compose.yml` whenever a guardian-ingress addon (`chat`, `api`, `discord`, `slack`, or `gateway`) is enabled. Every portal request enters Guardian; no portal communicates directly with the assistant. Guardian is a transparent 1:1 native OpenCode proxy with fail-closed overlays for HTTP Basic principal authentication, SQLite-persisted session/permission ownership, tenant-filtered events, rate/resource limits, and content validation. `GUARDIAN_CONTENT_VALIDATION` defaults on in both package code and shipped Compose; only explicit `0`, `false`, `no`, or `off` values disable it. A deterministic screen escalates suspicious messages to Guardian's loopback OpenCode moderator, and an escalated message is blocked when the moderator fails or cannot return a valid verdict. Principal, API, admin, MCP, and bot credentials live under `private/secrets/`; provider `knowledge/secrets/auth.json` reaches Guardian as one Compose secret. The `x-openpalm-user` header is an assertion by an already-authenticated portal principal, so isolation is between principals rather than between every end user behind one portal. Guardian's principal CRUD listener is separately Bearer-authenticated on loopback port `3831` and denies all if no token is configured. Guardian serves plain HTTP; remote TLS termination belongs in operator infrastructure.
3. **Assistant isolation.** The assistant has no Docker socket and no broad host filesystem access beyond its designated mounts: `system/assistant/ -> /etc/opencode`, `config/assistant/ -> /home/opencode/.config/opencode`, `config/akm/ -> /etc/akm`, `knowledge/secrets/auth.json -> /home/opencode/.local/share/opencode/auth.json`, `data/assistant/ -> /home/opencode`, `cache/assistant/ -> /home/opencode/.cache`, `knowledge/ -> /stash`, `data/akm/cache/ -> /opt/akm/cache`, `data/akm/data/ -> /opt/akm/data`, `workspace/ -> /work`, and the `assistant-persistent` named volume at `/opt/persistent`. The optional host AKM secondary stash (or an empty fallback) is mounted at `/host-stash`; the container never chowns it. `private/` is never mounted into `/stash`; only named UI/OpenCode server secret files are granted to their consuming processes. The entrypoint does not source `knowledge/env/user.env`; scoped tools load it on demand. The assistant has no network path to the loopback-only admin process and no admin tools, so it cannot perform stack operations.
3. **Host only by default.** Admin interfaces, dashboards, and portals are loopback-restricted by default. Nothing is exposed to the network or internet without explicit user action. The UI uses an `httpOnly` `SameSite=Lax` session cookie plus Host and Origin checks. Electron and `openpalm admin` always bind to `127.0.0.1` and neutralize `OP_ALLOW_REMOTE_SETUP`. After local setup, an operator may explicitly expose only a non-admin `openpalm app` behind operator-managed HTTPS. Setup schema v2 stores flat `access` booleans (`networkAccess`, `assistantDirect`, `guardianNetwork`, `guardianOpenaiApi`) and generates explicit `OP_UI_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`, `OP_GUARDIAN_BIND_ADDRESS`, `OP_API_BIND_ADDRESS`, `OPENCODE_AUTH`, and `GUARDIAN_DIRECT_INGRESS` values. There is no global bind inheritance. Direct assistant publication turns on OpenCode Basic auth with a generated password that Guardian also uses for upstream calls; the loopback default leaves it off.
4. **Scheduled automation is scoped.** The assistant entrypoint starts BusyBox `crond`, runs `akm tasks sync` at boot, and repeats the sync every 60 seconds. Task files live under `knowledge/tasks/`; supported targets are `command`, `prompt`, and `workflow`. Cron receives a small managed AKM/OpenCode environment preamble rather than all of `knowledge/env/user.env`. It has no Docker socket, network listener, admin credential, or admin API role.
5. **Admin is host-only.** Electron and `openpalm admin` bind to `127.0.0.1`; they are not reachable from the Docker bridge network or any container, and `OP_ALLOW_REMOTE_SETUP` cannot change that boundary. The admin process manages Docker Compose directly on the host via the host Docker socket — there is no docker-socket-proxy container.

---

## Filesystem contract (file assembly, not rendering)

Configuration is managed by **writing whole files** or **targeted edits**, chosen by who owns the file (see the ownership rule in § File System): user-owned files are seeded-if-missing or edited in place; app-owned files may be written whole. What is never done is leaving a template on disk for something to expand later — the CLI or admin validates proposed changes, writes finished files to live paths, and leaves `${VAR}` substitution to Docker Compose at runtime. All control-plane logic lives in `@openpalm/lib` — both CLI and admin import from this shared library. The managed OpenCode config is bind-mounted from `system/assistant/` at `/etc/opencode`, with user extensions mounted from `config/assistant/`.

All OpenPalm state lives under a single root: **`~/.openpalm/`** (configurable via `OP_HOME`). Regenerable container caches live in `OP_HOME/cache/`; host-side ephemeral cache lives at `~/.cache/openpalm/`. Under that root the layout is split into trees by **ownership**, so lifecycle sync can overwrite what it owns without ever touching a user file:

| Tree | Owner | Contents |
|---|---|---|
| `config/` | User | User-editable non-secret config; the `custom.compose.yml` overlay under `config/stack/` |
| `system/` | Managed (release-shipped) | Fixed compose files (`system/stack/`) + managed OpenCode config (`system/assistant/`, `system/guardian/`, `system/paperclip/`); overwritten wholesale on reconcile |
| `state/` | App-written | Records the control plane writes and owns — version pins, enabled add-ons, setup completion (`state/stack.env`) |
| `knowledge/` | User / services | AKM knowledge, tasks, user env, and provider `secrets/auth.json`; bind-mounted into the assistant at `/stash` |
| `data/` | Services | Persistent per-service runtime data, logs, backups, rollback |
| `workspace/` | User | Shared assistant work area, bind-mounted at `/work` |
| `private/` | App-written | Delegated UI/OpenCode/Guardian/API/portal/bot credentials; never part of assistant `/stash` |
| `cache/` | System | Regenerable assistant and Guardian caches; excluded from backups and ownership repair |

#### Accepted changes (approved 2026-08-08 — not yet implemented)

The table above describes the current runtime; it is amended as each change
lands. Decisions and migration:
[`../reviews/op-home-restructure-proposal.md`](../reviews/op-home-restructure-proposal.md).

**A tree's name must agree with its mount.** `OP_HOME` is split by three axes
(writer, exposure, durability) but only exposure is enforced, by the mount
graph — every past trust incident was a file whose name implied one axis while
its mount answered another. No subtree may need different exposure than its
parent, and no boundary may be held up by hiding one mount behind another.

Binding from now on:

1. **One stash.** `knowledge/` is it. Sharing it with an addon is a binary
   operator choice, expressed as an opt-in compose overlay like every other
   optional grant; an addon not granted it manages its own. Per-addon subtrees
   and over-mounting to hide part of the stash are forbidden. Shared means
   shared, task files included.
2. **Shipped skills are release-managed** under `system/`, not user-tree
   content seeded once with no update channel.
3. **Secret placement is default-deny** — the internal API resolves to
   `private/secrets/` unless a name is explicitly agent-readable. `private/` is
   a separate tree from `state/` for one reason: it is the only tree carrying an
   absolute *never bind-mounted* rule, checkable as a whole-tree assertion.
   `state/` cannot carry it — `state/remote/` is a mount source — and `data/` is
   wrong outright, since each `data/<service>/` is mounted wholesale into its
   service and credentials must be granted file-by-file.
4. **A service's data and credentials are one restore unit.** A backup takes
   both or neither, and names what it skipped.
5. **Managed compose interpolation fails loud** (`${OP_HOME:?}`); a silent
   default only where the unset case is provably safe.
6. **`OP_HOME` is canonicalized once**, so symlinked homes work and every
   "is this under `OP_HOME`?" test is sound.
7. **`state/` holds records and generated runtime config.** Generated files a
   container reads never go in the wholesale-overwritten `system/`.
8. **Managed config is read-only to the service it governs** where that service
   does not write it (guardian's is; the assistant's is not).

### 1) Config (user-owned, non-secret)

**Location:** `~/.openpalm/config/`
**Purpose:** user-editable, non-secret OpenCode, AKM, and custom stack configuration.

Subtrees:

- `assistant/` — the power-user's OpenCode **global** config for the assistant (`persona.md`, model/provider choices); mounted at the assistant's `~/.config/opencode` (nested over `HOME=/home/opencode`). The **managed** config — plugins, permissions, instructions — is a different tree, `system/assistant`, mounted at `/etc/opencode` (`OPENCODE_CONFIG_DIR`)
- `guardian/` — the operator-tunable moderation **model** setting (`opencode.json`); mounted at the guardian's `~/.config/opencode` (`HOME=/opt/openpalm/guardian`)
- `akm/` — AKM configuration (LLM, embedding, and related settings in `config.json`)
- `paperclip/opencode/` — Paperclip's user OpenCode global config; mounted at `/paperclip/.config/opencode`. The exact AKM plugin manifest and compatibility launchers are managed separately under `system/paperclip/`.
- `paperclip/akm/` — Paperclip-specific AKM configuration; mounted at `/etc/akm`
- (No host-owned connection list.) The UI is a self-contained browser app that owns its connection list and credentials in the browser (IndexedDB + WebCrypto AES-GCM; storage details in [`architecture.md`](./architecture.md)) and talks to each connection's OpenCode/Guardian instance directly. The host admin process derives its own single local OpenCode target from the environment / Electron runtime (`$lib/server/opencode-target.ts`), not from a config file.

**Rule:** allowed writers are: user direct edits, explicit admin UI/API config actions, the assistant for the single file `config/assistant/user-profile.md`, and Paperclip's AKM process for `config/paperclip/akm/config.json` through native AKM config operations. Paperclip's OpenCode config is mounted read-only. Automatic lifecycle operations (install/update/startup apply/setup reruns/upgrades) are non-destructive for existing user files and only seed missing defaults or make targeted updates.

**The one assistant-written file.** `config/assistant/user-profile.md` is where the assistant records what it learns about the operator, so the knowledge survives a session and is reviewable and editable as plain text in the user tree. It is deliberately here rather than in the akm knowledge tree: the operator should be able to read and correct it the same way they edit `persona.md`, and it is loaded by the same OpenCode instruction mechanism. The assistant reaches it because `config/assistant/` is bind-mounted at its own `~/.config/opencode` and the shipped `opencode.jsonc` grants `external_directory` on that directory — OpenCode asserts that permission against the target's *parent directory*, so the grant cannot be narrowed to one file. Nothing else in `config/` is writable by the assistant.

**Guardian managed config (moderation.md is not user-editable):** the moderation classifier's instructions (`instructions/moderation.md`) and the guardian's `opencode.jsonc` live in the MANAGED `system/guardian/` tree, bind-mounted at the guardian's `OPENCODE_CONFIG_DIR=/etc/opencode` — the same managed tree as the rest of `system/`. Like every other file there, `overwriteSystemTree` (`packages/lib/src/control-plane/core-assets.ts`) overwrites it on every install/update/hot-swap refresh whenever its content differs from the shipped default, backing up the previous copy first; there is no skip-if-user-modified exception. It was deliberately **not** relocated to `config/guardian/` (the user tree): that directory mounts at the guardian's `~/.config/opencode`, a different path than `OPENCODE_CONFIG_DIR=/etc/opencode`, so relocating the file there would silently stop OpenCode from loading it. Operators who need different moderation behavior tune the **model** via `config/guardian/opencode.json` (the `guardian/` subtree above); the classifier instructions text itself is managed, not user-editable.

### 1b) Stack (managed assembly + user overlay + app-written record)

The Docker Compose assembly is split across three owners so lifecycle sync can overwrite the managed files wholesale without ever clobbering the user's overlay or the app's own record.

**Managed compose — `~/.openpalm/system/stack/`** (release-shipped, overwritten on every reconcile):

- `core.compose.yml` — base compose definition for the core assistant runtime service
- `services.compose.yml` — first-party optional services, profile-gated
- `portals.compose.yml` — first-party optional portals (including the profile-gated guardian), profile-gated

**User overlay — `~/.openpalm/config/stack/custom.compose.yml`**: user-editable custom services and overlays. Seeded once and never overwritten automatically. It is the ONE stack file in the user tree; co-locating it inside the wholesale-overwritten `system/stack/` is forbidden by the ownership model.

**Stack env — `~/.openpalm/state/stack.env`**: the single non-secret Compose `--env-file`. It holds the operator's runtime configuration (paths, ports, image tags, feature flags) and the control plane's own records (enabled add-ons, per-image version pins, `OP_SETUP_COMPLETE`) in one file; `state/` also holds `host-identity.json` and `schema-version`. It is app-owned but operator-editable. First-party optional services are enabled by updating `OP_ENABLED_ADDONS` here; OpenPalm resolves those names to Compose `--profile addon.<name>` arguments when it builds the Docker Compose command. This was two files — an operator one under `knowledge/env/` and an app-written one under `state/` — merged by `--env-file` order. Consolidating them removed the eight hand-written re-implementations of that precedence, one of which read the wrong file and stopped enabled addons from activating their profile. Explicit manual `--profile` arguments remain valid for ad hoc Docker Compose use. OpenPalm does not generate `addons.compose.yml`, does not write `enabled-addons.json`, and does not use a runtime registry catalog.

### 2) Knowledge (assistant-readable)

**Location:** `~/.openpalm/knowledge/`
**Purpose:** AKM knowledge, tasks, user env, and provider auth. The entire `knowledge/` directory is bind-mounted into the assistant at `/stash`.

Subtrees:

- `env/user.env` — AKM `env:user` backing file. It is not a Compose env file and the entrypoint does not source it; scoped tools load it on demand.
- `tasks/` — AKM YAML task files registered with BusyBox cron by `akm tasks sync`.
- `secrets/auth.json` — provider auth state used by the assistant's OpenCode runtime. This is the only platform credential file retained in `knowledge/secrets/`.
- `paperclip/env/` and `paperclip/secrets/` — values the operator explicitly permits Paperclip agents to use. Paperclip mounts these over `/stash/env` and `/stash/secrets`, obscuring the assistant's canonical directories while sharing the rest of `knowledge/`.

Stack **configuration** does not. It lives in `state/stack.env` (§ 1b), deliberately outside this tree: `knowledge/` is bind-mounted into the assistant at `/stash`, and host ports, image tags and the setup flag are not the agent's business.

**Rule:** because `/stash` is agent-readable, delegated service credentials do not belong anywhere in this tree. Paperclip-specific AKM values are not delegated OpenPalm service credentials: placing them under `knowledge/paperclip/` is an explicit decision to make them readable to both Paperclip agents and the assistant. There is no separate `/etc/vault/` mount and no broad secret env injection.

### 2b) Private credentials (not part of `/stash`)

**Location:** `~/.openpalm/private/secrets/`

**Purpose:** delegated credentials consumed by host UI, assistant server/UI processes, Guardian, APIs, portals, or bots but not by the assistant through its AKM stash. This includes `op_ui_login_password`, `op_opencode_password`, Guardian admin/MCP tokens, the compatible API key, portal principal secrets, and Discord/Slack bot tokens.

**Rule:** `private/` is never mounted into assistant `/stash`. Compose normally grants only named files to consuming services under `/run/secrets/`; Paperclip's audited exception is defined immediately below. The secret audit rejects broad service env files, raw secret-like environment values, and grants outside a service's role. Directories are `0700`; files are `0600`.

**Named `env_file` exemption (one service, one path, one key set).** A third-party addon image that reads a credential only as a plain environment variable, and implements no `*_FILE` indirection, may read exactly one env file under `private/env/`. The exemption is not a relaxation of the rule above — it is enforced, per service and per path, by `auditPaperclipEnv` in `secret-audit.ts`, which additionally requires the file to be `0600` inside a `0700` directory, to contain **only** the named keys, to contain **all** of them, and to have every matching value in the service's Compose `environment` agree with the file. (`docker compose config` inlines `env_file` into `environment`, so the keys appearing there is expected; a value that *differs* from the file means the Compose block overrode the audited source, and that is the failure.) Any other service using `env_file`, any other path, or any extra key is still an audit failure. `paperclip` is the first and currently only such addon: the pinned upstream image reads `BETTER_AUTH_SECRET` and `PAPERCLIP_AGENT_JWT_SECRET` from `process.env` only.

**Why the exemption exists rather than an entrypoint wrapper.** File-based delivery for those two values is achievable — a wrapper entrypoint could read `/run/secrets/*` and re-export them — but that means replacing the third-party image's startup contract. The addon runs the digest-pinned upstream entrypoint unmodified, and the two secrets it cannot read from a file are contained by the audited exemption above. A managed `opencode` launcher separately removes those long-lived server secrets from local-agent child environments; it does not alter server startup.

### 3) Data (service-managed, durable)

**Location:** `~/.openpalm/data/`
**Purpose:** all persistent data for every container that must survive reinstall.

**Rule:** every persistence-requiring container path is a bind mount into this tree.

Subtrees: `assistant/`, `guardian/`, `paperclip/`, `akm/cache/`, `akm/data/`, `paperclip-akm/cache/`, `paperclip-akm/data/`, `logs/`, `backups/`, `rollback/`.

Shared user knowledge lives in `knowledge/` (not `data/`) — see § Knowledge above.
Regenerable container caches (bun/npm/opencode) live in `OP_HOME/cache/<service>/`, a sibling of `data/` rather than a child of it, so they are purgeable without touching durable state. They are pre-created operator-owned by `ensureHomeDirs` and bind-mounted over the in-container cache paths — NOT named volumes nested inside a bind, which made Docker create root-owned mountpoints and broke rootless installs. Paperclip's mutable OpenCode config and dependency tree use `cache/paperclip-opencode/runtime/` at `/etc/opencode`; its release-managed source is a separate read-only mount. Caches are excluded from backups and removed by `--purge`. Host-side ephemeral artifacts still live outside `OP_HOME` under `~/.cache/openpalm/`.
The shared work area lives in `workspace/`.

**Write policy:** Each container may write only to its own designated subdirectories via its mounts. The assistant writes to `data/assistant/`, `knowledge/`, `data/akm/cache/`, `data/akm/data/`, `workspace/`, and `/opt/persistent`; the guardian writes to `data/guardian/` and `data/logs/`; Paperclip writes to `data/paperclip/`, `data/paperclip-akm/`, `cache/paperclip-opencode/runtime/`, its AKM config, and shared knowledge exposed through `/stash`. Paperclip's managed and user OpenCode config mounts are read-only. No container may access another service's data directories. Stack-wide data operations require the host CLI or admin UI.

### 4) Logs (audit and debug)

**Location:** `~/.openpalm/data/logs/`
**Purpose:** durable OpenPalm audit logs. Other container logs remain in the
configured Docker logging driver unless a service explicitly writes here.

Files include `guardian-audit.log` (Guardian ingress audit) plus OpenCode session
and tool-invocation logs under `data/assistant/.local/state/opencode/`.

OpenCode session logs are the audit trail for chat + tool activity; UI/admin
actions (login, config writes) log to application stderr via
`createLogger('admin.*')`.

### 5) Rollback

**Location:** `~/.openpalm/data/rollback/`
**Purpose:** previous known-good config snapshots for automated rollback on deploy failure.

Host-side ephemeral system cache belongs under `~/.cache/openpalm/`. Container caches belong in `OP_HOME/cache/` (above) — they must be reachable by a bind mount, which a host-user cache dir outside `OP_HOME` cannot portably provide.

### 6) Backups

**Location:** `~/.openpalm/data/backups/`
**Purpose:** durable upgrade backup snapshots created by lifecycle operations before destructive transitions.

**Rule:** CLI/admin writes backup snapshots here before destructive lifecycle changes. A lifecycle safety backup includes `config/`, `system/`, `state/`, `knowledge/`, `workspace/`, and `private/`; it excludes service-owned `data/` and regenerable `cache/`. `uninstall --purge` removes all eight `OP_HOME` trees, including `private/` and `cache/`. Ownership repair covers durable/user/private roots and excludes regenerable cache content. Backups remain user-accessible durable operator state.

---

## Volume-mount contract

### A) Compose: modular by native multi-file composition

The stack is defined by combining the fixed Compose file set with Compose's native multi-file merge rules. ([Docker Documentation][3])
**Implication:** the default file list is `core.compose.yml`, `services.compose.yml`, `portals.compose.yml`, and `custom.compose.yml`. First-party optional services are activated with Compose profiles. Custom containers and overlays belong in `custom.compose.yml`; rerunning Docker Compose with the same fixed file list and updated profiles applies changes.

### B) OpenCode: core precedence via the managed `/etc/opencode` mount

- The assistant container sets **`OPENCODE_CONFIG_DIR=/etc/opencode`** so OpenCode discovers core agents/commands/tools/skills/plugins from that directory. ([OpenCode][1])
- **`/etc/opencode` is a bind mount, not image content.** The shipped `core.compose.yml` always mounts `${OP_HOME}/system/assistant` there. Nothing is baked into the image at that path — the only baked asset is a default `AGENTS.md` at `/usr/local/share/openpalm/AGENTS.md`, which the entrypoint seeds into the config dir only when the operator has not supplied their own.
- Because the host tree is authoritative (§D), editing `system/assistant/` on the host *is* the supported way to change core behavior. It is a MANAGED tree: install/update overwrite it wholesale, so operator changes there are replaced on the next update. Durable user-owned extensions belong in `config/assistant/`.
- The guardian image likewise sets `OPENCODE_CONFIG_DIR=/etc/opencode`, bind-mounted from the MANAGED `system/guardian/` tree (instructions, permissions, plugin config — the malicious-message taxonomy the content-validation stage uses). The operator-tunable moderation **model** setting is separate: `config/guardian/opencode.json`, bind-mounted from the USER tree at the guardian's `~/.config/opencode`.
- Paperclip uses both established layers: managed `system/paperclip/` is mounted read-only at `/opt/openpalm/paperclip`, its regenerable runtime copy is selected through `OPENCODE_CONFIG_DIR=/etc/opencode`, and user `config/paperclip/opencode/` is mounted at `/paperclip/.config/opencode`. `XDG_CONFIG_HOME=/paperclip/.config` keeps model preflight and agent execution on that same user config even when upstream normalizes `HOME`. Its exact AKM dependencies are standard managed-config dependencies; a one-export local adapter is required by the OpenCode version in the digest-pinned upstream image.

### C) Non-destructive lifecycle sync is enforced by directory boundaries

To guarantee lifecycle operations never clobber user configuration:

- **`config/` is user-owned and persistently authoritative.** Automatic lifecycle sync only seeds missing defaults or does targeted updates and never overwrites existing user files. Explicit mutation paths — user direct edits and CLI/admin UI/API config actions — may create/update/remove files as requested. User data is never removed by an automatic path.
- **`system/stack/` is the managed compose assembly.** Automatic lifecycle sync overwrites `core.compose.yml`, `services.compose.yml`, and `portals.compose.yml` wholesale from the release-shipped defaults. The user overlay `config/stack/custom.compose.yml` is seeded once and user edits always win. Non-secret runtime configuration, pins and enabled add-ons all live in `state/stack.env`.
- **`knowledge/env/` has strict access rules.** It is visible inside `/stash`, but the assistant entrypoint never sources `knowledge/env/user.env`; scoped AKM/OpenCode tools load it only on demand. Lifecycle operations never overwrite it. Provider `knowledge/secrets/auth.json` is the sole platform credential retained in this assistant-readable tree.
- **Paperclip overlays the canonical AKM value directories.** It receives `knowledge/` at `/stash`, then mounts `knowledge/paperclip/env/` and `knowledge/paperclip/secrets/` over `/stash/env` and `/stash/secrets`. The assistant's canonical env and provider-auth directories are therefore obscured inside Paperclip; Paperclip-specific values remain assistant-readable through the assistant's broader mount.
- **`private/` is the delegated credential boundary.** It is included in backup, purge, and ownership scope but never bind-mounted into `/stash`. Named Compose secret grants are the default container delivery path; the one audited Paperclip `private/env/paperclip.env` exception is defined under § Private credentials.
- **`cache/` is regenerable.** It is omitted from backups and ownership repair and may be removed by cache cleanup or purge.
- **`data/` is service-writable within ownership boundaries.** Each container owns its designated data subdirectories. No container may access another service's data directories. Stack-wide data operations require the host CLI or admin UI.
- **Apply is snapshot-protected and validates before container mutation.** A snapshot of the current stack configuration is saved to `$OP_HOME/data/rollback/` before managed files are refreshed. The refreshed Compose merge is validated before runtime files are written or containers are touched. If the apply or deployment fails, the snapshot is automatically restored. See § Rollback scope below for what is included in the snapshot.

### D) Host authority rule for mounts

Bind-mounting a host path over a container path **obscures** pre-existing container files at that path; therefore, any bind-mounted path must be considered authoritative from the host perspective. ([Docker Documentation][5])

### E) User accessibility

All host-mounted directories must remain readable/writable by the host user (ownership/permissions policy is part of the contract). The purpose is to allow users to easily view logs, edit files, and backup and restore these files.

---

## Shared control-plane library (`@openpalm/lib`)

All portable control-plane logic — lifecycle management, addon operations, secret resolution, path helpers, validation, Docker invocation, and configuration assembly — lives in `packages/lib/` (`@openpalm/lib`). Both the CLI and admin import from this package. **No control-plane logic may be duplicated between consumers.**

**Rules:**

- New control-plane functionality MUST be implemented in `@openpalm/lib`, not in CLI or admin source directly.
- The CLI calls lib functions directly. The admin calls them from host API route handlers. Shared task parsing and control-plane behavior remain in lib; cron execution itself is delegated to AKM and BusyBox.
- If a function exists in the admin that should be reusable (e.g., compose invocation, env file parsing, component discovery), it must be extracted to lib.
- Test coverage for control-plane logic belongs in lib's test suite, not duplicated across consumer test suites.

**Rationale:** The CLI must work without the admin UI process, and the admin UI must work without the CLI. If control-plane logic is scattered across consumers, these guarantees break and behavior diverges.

---

## Artifact completeness and updates

Every distributable first-party artifact ships complete: the Electron app, the CLI binary, and every OpenPalm-built container image each contain the exact UI build and skeleton they run. Nothing in those artifacts is resolved, downloaded, or arbitrated at runtime. The sole third-party-addon exception is Paperclip's first-agent-use installation of exact-pinned OpenCode config dependencies into a regenerable host cache: OpenPalm does not rebuild the digest-pinned upstream image, the install is bounded and verified before use, and it never runs during container startup.

There is exactly one update operation per target:

- **Desktop** updates itself as a whole application via electron-updater — a consented download that installs on restart.
- **CLI** updates by replacing its binary.
- **Stack images** update via `compose pull`. Docker image pins in `state/stack.env` are unaffected by this section.

An installation therefore runs one coherent release, never a mix of shell/UI/control-plane/skeleton versions.

`OP_HOME/data/ui` is a materialization directory owned by the running artifact, not an update channel. It is rewritten from the artifact's own embedded copy when the version stamp differs. It is never downloaded into.

Because the artifact and its UI ship and version together, there is no compatibility contract to negotiate between them, no version arbitration, and no update rollback: reinstalling or downgrading the artifact is the recovery path.

The Electron main process should still stay bootstrap-only — it launches and supervises the spawned control plane; lifecycle mutations belong there, not in the harness. This is a design preference enforced by review, not a mechanically-verified contract.

---

## Service port assignments

Host-exposed OpenPalm services default to a small localhost-friendly port set. Core services use the `38xx` range and addon edges map their internal ports onto nearby host ports for manual use.

| Service | Internal Port | Default Host Bind | Purpose |
|---------|--------------|-------------------|---------|
| **Assistant UI** | 3000 | `127.0.0.1:3800` | `@openpalm/ui` chat interface |
| **Assistant** (OpenCode) | 4096 | `127.0.0.1:3810` | OpenCode web UI + API |
| **Voice addon** | 8880 | `127.0.0.1:8880` (literal loopback; `OP_VOICE_PORT_HOST`) | Voice interface (TTS/STT) |
| **Paperclip addon** | 3100 | `127.0.0.1:3840` (literal loopback; `OP_PAPERCLIP_PORT`) | Paperclip web UI/API |
| **Admin** | n/a — host process, not a container | `127.0.0.1:3880` | Admin UI + API (`openpalm admin`) |
| **Guardian gateway** | 8080 | (internal only — no `ports:` publication) | Principal auth, `/oc/*` proxy, rate limiting, content validation |
| **Guardian moderator** (OpenCode) | 4097 | (loopback only) | Local content-moderation model |
| **Guardian direct listener** | 3830 | `127.0.0.1:3830` (`OP_GUARDIAN_BIND_ADDRESS`) | Direct (non-portal) ingress; the listener 404s unless `GUARDIAN_DIRECT_INGRESS=true`; serves plain HTTP |
| **Guardian admin listener** | 3831 | `127.0.0.1:3831` (`OP_GUARDIAN_ADMIN_PORT`; bind address is fixed) | Principal CRUD (`/admin/principals`), Bearer-token auth via `GUARDIAN_ADMIN_TOKEN_FILE` |
| **Guardian OpenAI/Anthropic API** | 8182 | `127.0.0.1:3821` (`OP_API_BIND_ADDRESS`) | The one compatible API listener; `chat` does not create a second host port |

Port assignments live in non-secret `state/stack.env`. Configurable host binds are flat and service-specific: `OP_UI_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`, `OP_GUARDIAN_BIND_ADDRESS`, and `OP_API_BIND_ADDRESS`; no listener inherits from a global bind. Voice, Paperclip, and the Guardian admin listener are fixed to loopback. The Guardian `/stats` endpoint is gated by the admin bearer token and denies all when no token is configured. Its internal `8080` listener binds for both `portal_net` and loopback callers inside the container.

---

## Docker build dependency contract

Docker builds run outside the Bun workspace — the monorepo's hoisted `node_modules` is not available. Each Dockerfile must resolve service dependencies explicitly.

 Admin is a host process, not a Docker service. Platform package manifests are stamped in lockstep. Internal workspace references intentionally use `workspace:*` where local coupling is required. The portal SDK plus Discord and Slack adapters form the portal release unit. The CLI and Electron each embed their own complete copy of the `@openpalm/ui` build and the skeleton at build time; there is no shared host-assets release to install.

### Guardian + Portals (Bun runtime)

These Dockerfiles install each service's own dependencies directly inside the image:

This ensures each service's local runtime dependencies are available at runtime.

**Rules:**

- Every Dockerfile that bakes a service from the workspace must install that service's declared runtime dependencies during the image build.
- Guardian-local helpers stay in `packages/guardian/src/` (`@openpalm/guardian`); adapter-local helpers stay inside the adapter package that uses them.
- The assistant **and Guardian** images install the OpenCode binary from the exact `opencode-ai` dependencies in `containers/assistant/tools/package.json` and `containers/guardian/tools/package.json`. Keep those two pins in lockstep.
- The assistant image bakes the candidate-local `@openpalm/ui` build and its tool manifest. Its entrypoint performs no runtime package install or update. It does NOT carry a skeleton copy: the skeleton is materialized into `OP_HOME` by the CLI or desktop artifact that owns it, and the assistant reads it from the mounted home.
- Guardian bakes its candidate-local package and tools. Only the documented Guardian thin-host package override may install at runtime.
- The portal image packs the candidate-local portal SDK and Discord/Slack adapter workspaces at build time; it does not install adapters at boot.

---

## Addon secret lifecycle

When a portal addon is installed, the following secret distribution flow occurs:

1. **Generation:** a per-principal shared secret is generated by the CLI or admin during addon install.
2. **Storage:** the secret is written as one `0600` file under `private/secrets/`, outside assistant `/stash`.
3. **Guardian side:** Compose grants that file to Guardian, which uses it to seed the principal record at boot.
3. **Portal side:** Compose grants the same file only to the matching portal service. The portal receives its path through `PRINCIPAL_SECRET_FILE` and authenticates every `/oc/*` call with Basic auth.
4. **Verification:** on every inbound request, Guardian authenticates the principal, enforces ownership/rate-limit checks, and screens prompt-bearing traffic before forwarding native OpenCode to the assistant.

Secret grants are intentionally narrow. Provider `auth.json` remains under `knowledge/secrets/`; delegated UI/OpenCode-server/Guardian/API/portal/bot credentials live under `private/secrets/`. Admin host processes read required files directly from the host. `stack.env` must not contain secret-like keys, Compose services must not use broad `env_file`, and secret-like container variables must be `*_FILE` paths — except for the audited, single-service, single-path `env_file` exemption described under § Private credentials, which exists only for third-party images that cannot read file-based secrets.

Rotating a portal principal secret updates its one host file, then recreates Guardian and the affected portal so both read the new value.

---

## Addon conflict detection

Addon overlays may extend core services by injecting environment variables or volumes into core service definitions via Compose multi-file merge. This is standard Docker Compose merge behavior — no custom merging logic is involved. ([Docker Documentation][3])

**Known limitation:** the validate-in-place step checks that the assembled compose config is syntactically valid, but it does not detect semantic conflicts between addons — for example, two addons setting different values for the same environment variable on a core service. In such cases, Compose's last-file-wins merge order determines the final value. Users installing multiple addons that target the same core service env vars should review the assembled config.

---

## Rollback scope

When the CLI or admin performs an apply operation, a snapshot is saved to `$OP_HOME/data/rollback/` before any writes. The snapshot includes:

- The live compose assembly and the env/secret files that drive it: the managed `system/stack/` compose files (`core.compose.yml`, `services.compose.yml`, `portals.compose.yml`), the user overlay `config/stack/custom.compose.yml`, the non-secret env `state/stack.env`, and `knowledge/secrets/auth.json`.

The snapshot does **not** include `config/` user files outside `config/stack/custom.compose.yml` (non-destructive for user edits), `knowledge/env/user.env` (never overwritten by lifecycle operations), or `data/` (service-owned runtime data).

Rollback snapshots are intentionally narrow and distinct from lifecycle safety backups. Safety backups under `data/backups/` include `private/` with the other non-data ownership trees and exclude regenerable `cache/`.

On health check failure after deploy, the snapshot is automatically restored and the stack is restarted. Manual rollback is available via `openpalm rollback`.

---

## Operational behavior

- **Add an addon:** update `OP_ENABLED_ADDONS` in `~/.openpalm/state/stack.env` (for first-party addons) or add a service block to `config/stack/custom.compose.yml` (for custom services), then rerun the compose command with the appropriate `--profile addon.<name>` arguments. ([Docker Documentation][3])
- **Add an extension (user):** copy OpenCode assets into `config/assistant/` following OpenCode's directory structure. ([OpenCode][1])
- **Core precedence:** core extensions are bind-mounted from `system/assistant/` to `/etc/opencode` inside the assistant container and are loaded via `OPENCODE_CONFIG_DIR`. ([OpenCode][1])
- **Apply changes:** the CLI or admin validates proposed changes (Compose config and secret-audit rules) before writing anything. If validation passes, a snapshot of current live files is saved to `$OP_HOME/data/rollback/` (see § Rollback scope), changes are written to live paths, and `docker compose up -d` runs. If services fail health checks, the snapshot is restored. Compose uses non-secret `state/stack.env`; provider auth stays at `knowledge/secrets/auth.json`; delegated credentials use named Compose grants except for the audited Paperclip env-file exception. `knowledge/env/user.env` is not a Compose env file. Automatic lifecycle apply preserves user files and overwrites only managed `system/` assets and app-owned records.
- **Addon overlays may extend core services.** Addon compose files can inject environment variables or volumes into core service definitions via Compose multi-file merge. For example, an addon can add environment entries to the assistant service by defining an `assistant:` block with additional `environment:` entries in its overlay. This is standard Docker Compose merge behavior — no custom merging logic is involved. See § Addon conflict detection for limitations.
- **Credential changes require restart:** provider auth lives in `knowledge/secrets/auth.json`; delegated service credentials live in `private/secrets/`. Restart services that read a granted file only at startup.
- **Rollback:** `openpalm rollback` restores the most recent snapshot from `$OP_HOME/data/rollback/` and restarts the stack. Available both as an automated response to failed deploys and as a manual escape hatch. See § Rollback scope for snapshot contents.
- **Backup/restore:** include `private/` whenever manually archiving durable OpenPalm state. Regenerable `cache/` should be excluded. Restore the ownership trees, then run the normal Compose file set; there is no staging tier to reconstruct.

[1]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[3]: https://docs.docker.com/reference/compose-file/merge/?utm_source=chatgpt.com "Merge | Docker Docs"

[5]: https://docs.docker.com/engine/storage/bind-mounts/?utm_source=chatgpt.com "Bind mounts"
