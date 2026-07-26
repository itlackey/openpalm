# Environment Variables, Mounts, and Network Wiring

This document mirrors the current shipped runtime: repo assets under
`packages/skeleton/` and runtime files under `OP_HOME`.

Primary sources:

- `.openpalm/config/stack/core.compose.yml`
- `.openpalm/config/stack/services.compose.yml`
- `.openpalm/config/stack/portals.compose.yml`
- `.openpalm/config/stack/custom.compose.yml`
- `containers/*/entrypoint.sh` and service source where runtime defaults matter

When this document conflicts with older prose elsewhere, the compose files win.

---

## Host-Level Layout

OpenPalm stores runtime state under `OP_HOME`, which defaults to `~/.openpalm`.

| Host path | Purpose |
|---|---|
| `~/.openpalm/config/` | User-editable, non-secret config |
| `~/.openpalm/config/stack/` | Live compose assembly; `core.compose.yml`, `services.compose.yml`, `portals.compose.yml`, and `custom.compose.yml` |
| `~/.openpalm/knowledge/` | AKM knowledge base (user-managed: `env/`, `secrets/`, `tasks/`) |
| `~/.openpalm/knowledge/env/` | User-managed env config (`user.env`, AKM env backing store) |
| `~/.openpalm/knowledge/secrets/` | System-managed file secrets (akm secret — Compose grants) |
| `~/.openpalm/data/` | Durable service data, logs, lifecycle backups, and rollback snapshots |
| `~/.openpalm/data/logs/` | Audit and debug logs |
| `~/.cache/openpalm/` | Ephemeral system cache |

Current durable data subdirectories used by the shipped stack:

- `data/assistant`
- `data/guardian`
- `data/akm`
- `data/akm/cache`
- `data/akm/data`
- `data/logs`
- `data/backups`
- `data/rollback`
- `knowledge/` (shared akm stash mounted at `/stash` for assistant)
- `workspace/` (shared work area)

Persistent memory and knowledge live in `knowledge/` (the shared akm stash
mounted at `/stash` for the assistant). There is no separate memory service.

---

## Compose Env And Secrets

Docker Compose is invoked with the non-secret stack env file (see [Manual Compose Runbook](../operations/manual-compose-runbook.md)):

```bash
--env-file "$OP_HOME/knowledge/env/stack.env"
```

That means the effective env model is:

- `knowledge/env/stack.env` - system-managed non-secret runtime env (paths, UID/GID, image tags, bind ports, profiles, feature flags, owner identity)
- `knowledge/secrets/` - system-managed secret files, directory mode `0700`, file mode `0600`; granted to containers with Compose `secrets:` and exposed as `*_FILE` variables
- `knowledge/env/user.env` - AKM env backing file for user-managed secrets; never a Compose env-file

---

## Core Services

> Memory is not a separate service. Persistent knowledge and recall
> live in the akm stash bind-mounted from the host: `knowledge/` is mounted at `/stash`
> in the assistant container. See
> [`core-principles.md`](core-principles.md) for the rationale.

### Assistant

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/system/assistant` | `/etc/opencode` | rw | **Managed** OpenCode config (`OPENCODE_CONFIG_DIR`) — plugins, permissions, instructions; overwritten on update |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | **User** OpenCode global config — `persona.md`, model/provider choices |
| `$OP_HOME/knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | Host-managed OpenCode auth copy |
| `$OP_HOME/config/akm` | `/etc/akm` | rw | AKM config |
| `$OP_HOME/data/assistant` | `/home/opencode` | rw | Assistant persistent home |
| `$OP_HOME/knowledge` | `/stash` | rw | AKM stash |
| `$OP_HOME/data/akm/cache` | `/opt/akm/cache` | rw | AKM cache and task logs |
| `$OP_HOME/data/akm/data` | `/opt/akm/data` | rw | AKM databases and durable data |
| `$OP_HOME/workspace` | `/work` | rw | Shared workspace |
| `assistant-persistent` | `/opt/persistent` | rw | Escape hatch for prefix-style global installs |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `4096` (OpenCode), `3000` (@openpalm/ui co-process) |
| Host bind | `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}` (OpenCode) |
| UI host bind | `${OP_UI_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_UI_PORT:-3800}:3000` (UI) |
| Networks | `assistant_net` |

Fresh and migrated installs explicitly write `OP_UI_PORT=3800` and
`OP_ASSISTANT_PORT=3810` to `stack.env`, and the Compose interpolation
fallbacks now carry that same pair. They previously carried the RETIRED pair
(assistant `3800` / UI `3810`) as a guard for a pre-migration control plane —
but `migrateLegacyDefaultPorts()` runs before Compose on every deploy path
(`lifecycle.applyHome`, `cli-compose.runComposeWithPreflight`,
`install.ts`, the UI supervisor hook), so that guard was unreachable in
practice and only inverted the layout for the manual `docker compose` path.

The UI co-process serves the single `@openpalm/ui` SvelteKit `adapter-node`
build ("One UI, delete the split") — the SAME build Electron and the CLI serve.
It binds `0.0.0.0` **inside** the container on port `3000`; host exposure is
governed solely by the compose mapping above, which defaults to loopback and
honors the global `OP_BIND_ADDRESS` policy with a per-service
`OP_UI_BIND_ADDRESS` override. At startup the entrypoint writes a
`runtime-config.json` beside the build seeding the browser-owned connection
store with one locked default connection — shape `{ id, label, baseUrl, auth }`
— pointing the browser at the host-published OpenCode URL
(`http://127.0.0.1:${OP_ASSISTANT_PORT:-3810}`, full-URL override via
`OP_UI_DEFAULT_ASSISTANT_URL`). The browser talks to OpenCode **directly**
(browser-owned transport, no host proxy), so OpenCode must CORS-allow the UI's
browser origin — see the CORS note below.

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenPalm-managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode web server listen port |
| `OPENCODE_AUTH` | `${OPENCODE_AUTH:-false}` | Compose-interpolated, off by default. The supported way to turn it on is a network access preset (#563, Setup → Network access) — the home-password preset sets this `true` |
| `OPENCODE_SERVER_PASSWORD_FILE` | `/run/secrets/opencode_server_password` (compose secret `opencode_server_password` → `knowledge/secrets/op_opencode_password`) | OpenCode's Basic-auth password, read at boot when `OPENCODE_AUTH=true`; always granted (the secret is always materialized, inert while auth is off) |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/stash` | AKM stash location hint |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config directory |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache directory |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data directory |
| `OP_UID` / `OP_GID` | `stack.env` | Direct runtime uid/gid mapping |
| `OP_UI_VERSION` | `stack.env` (empty = image `PLATFORM_VERSION`) | Exact-pin override for the `@openpalm/ui` artifact the entrypoint installs |
| `OP_SKELETON_VERSION` | `stack.env` (empty = image `PLATFORM_VERSION`) | Exact-pin override for the `@openpalm/skeleton` artifact the assistant entrypoint installs |
| `OP_ASSISTANT_PORT` | `stack.env` (default `3810`) | Host-published OpenCode port; used to build the UI's default connection URL |
| `OP_UI_PORT` | `stack.env` (default `3800`) | Host-published assistant UI port |
| `OP_UI_DEFAULT_ASSISTANT_URL` | `stack.env` (optional) | Full-URL override for the UI's locked default connection |
| `OP_UI_HOST_PORT` | compose-passed from `OP_UI_PORT` (default `3800`) | Host-published UI port; the entrypoint builds OpenCode's CORS origin from it (distinct from the deliberately-unpassed `OP_UI_PORT`, which the healthcheck reads as the in-container `:3000` default) |
| `OP_UI_CORS_ALLOWED_ORIGINS` | `stack.env` (optional) | Extra comma-separated exact origins passed to OpenCode `--cors` for LAN / reverse-proxy UI deployments. Scheduled for removal: once the UI serves OpenCode same-origin at `/oc` (the pattern `/voice` already uses) the browser makes no cross-origin request and there is nothing to grant |
| `OP_BIND_ADDRESS` / `OP_ASSISTANT_BIND_ADDRESS` / `OP_UI_BIND_ADDRESS` | compose env interpolation | Govern loopback-first host exposure; the entrypoint warns when OpenCode is exposed without authentication |

Notes:

- The assistant has no Docker socket mount.
- The assistant reads user secrets via `akm env:user` — there is no `/etc/vault/` container mount.
- Because the browser talks to OpenCode directly, the entrypoint grants the UI's browser origin CORS via OpenCode `--cors`: the loopback UI origins (`http://127.0.0.1:${OP_UI_HOST_PORT}` and `localhost`) by default, plus any exact comma-separated origins from `OP_UI_CORS_ALLOWED_ORIGINS` (a LAN host, a reverse proxy). Each candidate is validated as an exact `http(s)` origin. **The entrypoint never emits a wildcard `--cors "*"` grant, under any configuration** — a wildcard host bind (`0.0.0.0`/`::`) cannot be resolved to the one true browser Origin a LAN visitor's browser will send, so operators add exact origins via `OP_UI_CORS_ALLOWED_ORIGINS` instead.
- **LAN-exposure warning:** when the assistant binds off loopback (`OP_ASSISTANT_BIND_ADDRESS`/`OP_BIND_ADDRESS`) and `OPENCODE_AUTH` stays disabled, the entrypoint logs a prominent warning naming both knobs and continues starting the UI. Set `OPENCODE_AUTH=true` with real credentials unless open LAN access is intentional.
- The compose healthcheck for the assistant service probes both OpenCode (`:4096`) and the UI port. A missing UI build or a give-up-after-crash-loop leaves `/tmp/openpalm-ui-skip`; only those unavailable-build conditions exempt the UI probe.
- The entrypoint starts as root only long enough to normalize permissions and optional SSH setup, then drops privileges.

### Guardian

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/guardian` | `/opt/openpalm/guardian` | rw | Runtime nonce / rate-limit state |
| `$OP_HOME/config/guardian` | `/etc/opencode` | rw | Guardian OpenCode global config (`OPENCODE_CONFIG_DIR`) |
| `$OP_HOME/knowledge/secrets/auth.json` | `/opt/openpalm/guardian/.local/share/opencode/auth.json` | ro | Shared OpenCode provider credentials (same file the assistant mounts) |
| `$OP_HOME/data/logs` | `/opt/openpalm/logs` | rw | Guardian audit log directory |
| `$OP_HOME/knowledge/secrets/<guardian-or-principal-secret>` | `/run/secrets/<name>` | ro | Guardian and portal/direct principal secret files granted by Compose |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8080` |
| Host bind | `${OP_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}` plus `127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}` |
| Networks | `portal_net`, `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `HOME` | `/opt/openpalm/guardian` | Writable runtime home |
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant forward target |
| `OPENCODE_TIMEOUT_MS` | `0` | Guardian-side timeout override |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Moderator OpenCode config dir (from `config/guardian`) |
| `GUARDIAN_AUDIT_PATH` | `/opt/openpalm/logs/guardian-audit.log` | Audit log path |
| `PORTAL_<NAME>_SECRET_FILE` | `/run/secrets/portal_<name>_secret` | Portal principal seed secret file |
| `GUARDIAN_CONTENT_VALIDATION` | `0` | Enable opt-in, fail-closed content validation of inbound messages |
| `OPENCODE_AUTH` | `${OPENCODE_AUTH:-false}` | Same flag the assistant reads; when `true`, the guardian attaches upstream Basic auth to every `assistant_net` call (proxy, event-fanout `/event`, drift-check `/doc`) so its own OpenCode auth doesn't break portal traffic (#563/D2). The moderator's own loopback OpenCode spawn is unaffected — it pins its own `OPENCODE_AUTH=false` |
| `OPENCODE_SERVER_PASSWORD_FILE` | `/run/secrets/opencode_server_password` | Same secret file the assistant serves Basic auth from; read once at module load, fail-closed boot error if `OPENCODE_AUTH=true` and the file is missing/empty |
| `GUARDIAN_DIRECT_INGRESS` | `false` | Enables the browser-facing direct-ingress path on `GUARDIAN_DIRECT_PORT`/`OP_GUARDIAN_PORT`; off by default (404 when disabled) |
| `GUARDIAN_CORS_ALLOWED_ORIGINS` | empty (compose passes `${GUARDIAN_CORS_ALLOWED_ORIGINS:-}`) | Comma-separated exact browser origins allowed on guardian direct-ingress CORS responses. Empty by default — set it to the exact UI origin(s) that will reach the guardian directly. Never a wildcard (guardian rejects a literal `*` here) |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local OpenCode moderator endpoint |
| `GUARDIAN_MODERATION_PORT` | `4097` | Loopback port the entrypoint starts the moderator on |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic risk score at/above which a message escalates to the model |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Per-classification timeout; on expiry the message fails closed |

Notes:

- Guardian's main proxy is localhost-published by default and never exposed publicly unless the bind address is changed deliberately.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian receives only explicitly granted secret files from `knowledge/secrets/`; it must not use service-level `env_file` or raw secret env values.
- `GUARDIAN_DIRECT_INGRESS` and `GUARDIAN_CORS_ALLOWED_ORIGINS` work together: direct-ingress must be enabled AND the connecting browser origin must be in the CORS allowlist, or the connection is dead-on-arrival (404 when ingress is off; CORS-denied even when it's on). `GUARDIAN_CORS_ALLOWED_ORIGINS` is empty by default, so enabling direct-ingress alone is not enough — set it to the exact UI origin(s) that will reach the guardian directly (a browser talks to a Guardian `/oc` base the same as any OpenCode connection).
- Fronting the direct listener with HTTPS for remote/phone browsers: see [`docs/remote-access-tls.md`](../remote-access-tls.md) (Tailscale `serve` recommended, Caddy + own domain alternative). Once TLS-fronted, add the (https) UI origin to `GUARDIAN_CORS_ALLOWED_ORIGINS` — see above.

### Scheduler co-process

The scheduler is no longer a separate compose service. It runs as a Bun
co-process inside the `assistant` container, launched by
`containers/assistant/entrypoint.sh`.

Scheduling control plane (crond started by `containers/assistant/entrypoint.sh`):

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/knowledge/tasks` | `/knowledge/tasks` | rw | AKM task markdown files |
| `$OP_HOME/data/akm/cache` | `/opt/akm/cache` | rw | AKM task logs and cache |
| `$OP_HOME/data/akm/data` | `/opt/akm/data` | rw | AKM task history and durable data |

Notes:

- `crond` runs in the background; no network port, no Docker socket.
- `akm tasks sync` registers task files with the user crontab at boot and every 60 s.
- Manual trigger: `POST /api/host/automations/<name>/run` (admin spawns `akm tasks run <name>` directly).

---

## Host UI Process

The UI is an adapter-node host process started by `openpalm`. It has no container or `$OP_HOME` volume bind; admin-capable launches access host resources directly.

Normal non-admin launches bind internally to `127.0.0.1` and use `http://localhost:${OP_HOST_UI_PORT:-3880}` as the browser/install origin. Electron and `openpalm admin` preserve their internal `127.0.0.1` origin and never honor remote bind configuration. After completing initial setup locally, set `OP_ALLOW_REMOTE_SETUP=1` to bind a **non-admin** UI process to all interfaces for operator-managed HTTPS proxying. This relaxes the Host allowlist and permits same-origin remote requests, but first-run setup remains restricted to a loopback browser origin. Admin-capable processes remain loopback-only.

Key env (host process, not container):

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `OP_HOST_UI_PORT` or `3880` | Host UI HTTP listen port (admin capability is an Electron/CLI boundary, not a separate port) |
| `OP_HOME` | resolved from host env | OpenPalm home directory |
| `OP_UI_LOGIN_PASSWORD` | `$OP_HOME/knowledge/secrets/op_ui_login_password` | Operator admin password promoted into the host admin process environment |
| `OP_ALLOW_REMOTE_SETUP` | unset (`0`) | For non-admin UI processes only, `1`/`true`/`yes` binds `0.0.0.0` and allows any Host/same-origin after local setup. First-run setup still requires a loopback browser origin. Electron and `openpalm admin` ignore/neutralize it. |

---

## Addon Overlays Shipped In The Repo

| Addon | Host bind | Internal port | Network(s) | Notes |
|---|---|---:|---|---|
| `chat` | `${OP_CHAT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_CHAT_PORT:-3820}` | `8182` | `portal_net` | Guardian image OpenAI-compatible edge (chat profile alias) |
| `api` | `${OP_API_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_API_PORT:-3821}` | `8182` | `portal_net` | Guardian image OpenAI/Anthropic-compatible edge |
| `voice` | `${OP_VOICE_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_VOICE_PORT_HOST:-8880}` | `8880` | `portal_net` | Voice interface |
| `discord` | none | service-specific | `portal_net` | No host port exposure |
| `slack` | none | service-specific | `portal_net` | No host port exposure |
| `ollama` | none (internal only) | `11434` | `assistant_net` | Mounts `$OP_HOME/data/ollama:/home/ollama/.ollama`; no host port exposed |

Portal services use `user: "${OP_UID:-1000}:${OP_GID:-1000}"` where they write host mounts. The optional guardian-hosted OpenAI-compatible edge talks back to the main guardian over `/oc` using its own principal secret file.

---

## Docker Networks

| Network | Connected services | Purpose |
|---|---|---|
| `assistant_net` | `assistant` (also hosts the scheduler co-process), `guardian` | Core internal service mesh |
| `portal_net` | `guardian` and LAN-facing portal/addon edges | Default portal ingress network |
| `portal_public` | `guardian` only in core; public-facing overlays can join it intentionally | Public ingress isolation |

---

## Network access presets (#563)

The setup wizard's "Network access" step (and the equivalent `network` block
in a headless install spec) resolves to one of four presets via
`packages/lib/src/control-plane/network-preset.ts`. Every preset writes ALL
of the managed keys below explicitly (loopback rather than "leave unset"), so
switching between presets always converges:

| Preset | `OP_BIND_ADDRESS` | `OP_ASSISTANT_BIND_ADDRESS` | `OP_UI_BIND_ADDRESS` | `OP_VOICE_BIND_ADDRESS` | `OPENCODE_AUTH` | mDNS |
|---|---|---|---|---|---|---|
| This PC only | `127.0.0.1` | `127.0.0.1` | `127.0.0.1` | `127.0.0.1` | `false` | none |
| Home network, with password | `127.0.0.1` | `0.0.0.0` | `127.0.0.1` | `127.0.0.1` | `true` (+ `op_opencode_password` secret) | `<name>.local` |
| Home network, open access | `127.0.0.1` | `0.0.0.0` | `127.0.0.1` | `127.0.0.1` | `false` | `<name>.local` |
| Shared network, guardian protected | `0.0.0.0` | `127.0.0.1` | `127.0.0.1` | `127.0.0.1` | `false` | `<name>-guardian.local` |

Notes:

- `OP_CHAT_BIND_ADDRESS` / `OP_API_BIND_ADDRESS` are deliberately **not**
  managed by any preset — they are listeners inside the guardian container,
  fail-closed API-key-authenticated (`OPENAI_COMPAT_API_KEY_FILE`), so they
  ride the `OP_BIND_ADDRESS` cascade: under "Shared network, guardian
  protected" this gives OpenAI-compatible LAN clients a real, credentialed
  surface out of the box.
- `GUARDIAN_DIRECT_INGRESS` is never touched by any preset — the direct
  listener stays 404-closed until the operator opts in. Presets configure
  *exposure*, not *ingress enablement*.
- mDNS is delivered entirely by the host control-plane responder
  (`packages/lib/src/control-plane/mdns-responder.ts`, #488) — see
  `docs/technical/network-partitioning-d5a.md` for the preset → mDNS mapping
  and why the native in-container OpenCode `server.mdns` block stays a
  manual/advanced path.
- The admin Assistant tab (`GET/PUT /api/host/stack`) surfaces the detected
  preset read-only (`networkPreset`, `null` = custom/hand-tuned); switching
  presets happens in the wizard (rerun from the dashboard), not there.

---

## Core Stack Variables From `stack.env`

These variables are consumed by Compose and service env blocks.

| Variable | Purpose |
|---|---|
| `OP_HOME` | Host OpenPalm root used in bind mounts |
| `OP_UID`, `OP_GID` | Runtime UID/GID for bind-mounted file ownership |
| `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG` | Image selection |
| `OP_HOST_UI_PORT` | Host UI port for `openpalm app`/`admin` and Electron (default `3880`); the same `@openpalm/ui` build runs as a host process, not a container. Admin capability is an Electron/CLI boundary, not a separate port |
| `OP_ASSISTANT_BIND_ADDRESS`, `OP_ASSISTANT_PORT` | Assistant host bind |
| `OP_UI_BIND_ADDRESS`, `OP_UI_PORT` | Assistant `@openpalm/ui` co-process host bind (default `127.0.0.1:3800`) |
| `OP_UI_VERSION` | Exact-pin override for the `@openpalm/ui` artifact installed in the assistant container |
| `OP_SKELETON_VERSION` | Exact-pin override for the `@openpalm/skeleton` artifact installed in the assistant container (and used by the guardian thin-host entrypoint when set) |
| `OP_UI_DEFAULT_ASSISTANT_URL` | Full-URL override for the UI's locked default connection |
| `OP_UI_CORS_ALLOWED_ORIGINS` | Extra exact browser origins to allow when the assistant launches OpenCode |
| `OP_CHAT_BIND_ADDRESS`, `OP_CHAT_PORT` | Chat addon host bind |
| `OP_API_BIND_ADDRESS`, `OP_API_PORT` | API addon host bind |
| `OP_VOICE_BIND_ADDRESS`, `OP_VOICE_PORT` | Voice addon host bind |
| `OP_OWNER_NAME` | Operator display name |
| `OP_OWNER_EMAIL` | Operator email |
| `OP_MDNS` | (default unset = enabled-but-gated) `0`/`false`/`off`/`no` disables the host mDNS responder entirely — the escape hatch for coexisting with an already-configured host mDNS publisher (avahi/Bonjour). #488: `OP_BIND_ADDRESS`/`OP_ASSISTANT_BIND_ADDRESS` additionally gate host-side mDNS self-advertisement of `<name>-guardian.local` / `<name>.local` (`<name>` from `OP_PROJECT_NAME`) — non-loopback ⇒ advertised on `OP_GUARDIAN_PORT`/`OP_ASSISTANT_PORT`; the loopback default opens no socket. See `docs/technical/network-partitioning-d5a.md`. |

---

## User Secrets From `user.env`

This file is the AKM env backing file for user-managed secrets. It is not
passed to Docker Compose and is not mounted directly into containers.

Provider/model selections and other non-secret preferences live in `stack.env`
or `config/akm/config.json`. System-managed service secrets live as files under
`knowledge/secrets/` and are granted only to the service that needs them.
Secret-like container environment variables must use `*_FILE` paths.
