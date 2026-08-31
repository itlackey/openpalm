# Environment Variables, Mounts, and Network Wiring

This document mirrors the 0.13.0 runtime. The primary sources are:

- `packages/skeleton/system/stack/core.compose.yml`
- `packages/skeleton/system/stack/services.compose.yml`
- `packages/skeleton/system/stack/portals.compose.yml`
- `packages/skeleton/config/stack/custom.compose.yml`
- `containers/*/entrypoint.sh`
- `packages/lib/src/control-plane/setup.ts`
- `packages/lib/src/control-plane/access-toggles.ts`

## Host Layout

`OP_HOME` defaults to `~/.openpalm`. Its top-level trees are separated by
ownership:

| Host path | Owner | Purpose |
|---|---|---|
| `config/` | User | Non-secret assistant, guardian, AKM, and custom stack config |
| `system/` | OpenPalm | Release assets overwritten on reconcile, including managed Compose, OpenCode config, and the shipped `system/skills/` AKM bundle |
| `state/` | OpenPalm | App-written records, including the one `state/stack.env`, the generated runtime config containers read (`state/remote/`), and the delegated credentials that must not enter assistant `/stash` (`state/secrets/`, `state/env/`) |
| `knowledge/` | User/services | AKM stash, tasks, user env, and provider `secrets/auth.json`; mounted into the assistant at `/stash` |
| `data/` | Services | Durable homes, databases, logs, backups, and rollback state |
| `workspace/` | User | Shared assistant work area, mounted at `/work` |
| `cache/` | System | Regenerable assistant and guardian caches |

Host-side ephemeral artifacts outside `OP_HOME` use `~/.cache/openpalm/`.

> **This is the reorganized layout** approved 2026-08-08. `knowledge/` is the
> one stash, shared with an addon or not via an AKM
> bundle entry rather than a parent mount with overmounts on top of it, and the
> retired `private/` tree has merged into `state/`. Stash contents keep AKM's
> asset layout. See [`core-principles.md`](core-principles.md) § Accepted
> changes for the binding rules and
> [`../reviews/op-home-restructure-proposal.md`](../reviews/op-home-restructure-proposal.md)
> for the decision record and migration.

Lifecycle safety backups include `state/` and exclude `data/` and regenerable
`cache/`. A service excluded that way takes its own credentials with it:
`state/env/<service>.env` is left out alongside `data/<service>/`, so the pair
is backed up and restored as one unit, and the snapshot's `.backup-complete`
marker names each file it skipped. `uninstall --purge` removes every `OP_HOME`
tree, including `state/` and `cache/`. Ownership reconciliation covers
durable/user/state paths and does not spend a recursive repair pass on
regenerable cache content.

## Compose Files, Env, and Secrets

Docker Compose uses this fixed file set:

1. `$OP_HOME/system/stack/core.compose.yml`
2. `$OP_HOME/system/stack/services.compose.yml`
3. `$OP_HOME/system/stack/portals.compose.yml`
4. `$OP_HOME/config/stack/custom.compose.yml`

The first three are managed and overwritten on reconcile. The fourth is the
only user-owned stack overlay and is seeded once.

Compose receives exactly one non-secret env file:

```bash
--env-file "$OP_HOME/state/stack.env"
```

Secret storage is split by exposure, and the split is default-deny: a secret
lands in `state/secrets/` unless its name is on the agent-readable allowlist
in `secrets-files.ts` (`AGENT_READABLE_SECRET_NAMES`).

- `knowledge/secrets/auth.json` is OpenCode provider auth state, and is the only
  name on that allowlist. It remains in the assistant-readable knowledge tree
  and is bind-mounted into the assistant.
- `state/secrets/` holds everything else: the UI password, OpenCode server
  password, Guardian/API tokens, portal principal secrets, bot tokens, and any
  credential a later release adds without saying where it goes. The directory is
  never mounted into assistant `/stash`; Compose grants only named files to the
  service process that consumes them.
- `state/env/paperclip.env` is the sole audited env-file exception. The pinned
  upstream image requires its two server secrets as environment variables; the
  audit enforces the exact path, exact key set, values, and file modes.
- `knowledge/env/user.env` is the AKM `env/user` backing file. It is not a
  Compose env file and the assistant entrypoint does not source it. Scoped agent
  tools and AKM commands load it on demand.

Secret directories use mode `0700`; secret files use `0600`. Secret values do
not belong in `state/stack.env` or broad service `env_file` blocks; Paperclip's
exact-key file above is the only exception.

## Access Toggles

The setup v2 schema uses only a flat optional `access` object.

| Setup boolean | Generated behavior |
|---|---|
| `access.networkAccess` | Generates `OP_UI_BIND_ADDRESS` |
| `access.assistantDirect` | Generates `OP_ASSISTANT_BIND_ADDRESS`. A bind and nothing else — OpenCode requires its generated password whether or not the port is published |
| `access.guardianNetwork` | Generates `OP_GUARDIAN_BIND_ADDRESS` and `GUARDIAN_DIRECT_INGRESS` |
| `access.guardianOpenaiApi` | Generates `OP_API_BIND_ADDRESS` and ensures the `api` addon is enabled |

Generated bind/auth values are written explicitly to `state/stack.env` on a
setup change. They do not inherit from a global bind. The service-specific bind
names are `OP_UI_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`,
`OP_GUARDIAN_BIND_ADDRESS`, and `OP_API_BIND_ADDRESS`. Voice always binds to
literal `127.0.0.1`; only its host port is configurable.

## Assistant

Compose source: `packages/skeleton/system/stack/core.compose.yml`.

### Mounts

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/assistant` | `/home/opencode` | rw | Persistent `HOME` |
| `$OP_HOME/cache/assistant` | `/home/opencode/.cache` | rw | Regenerable Bun/npm/OpenCode cache |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | User OpenCode global config |
| `$OP_HOME/system/assistant` | `/etc/opencode` | rw | Managed `OPENCODE_CONFIG_DIR` |
| `$OP_HOME/knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | Provider auth state |
| `$OP_HOME/knowledge` | `/stash` | rw | AKM stash, including `env/user.env` and `tasks/` |
| `$OP_HOME/system/skills` | `/system-stash` | ro | Release-shipped skills, as a read-only AKM bundle |
| `$OP_HOME/config/akm` | `/etc/akm` | rw | AKM config |
| `$OP_HOME/data/akm/cache` | `/opt/akm/cache` | rw | AKM cache and task logs |
| `$OP_HOME/data/akm/data` | `/opt/akm/data` | rw | AKM databases and task history |
| `$OP_HOST_AKM_STASH` or an empty fallback | `/host-stash` | rw | Optional secondary host AKM source |
| `$OP_HOME/workspace` | `/work` | rw | Shared work area |
| `assistant-persistent` | `/opt/persistent` | rw | Optional-tool persistence |

`state/secrets/` is not a volume. The assistant service receives only the
individual `op_opencode_password` and `op_ui_login_password` files it needs
through Compose secrets at `/run/secrets/`; neither appears under `/stash`.

### Ports

| Surface | Container | Default host publication |
|---|---:|---|
| OpenPalm UI | `3000` | `${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}` |
| OpenCode | `4096` | `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}` |
| OpenCode workspace | `${OP_WORKSPACE_PORT:-3820}` | `${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_WORKSPACE_PORT:-3820}` |

The workspace is a second listener inside the UI process
(`packages/ui/src/lib/server/workspace-listener.ts`), not a service of its own.
It proxies the assistant's OpenCode 1:1 at an origin ROOT, which is what
OpenCode's web UI requires — its SPA resolves `/assets` and `/api` against
`location.origin` and has no base-path option, so it cannot be served under a
path on the UI's origin. Access is the SAME login as the UI: it checks that
surface's session cookie (host-scoped, so the browser already sends it to this
port) and attaches OpenCode's own Basic credential upstream, server-side. A
request that brings its own `Authorization` header is proxied verbatim, so
external OpenCode clients holding the server password are unaffected. It is
published on the UI's interface because it is only useful where the UI is, and
it binds `HOST` — the UI child's own `0.0.0.0` — so Docker's published mapping
can reach it.

Only the assistant container's UI co-process binds it
(`OP_UI_SERVED_IN_CONTAINER=1`). The same build also runs host-side (`openpalm
app`/`admin`, Electron), and since compose publishes this port onto the host, a
host-side bind would claim the port Docker needs and stop the assistant
container from starting at all — while serving nothing the published mapping
does not already serve, including for a phone on the LAN. A host process with no
stack running therefore has no workspace, which is correct: there is no OpenCode
behind it to proxy.

The image bakes the candidate-local `@openpalm/ui` build. The entrypoint
supervises the baked UI and performs no runtime package install. Skeleton assets
are materialized on the host from the CLI's or Electron app's own embedded
copy — there is no runtime download.

### Key Environment

| Variable | Default/source | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode listener |
| `OPENCODE_SERVER_PASSWORD_FILE` | `/run/secrets/opencode_server_password` | Generated OpenCode server credential |
| `OP_UI_LOGIN_PASSWORD_FILE` | `/run/secrets/ui_login_password` | Login credential passed only to the UI child |
| `OP_OPENCODE_URL` | `http://localhost:4096` | Local upstream for the UI's same-origin `/oc` proxy |
| `HOME` | `/home/opencode` | Persistent runtime home |
| `AKM_BUNDLE_DIR` | `/stash` | Primary AKM bundle |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data |
| `AKM_STATE_DIR` | `/opt/akm/data/state` | AKM task-scheduler state |
| `OP_UI_DEFAULT_ASSISTANT_URL` | `/oc` when unset | Optional default-connection override |

The assistant has no Docker socket, admin credential, or admin network path.

## Paperclip

Compose source: `packages/skeleton/system/stack/services.compose.yml`.

| Host source | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/paperclip` | `/paperclip` | rw | Complete Paperclip instance, including its embedded database |
| `$OP_HOME/config/paperclip/opencode` | `/paperclip/.config/opencode` | ro | User OpenCode global config |
| `$OP_HOME/system/paperclip` | `/opt/openpalm/paperclip` | ro | Managed AKM plugin bootstrap and launchers |
| `$OP_HOME/cache/paperclip-opencode/runtime` | `/etc/opencode` | rw | Regenerable OpenCode runtime config and exact-pinned plugin dependencies |
| `$OP_HOME/config/paperclip/akm` | `/etc/akm` | rw | Paperclip-specific AKM config |
| `$OP_HOME/knowledge` | `/stash` | rw | Shared knowledge and AKM assets |
| `$OP_HOME/data/paperclip-akm/cache` | `/opt/akm/cache` | rw | Paperclip AKM cache |
| `$OP_HOME/data/paperclip-akm/data` | `/opt/akm/data` | rw | Paperclip AKM database and runtime state |
| `$OP_HOME/state/env/paperclip.env` | Compose `env_file` | ro input | Upstream-required authentication and agent-JWT secrets |

Paperclip is a normal `addon.paperclip` service. It is published only at
`127.0.0.1:${OP_PAPERCLIP_PORT:-3840}` and joins only `addon_net`.

Paperclip sees the shared stash as it is. It used to receive two per-service
overmounts on `/stash/env` and `/stash/secrets` — a boundary held up by hiding
one mount behind another, which is exactly what the tree-name-equals-mount rule
forbids. Nothing agent-private lives under `knowledge/` any more (secret routing
is default-deny into `state/secrets/`), so the overmounts guarded nothing.
Everything in `knowledge/` is readable by every agent that gets `/stash`, the
assistant and Paperclip alike; grant an addon a narrower view with a `:ro`
mount and an AKM bundle entry, not by covering a path.

### Key Environment

| Variable | Value | Purpose |
|---|---|---|
| `XDG_CONFIG_HOME` | `/paperclip/.config` | Keeps model preflight and agent runs on one user config |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Mutable runtime copy of managed plugin bootstrap and permissions |
| `AKM_BUNDLE_DIR` | `/stash` | The shared stash bundle |
| `AKM_CONFIG_DIR` | `/etc/akm` | Paperclip AKM config |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable state |
| `AKM_STATE_DIR` | `/opt/akm/data/state` | AKM task-scheduler state |
| `PATH` | read-only managed launchers, exact-pinned runtime package shims, then upstream system paths | Keeps the server-secret-scrubbing OpenCode and embedded-Bun launchers authoritative while making `akm` available to every adapter run |

**Backups: `data/paperclip` is NOT covered by lifecycle safety backups.** It is
service-owned data, which the backup scope in
[`core-principles.md`](core-principles.md) deliberately excludes — and because
Paperclip runs an *embedded* PostgreSQL cluster inside that directory, the whole
company/agent/issue database is excluded with it. Upstream scopes embedded
Postgres to local development and recommends an external database for
production, so treat this as an operator responsibility rather than an
oversight:

Using the [`op()` Compose helper](../operations/manual-compose-runbook.md#shell-helper):

```sh
# Consistent logical backup (preferred — safe while running):
op --profile addon.paperclip exec -w /app paperclip \
  pnpm paperclipai db:backup --data-dir /paperclip

# Or stop the addon first and copy the directory:
openpalm addon disable paperclip && cp -a ~/.openpalm/data/paperclip <destination>
```

The credentials in `state/env/paperclip.env` leave the snapshot **with**
`data/paperclip`: a service's data and its credentials are one restore unit, so
a snapshot takes both or neither. Restoring the secrets alone would give a
working login against an empty database and read as a successful restore. The
snapshot names what it left out in its `.backup-complete` marker; the two
commands above take both halves together.

Paperclip OpenCode/AKM user config is also in lifecycle safety backup scope. `data/paperclip-akm/` is service state and
excluded; `cache/paperclip-opencode/runtime/` is regenerable and excluded.

## Guardian

Compose source: `packages/skeleton/system/stack/portals.compose.yml`. Guardian is
profile-gated and is not an always-on core service.

### Mounts and Secrets

| Host source | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/guardian` | `/opt/openpalm/guardian` | rw | Guardian home and SQLite state |
| `$OP_HOME/cache/guardian` | `/opt/openpalm/guardian/.cache` | rw | Regenerable Bun cache |
| `$OP_HOME/data/logs` | `/opt/openpalm/logs` | rw | Guardian audit log |
| `$OP_HOME/system/guardian` | `/opt/openpalm/guardian-config` | ro | Managed moderator policy source (instructions, permissions) |
| `$OP_HOME/cache/guardian-opencode/runtime` | `/etc/opencode` | rw | Regenerable moderator `OPENCODE_CONFIG_DIR`, republished from the managed source at boot |
| `$OP_HOME/config/guardian` | `/opt/openpalm/guardian/.config/opencode` | rw | User moderation model config |
| `knowledge/secrets/auth.json` via `guardian_auth_json` | `/run/secrets/guardian_auth_json` | ro | Provider auth copied into Guardian home at boot |
| Named files from `state/secrets/` | `/run/secrets/<name>` | ro | Guardian, API, portal, and upstream credentials |

Guardian mounts no `knowledge/` directory. Provider `auth.json` is delivered as
one Compose secret; delegated credentials come from `state/secrets/`.

The managed moderator config arrives read-only, and `OPENCODE_CONFIG_DIR` is a
separate regenerable copy under `cache/`. OpenCode writes into every config
directory it loads, so this split is what keeps `system/guardian/` a policy tree
the policed process cannot rewrite — the same split Paperclip uses.

### Ports

| Surface | Container | Default host publication |
|---|---:|---|
| Internal Guardian gateway | `8080` | None |
| Direct Guardian `/oc` listener | `3830` | `${OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}` |
| Principal admin listener | `3831` | `127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}` |
| OpenAI/Anthropic-compatible listener | `8182` | `${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}` — published only when `guardian.compose.api.yml` is in the file list (`guardianOpenaiApi` toggle on, or `api` addon enabled); no host port otherwise |
| Local OpenCode moderator | `4097` | None; loopback inside the container |

There is one Guardian OpenAI-compatible listener and one host publication.

### Key Environment

| Variable | Default/source | Purpose |
|---|---|---|
| `PORT` | `8080` | Internal Guardian gateway |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Protected assistant upstream |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Moderator config root |
| `GUARDIAN_CONTENT_VALIDATION` | `1` | Content validation; code fallback and shipped Compose are both on |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local moderator upstream |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Escalation threshold |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Moderator timeout |
| `GUARDIAN_DIRECT_INGRESS` | Generated, default `false` | Enables the direct listener's request paths |
| `GUARDIAN_CORS_ALLOWED_ORIGINS` | Empty | Exact direct-ingress browser origins; wildcard is rejected |
| `GUARDIAN_SESSION_ACTIVE_GRACE_MS` | `86400000` (24 hours) | Recent-use window that exempts active sessions from ownership eviction |
| `GUARDIAN_RECONCILE_INTERVAL_MS` | `300000` (5 minutes) | Orphan-session reconciliation cadence; `0` disables periodic sweeps |
| `GUARDIAN_OPENAI_PORT` | `8182` | Single compatible API listener |
| `OPENAI_COMPAT_API_KEY_FILE` | `/run/secrets/op_api_key` | Client API key; missing key fails closed |
| `OP_GUARDIAN_NPM_VERSION` | Image version when unset | Guardian thin-host package override |

Only explicit `0`, `false`, `no`, or `off` values (case-insensitive) disable
content validation. Suspicious messages escalate to the moderator; moderator
timeout, failure, or an invalid verdict blocks the escalated message.

## Scheduler

Scheduling runs through `supercronic` inside the assistant container.

- Definitions are AKM YAML task files under `$OP_HOME/knowledge/tasks/`, visible
  in the container as `/stash/tasks/`.
- A target is either `run:` (a shell string) or `uses:` (`akm/command` for a
  prompt, or a `workflows/`, `commands/`, or `scripts/` ref).
- `akm task sync` registers tasks in the user crontab at startup and every 60
  seconds.
- `supercronic` has no network listener or Docker socket.
- Cron receives only the small managed environment preamble needed by AKM and
  OpenCode. It does not inherit all values from `knowledge/env/user.env`.

## Host UI Process

`openpalm app`, `openpalm admin`, and Electron run the same adapter-node UI build
as host processes. They are not containers. Admin-capable launches access
`OP_HOME` and the host Docker socket directly; no socket is mounted into a
container and there is no socket-proxy service.

| Variable | Default/source | Purpose |
|---|---|---|
| `PORT` / `OP_HOST_UI_PORT` | `3880` | Host UI listener |
| `OP_HOME` | Host environment | OpenPalm home |
| `OP_UI_LOGIN_PASSWORD` | Loaded from `state/secrets/op_ui_login_password` | Session login verification |
| `OP_TRUSTED_PROXY` | Off | Non-admin `openpalm app` only: trusts `Host`/`x-forwarded-proto` from an operator-managed reverse proxy (Tailscale Serve, Caddy, nginx) **without** widening the listener off loopback |
| `OP_ALLOW_REMOTE_SETUP` | Off | Non-admin `openpalm app` only: binds `0.0.0.0` directly, for the rare case with no reverse proxy in front |

`OP_TRUSTED_PROXY` and `OP_ALLOW_REMOTE_SETUP` are independent opt-ins — see
[Remote Access over TLS](../remote-access-tls.md). Electron and `openpalm
admin` remain loopback-only. Direct package UI development
defaults to `5173`; the root `ui:dev:isolated` script explicitly uses `3880`.

## Addons and Networks

| Service | Network membership | Host exposure |
|---|---|---|
| `assistant` | `assistant_net` | UI `3800`, OpenCode `3810`, loopback by default |
| `guardian` | `assistant_net`, `portal_net` | Direct `3830`, admin `3831`, loopback by default; compatible API `3821` only via the opt-in `guardian.compose.api.yml` overlay |
| `discord`, `slack` | `portal_net` | None |
| `ollama*` | `assistant_net` | None |
| `voice*` | `addon_net` (default) | `127.0.0.1:${OP_VOICE_PORT_HOST:-8880}` |
| `paperclip` | `addon_net` | `127.0.0.1:${OP_PAPERCLIP_PORT:-3840}` |

`addon_net` keeps services that do not need assistant access off the assistant
trust network. Guardian is the only service bridging portal ingress to
`assistant_net` by default; `ollama*` is the one per-service exception granted
to a third-party addon image. `OP_VOICE_LAN_ACCESS=true` grants voice the same
exception (`voice.compose.lan.yml`, an opt-in overlay), so the assistant
container's served UI can proxy `/voice` for LAN clients — see [Managing
OpenPalm](../managing-openpalm.md) and `docs/troubleshooting.md`.

## Core `state/stack.env` Variables

| Variable | Purpose |
|---|---|
| `OP_HOME` | Host root used in bind mounts |
| `OP_UID`, `OP_GID` | Runtime identity for bind-mounted files |
| `OP_IMAGE_NAMESPACE` | Image namespace |
| `OP_ASSISTANT_VERSION`, `OP_GUARDIAN_VERSION`, `OP_PORTAL_VERSION`, `OP_VOICE_VERSION` | Image pins for OpenPalm-built images (paperclip pulls a digest-pinned upstream image, so it has no version key) |
| `OP_ENABLED_ADDONS` | Enabled first-party addon names |
| `OP_UI_BIND_ADDRESS`, `OP_UI_PORT` | Container-served UI host publication |
| `OP_ASSISTANT_BIND_ADDRESS`, `OP_ASSISTANT_PORT` | Direct OpenCode host publication |
| `OP_WORKSPACE_PORT` | OpenCode workspace listener, default `3820`, resolved like every other port (an unbindable value falls back to the default). It has no bind variable — the listener follows the UI's own `HOST`. There is no off-switch: compose publishes this port through `${OP_WORKSPACE_PORT:-3820}`, so an "off" value either substitutes the default anyway (empty) or renders an invalid published-port spec (`0`/junk) that fails the whole stack |
| `OP_GUARDIAN_BIND_ADDRESS`, `OP_GUARDIAN_PORT` | Guardian direct host publication |
| `OP_API_BIND_ADDRESS`, `OP_API_PORT` | Guardian compatible API publication |
| `OP_VOICE_PORT_HOST` | Voice loopback publication port |
| `OP_PAPERCLIP_PORT` | Paperclip loopback publication port |
| `OP_HOST_UI_PORT` | Host-process UI port, default `3880` |
| `GUARDIAN_DIRECT_INGRESS` | Generated Guardian direct-ingress posture |
| `OP_ACCESS_NETWORK`, `OP_ACCESS_ASSISTANT_DIRECT`, `OP_ACCESS_GUARDIAN`, `OP_ACCESS_OPENAI_API` | The four access toggles' stored intent (`true`/`false`), written alongside the generated bind/auth row above so a read is a read, not an inference from bind addresses (`access-toggles.ts` `ACCESS_INTENT_KEYS`) |
| `GUARDIAN_CONTENT_VALIDATION` | Content-validation opt-out switch; on by default |
| `GUARDIAN_SESSION_ACTIVE_GRACE_MS` | Active-session eviction grace window |
| `GUARDIAN_RECONCILE_INTERVAL_MS` | Orphan-session reconciliation cadence; `0` disables periodic sweeps |
| `OP_MDNS` | Host mDNS responder switch; explicit `0`/`false`/`no`/`off` disables |
| `OP_OWNER_NAME`, `OP_OWNER_EMAIL` | Operator identity metadata |
| `OP_SETUP_COMPLETE` | Successful setup/deploy record |
