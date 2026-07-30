# How OpenPalm Works

OpenPalm is a host control plane around a Docker Compose stack.

The host CLI or optional host admin UI owns lifecycle operations. The stack's
only always-on core container is the assistant. Guardian and other services are
profile-gated addons.

## Big Picture

```text
Browser -> Assistant UI :3800 -> same-origin /oc proxy -> Assistant :4096

Discord / Slack / compatible API / direct client
                    |
                    v
            Guardian :8080 internal
              auth, ownership,
              limits, validation
                    |
                    v
             Assistant :4096

Host CLI / host admin UI -> Docker Compose + OP_HOME
```

Three invariants define the design:

1. Only a host process orchestrates Docker Compose.
2. Portal and direct-ingress traffic reaches the assistant through Guardian.
3. The assistant has no Docker socket, host admin credential, or admin network path.

## Host Control Plane

The `openpalm` CLI and the admin-capable UI process run on the host. They can
read `OP_HOME`, validate configuration, and invoke Docker Compose directly.

The host API is grouped under `/api/host/*`. Authentication lives under
`/api/auth/*`, and assistant-owned settings live under `/api/assistant/*`.
`/admin/*` is deliberately a dead namespace and returns `404`.

Guardian's `:3831/admin/principals` endpoint is unrelated to the UI route
namespace. It is a separate, loopback-only Guardian listener protected by its
own bearer-token file.

## Assistant

The assistant container runs:

- OpenCode on container port `4096` (host default `3810`)
- the image-baked OpenPalm UI on container port `3000` (host default `3800`)
- BusyBox `crond` for AKM task schedules
- `akm tasks sync` at startup and every 60 seconds

The UI reaches OpenCode through its own same-origin `/oc` proxy. The assistant
image also contains the default tool packages; startup does not download or
resolve a runtime UI tarball. The host materializes skeleton files from the
coordinated GitHub host-assets release.

With the `networkAccess` toggle on, this UI is reachable from another device at
`http://<name>.local:3800` or `http://<host-ip>:3800` — see
[Setup Guide → Reaching OpenPalm from Another Device](setup-guide.md#reaching-openpalm-from-another-device)
for the concrete URL and its caveats. Voice is not reachable through this
served copy: the entrypoint sets `OP_UI_NO_LOCAL_VOICE=1` because this
co-process only has a loopback path to its own container, never the sibling
voice container, so `/voice` `503`s here by design.

Managed OpenCode config comes from `system/assistant/` at `/etc/opencode`.
User OpenCode global config comes separately from `config/assistant/` at
`/home/opencode/.config/opencode`.

Persistent mounts include the assistant home, purgeable cache, AKM config and
data, the knowledge stash, and the shared workspace. The assistant can read
`knowledge/secrets/auth.json` for provider auth but has no tree mount of
`private/`; only the named UI/OpenCode server secret files needed by its server
processes are granted.

## Guardian

Guardian is deployed only when a Guardian-ingress profile is active, such as
`addon.chat`, `addon.api`, `addon.discord`, `addon.slack`, or `addon.gateway`.
It joins both `portal_net` and `assistant_net`; portals never join
`assistant_net` directly.

Guardian is a transparent native OpenCode proxy. For an authenticated `/oc/*`
request it:

1. Canonicalizes the path and rejects traversal.
2. Authenticates the principal with HTTP Basic credentials.
3. Enforces persisted session, permission, and question ownership.
4. Applies rate and resource limits.
5. Runs content validation for prompt-bearing traffic.
6. Proxies method, path, query, body, and streaming responses to OpenCode.

Content validation defaults **on in both code and shipped Compose**. A cheap
heuristic screen escalates suspicious content to Guardian's local OpenCode
moderator. If an escalated message cannot be classified, Guardian fails closed
and blocks it. An operator must explicitly set
`GUARDIAN_CONTENT_VALIDATION=0` to opt out.

Managed moderation instructions come from `system/guardian/` at
`/etc/opencode`; user model selection is separate in `config/guardian/`.
Guardian receives provider `auth.json` through a narrow Compose secret and does
not mount the full `knowledge/` tree.

## Portal and Service Addons

Discord and Slack adapters run from the unified `openpalm/portal` image. They
translate their native protocols into authenticated Guardian `/oc/*` calls.

The OpenAI/Anthropic-compatible edge runs inside Guardian and is published on
host port `3821` when configured. There is one compatible listener, not separate
chat and API ports.

Voice is a service addon rather than a portal. It is defined in
`system/stack/services.compose.yml`, joins `addon_net`, and publishes its API
only on `127.0.0.1:8880`. Its default speech models are baked into the image.

## Message Flow

```text
User message
  -> portal adapter or direct client
  -> Guardian principal authentication
  -> ownership and resource checks
  -> content validation (on by default, fail-closed on escalation failure)
  -> native OpenCode request to assistant:4096
  -> tools / AKM / model
  -> streamed response through Guardian to the caller
```

No request in this flow gives the assistant control-plane authority. Host stack
operations remain host CLI or admin UI actions.

## Filesystem Model

```text
~/.openpalm/
  system/stack/
    core.compose.yml
    services.compose.yml
    portals.compose.yml
  config/stack/custom.compose.yml
  state/stack.env
  private/secrets/
  knowledge/secrets/auth.json
  knowledge/env/user.env
```

The three managed Compose files are overwritten on lifecycle reconcile. The
single user overlay is seeded once. `state/stack.env` is the sole non-secret
Compose env file.

Delegated UI, Guardian, API, portal, bot, and OpenCode-server secrets live in
`private/secrets/`. Only provider `auth.json` remains under
`knowledge/secrets/`, where the assistant can use it.

Docker Compose performs normal `${VAR}` substitution from `state/stack.env`.
OpenPalm writes complete files; it does not leave templates for a custom
renderer.

## Addon Activation

OpenPalm records enabled first-party addon IDs in `OP_ENABLED_ADDONS` and turns
them into `--profile addon.<id>` arguments whenever its control plane invokes
Compose.

Raw Docker Compose knows nothing about `OP_ENABLED_ADDONS`. A manual invocation
must pass active profiles itself or set `COMPOSE_PROFILES` explicitly.

## Scheduling

AKM task files support `command`, `prompt`, and `workflow` targets. They execute
inside the assistant container under BusyBox cron. Because that environment has
no Docker socket or host CLI authority, host lifecycle schedules must use the
host OS scheduler and call the host `openpalm` binary.

## Default Ports

| Host port | Runtime |
|---|---|
| `3800` | Assistant-served OpenPalm UI |
| `3810` | Assistant OpenCode |
| `3821` | Guardian-hosted compatible API |
| `3830` | Guardian direct ingress |
| `3831` | Guardian principal admin, loopback-only |
| `3880` | Optional host UI/admin process |
| `8880` | Voice API, loopback-only |

All published listeners default to loopback. Setup uses independent access
booleans and flat per-service bind values; there is no global bind cascade.
