# OpenCode Configuration Integration

This document describes the containerized OpenCode runtimes in 0.13.0: the
assistant, Guardian's local moderator, and OpenCode processes spawned by the
optional Paperclip addon. Admin is a host process, not an OpenCode container or
Docker-socket path.

Primary sources:

- `packages/skeleton/system/stack/core.compose.yml`
- `packages/skeleton/system/stack/portals.compose.yml`
- `containers/assistant/entrypoint.sh`
- `containers/guardian/entrypoint.sh`

## Assistant Runtime

### Configuration Layers

OpenCode can see three practical layers:

1. `/etc/opencode`, mounted from managed `system/assistant/`, contains shipped
   plugins, permissions, and instructions. `OPENCODE_CONFIG_DIR` points here.
2. `/home/opencode/.config/opencode`, mounted from user-owned
   `config/assistant/`, is the user's global OpenCode config.
3. Project-local OpenCode files under `/work` follow normal OpenCode behavior.

Managed files are replaced on reconcile. Durable user customizations belong in
`config/assistant/`, not `system/assistant/`.

### Mounts

| Host path | Container path | Purpose |
|---|---|---|
| `system/assistant/` | `/etc/opencode` | Managed `OPENCODE_CONFIG_DIR` |
| `config/assistant/` | `/home/opencode/.config/opencode` | User global config |
| `data/assistant/` | `/home/opencode` | Persistent runtime home |
| `cache/assistant/` | `/home/opencode/.cache` | Regenerable runtime cache |
| `knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | Provider auth state |
| `knowledge/` | `/stash` | AKM stash, user env, tasks, skills, and knowledge |
| `config/akm/` | `/etc/akm` | AKM config |
| `data/akm/cache/` | `/opt/akm/cache` | AKM cache and task logs |
| `data/akm/data/` | `/opt/akm/data` | AKM durable data |
| `workspace/` | `/work` | Shared workspace |

The image also exposes the `assistant-persistent` named volume at
`/opt/persistent` for optional tools.

### Environment

| Variable | Value/default | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Managed config root |
| `OPENCODE_PORT` | `4096` | OpenCode HTTP listener |
| `OPENCODE_AUTH` | Generated, default `false` | Direct API Basic-auth posture |
| `OPENCODE_SERVER_PASSWORD_FILE` | `/run/secrets/opencode_server_password` | Generated direct API password |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/stash` | Primary AKM stash |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data |

The entrypoint does not source `knowledge/env/user.env`. Scoped OpenCode tools
and AKM commands resolve `env:user` only for the operation that needs it, so the
OpenCode server and arbitrary tool subprocesses do not inherit every user
secret.

The assistant starts in `/work`, has no Docker socket or admin credential, and
cannot initiate stack operations. BusyBox `crond` is started alongside OpenCode.

## Local UI Pass-Through

The assistant image bakes the same `@openpalm/ui` adapter-node build used by host
surfaces. The entrypoint supervises it on container port `3000` and sets
`OP_OPENCODE_URL=http://localhost:4096` for the UI child.

The default browser connection is the root-relative `/oc` path. The UI server
authenticates the browser session, transparently forwards native OpenCode
traffic to the local server, and attaches an upstream OpenCode credential when
direct-assistant auth is enabled. The browser does not need the generated
OpenCode password for this local path.

The assistant entrypoint performs no runtime install of `@openpalm/ui`; the
candidate-local compiled UI is image-baked at `PLATFORM_VERSION`. Skeleton
assets are delivered and materialized by the host control plane.

## Guardian Moderator

Guardian's OpenCode runtime is a loopback-only classifier used by content
validation.

| Host/source | Container path | Purpose |
|---|---|---|
| `system/guardian/` | `/etc/opencode` | Managed moderator instructions and permissions |
| `config/guardian/` | `/opt/openpalm/guardian/.config/opencode` | User-selectable moderation model |
| `knowledge/secrets/auth.json` via Compose secret | `/run/secrets/guardian_auth_json` | Provider auth input copied into Guardian home |

Guardian mounts no `knowledge/` directory. Its entrypoint copies the provider
auth file to `/opt/openpalm/guardian/.local/share/opencode/auth.json` before
starting OpenCode.

The moderator listens on `127.0.0.1:4097`, denies agent tools, and starts when
content validation is enabled. `GUARDIAN_CONTENT_VALIDATION` is on by default in
both code and shipped Compose; explicit `0`, `false`, `no`, or `off` disables
the stage. Failed classification of an escalated message blocks the message.

## Paperclip Agent Runtime

Paperclip spawns its image-baked `opencode` command for each local-agent run.
OpenPalm supplies two config layers:

1. `system/paperclip/` is mounted read-only at `/opt/openpalm/paperclip`. It
   contains the exact AKM package manifest, managed permissions and security
   instructions, a single-export adapter for `akm-opencode`, an embedded-Bun
   launcher for `akm-cli`, and an `opencode` launcher that removes long-lived
   Paperclip server secrets from agent runs.
2. `config/paperclip/opencode/` is mounted read-only at
   `/paperclip/.config/opencode` for operator model/provider and agent settings.
   `XDG_CONFIG_HOME=/paperclip/.config` keeps this location stable when
   Paperclip's model preflight normalizes `HOME` from the passwd database.

The managed launcher copies whole release files into
`cache/paperclip-opencode/runtime/`, mounted at the writable
`OPENCODE_CONFIG_DIR=/etc/opencode`. OpenCode installs the exact-pinned
`akm-opencode` and `akm-cli` dependencies there and adds its own matching plugin
API package. Changed files are published atomically under a cross-process lock,
and exact installed versions are checked before a release manifest is marked
current. No runtime config or dependency content is stored in the managed or
user config trees or included in backups.

Paperclip receives shared knowledge at `/stash`, with
`knowledge/paperclip/env/` and `knowledge/paperclip/secrets/` mounted over the
canonical `/stash/env` and `/stash/secrets` paths. Its AKM config and state are
isolated at `/etc/akm`, `/opt/akm/cache`, and `/opt/akm/data`.

The compatibility adapter is required by the OpenCode `1.3.0` bundled in the
current digest-pinned Paperclip image. Re-test plugin loading, bare `akm`, and
model tool invocation whenever that image changes.

Managed permissions allow `/stash` plus Paperclip's generated per-agent
instruction and workspace directories. Those paths can sit outside the active
project cwd, so the grants prevent noninteractive runs from auto-rejecting
Paperclip's own `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`, and agent-memory reads.
The pinned upstream adapter otherwise passes its full server environment to
OpenCode. The managed launcher removes the server authentication and JWT-signing
secrets while preserving Paperclip's short-lived run API key; managed
instructions prohibit environment enumeration so that run key is not logged.

## Secret Boundary

- Provider `auth.json` is the only service credential retained under
  `knowledge/secrets/` for assistant access.
- UI, OpenCode server, Guardian, API, portal, and bot credentials live under
  `private/secrets/`.
- The private tree is never mounted into `/stash`. Compose exposes only named
  secret files to consuming service processes.
- `state/stack.env` contains non-secret runtime configuration only.

## Day-to-Day Changes

- Put user tools, plugins, commands, skills, persona, and provider/model config
  under `~/.openpalm/config/assistant/`.
- Put Paperclip-specific OpenCode settings under
  `~/.openpalm/config/paperclip/opencode/` and its AKM settings under
  `~/.openpalm/config/paperclip/akm/`.
- Update provider credentials through OpenCode auth state at
  `~/.openpalm/knowledge/secrets/auth.json`.
- Edit only `~/.openpalm/config/stack/custom.compose.yml` for user stack
  overrides. Managed Compose is read from `~/.openpalm/system/stack/` and will be
  overwritten on reconcile.
- Restart the relevant container after startup configuration or credential
  changes.
