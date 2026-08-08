# Foundations

> Authoritative document. Do not edit without a specific request or direct approval.

This is the compact 0.13.0 runtime contract. The full architectural rules live
in [`core-principles.md`](core-principles.md).

## Ownership Layout

All runtime state lives under `OP_HOME`, defaulting to `~/.openpalm`:

```text
~/.openpalm/
|-- config/       user-owned non-secret config and config/stack/custom.compose.yml
|-- system/       managed release assets and system/stack/*.compose.yml
|-- state/        app-written records, including the one state/stack.env
|-- knowledge/    AKM stash, env/user.env, tasks, and provider secrets/auth.json
|-- data/         durable service state, logs, backups, and rollback
|-- workspace/    shared assistant work area
|-- private/      delegated credentials, never part of assistant /stash
`-- cache/        regenerable container caches
```

Ownership is a security boundary, not just organization:

- Automatic lifecycle sync overwrites `system/`, writes `state/`, and preserves
  existing user files in `config/`, `knowledge/`, and `workspace/`.
- Managed Compose lives only in `system/stack/`. The only stack file under
  `config/` is `config/stack/custom.compose.yml`.
- `state/stack.env` is the single non-secret Compose env file.
- Lifecycle backups include `private/` and omit `data/` and regenerable
  `cache/`. Purge removes every tree. Ownership repair includes durable and
  private state but excludes regenerable caches.

## Credential Boundary

- `knowledge/secrets/auth.json` is the provider credential store used by
  OpenCode. It stays in the assistant-readable knowledge tree.
- `private/secrets/` holds delegated UI, OpenCode server, Guardian, API, portal,
  Discord, and Slack credentials. It is never bind-mounted into `/stash`.
- Compose grants delegated credentials as individual files under
  `/run/secrets/` only to the services that need them.
- The digest-pinned Paperclip image cannot consume file-based auth, so its two
  required server secrets use the sole audited exception:
  `private/env/paperclip.env`, with an exact key set and strict file modes.
- `knowledge/env/user.env` backs AKM `env/user`. It is neither a Compose env file
  nor sourced by the assistant entrypoint. Scoped tools load it on demand.
- No service receives a broad secret env file; Paperclip's narrow exact-key file
  is the only exception. `state/stack.env` must remain non-secret.

## Security Boundaries

- The host CLI and admin-capable host UI are the only Docker Compose
  orchestrators. They use the host Docker socket directly.
- There is no admin container and no Docker socket or socket proxy mounted into
  any container.
- The assistant has bounded mounts, no admin credential, and no network path to
  the loopback-only admin process. It cannot perform stack operations.
- Portal traffic reaches the assistant only through Guardian.
- All host publications default to loopback. Broader access requires explicit
  flat setup toggles.

## Access Model

Setup schema version 2 has an optional flat `access` object:

- `networkAccess`
- `assistantDirect`
- `guardianNetwork`
- `guardianOpenaiApi`

The toggles generate explicit service-specific bind/auth values; no listener
inherits from a global bind. Configurable bind names are `OP_UI_BIND_ADDRESS`,
`OP_ASSISTANT_BIND_ADDRESS`, `OP_GUARDIAN_BIND_ADDRESS`, and
`OP_API_BIND_ADDRESS`. Voice is fixed to loopback.

## Networks

| Network | Members | Purpose |
|---|---|---|
| `assistant_net` | Assistant, Guardian, Ollama variants | Protected assistant/provider path |
| `portal_net` | Guardian and portal adapters | External protocol ingress |
| `addon_net` | Voice and addons that need no assistant access | Segmented addon traffic |

Guardian is the only service on both the assistant and portal networks.

## Assistant

The assistant is the one always-on core container. It provides:

- OpenCode on container port `4096`
- the image-baked non-admin `@openpalm/ui` on container port `3000`
- AKM memory, skills, lessons, and knowledge through `/stash`
- scheduled automation through BusyBox `crond` and `akm task sync`

Principal mounts:

- `$OP_HOME/system/assistant -> /etc/opencode`
- `$OP_HOME/config/assistant -> /home/opencode/.config/opencode`
- `$OP_HOME/data/assistant -> /home/opencode`
- `$OP_HOME/cache/assistant -> /home/opencode/.cache`
- `$OP_HOME/knowledge/secrets/auth.json -> /home/opencode/.local/share/opencode/auth.json`
- `$OP_HOME/knowledge -> /stash`
- `$OP_HOME/config/akm -> /etc/akm`
- `$OP_HOME/data/akm/cache -> /opt/akm/cache`
- `$OP_HOME/data/akm/data -> /opt/akm/data`
- `$OP_HOME/workspace -> /work`
- `assistant-persistent -> /opt/persistent`

Default host publications:

- UI: `${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800} -> 3000`
- OpenCode: `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810} -> 4096`

The local browser connection uses the UI's authenticated same-origin `/oc`
pass-through. Remote user-added OpenCode/Guardian connections may still be
browser-direct.

## Guardian

Guardian is profile-gated in `portals.compose.yml`, not a core container. When
deployed it is a transparent native OpenCode reverse proxy with policy overlays:

- HTTP Basic principal authentication
- persisted session and permission ownership
- rate limiting and resource limits
- tenant-filtered events
- content validation before prompt-bearing writes are forwarded

Guardian mounts its own data, cache, logs, managed config, and user model config.
It mounts no `knowledge/` tree. Provider `auth.json` arrives as one Compose
secret and is copied into Guardian's home at boot; delegated credentials arrive
from `private/secrets/` as narrow Compose grants.

Guardian listeners:

| Listener | Port | Host publication |
|---|---:|---|
| Internal `/oc` gateway | `8080` | None |
| Direct `/oc` ingress | `3830` | `127.0.0.1:3830` by default |
| Principal admin API | `3831` | Always loopback |
| OpenAI/Anthropic-compatible API | `8182` | `127.0.0.1:3821` by default |
| OpenCode moderator | `4097` | Container loopback only |

There is one compatible API listener, not separate chat and API listeners.

### Content Validation

`GUARDIAN_CONTENT_VALIDATION` is on in both the package fallback and shipped
Compose. Only explicit `0`, `false`, `no`, or `off` values disable it.

The deterministic screen permits below-threshold traffic without a model and
escalates suspicious input to the local moderator. An escalated request is
blocked if the moderator times out, fails, returns malformed output, or cannot
produce an allow/flag/block verdict.

## Scheduler

The assistant entrypoint starts BusyBox `crond`, runs `akm task sync` at boot,
and repeats the sync every 60 seconds. Task files live in
`knowledge/tasks/*.yml`; supported targets are `command`, `prompt`, and
`workflow`.

It has no separate service, network port, Docker socket, admin token, or admin
API role. Cron gets only a managed allowlist of AKM/OpenCode environment values.

## Admin Host Process

The same `@openpalm/ui` adapter-node build runs under Electron, `openpalm app`,
or `openpalm admin`. Admin capability exists only in Electron and
`openpalm admin`; those host processes read `OP_HOME` and invoke Docker Compose
through the host socket. Containers receive no corresponding path or
credential.

The host UI defaults to `127.0.0.1:3880`. Package UI development defaults to
`5173`; the root isolated non-admin UI/API script sets `3880` explicitly.
