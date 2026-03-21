# Directory Structure & Volume Design

OpenPalm uses a single host root, `OP_HOME`, which defaults to `~/.openpalm`.
This document describes the current shipped layout and the bind mounts derived
from it.

---

## Home Layout

```text
~/.openpalm/
├── config/                   user-editable non-secret config
├── stack/                    live compose assembly and addon overlays
├── vault/                    secrets boundary
├── data/                     durable service-owned data
└── logs/                     audit and debug logs

~/.cache/openpalm/
└── rollback/                 rollback snapshots and other ephemeral cache
```

| Directory | Owner | Purpose |
|---|---|---|
| `config/` | User | Automations, assistant extensions, helper metadata |
| `stack/` | CLI/Admin + user inspection | Runtime compose files and addon overlays |
| `vault/user/` | User | User-managed secrets |
| `vault/stack/` | System | System-managed env, auth, and service env files |
| `data/` | Services | Durable service state |
| `logs/` | Services | Audit and debug output |

`config/` is the user-owned persistent source of truth for non-secret config.
Automatic lifecycle actions may seed missing defaults there, but do not overwrite
existing user files.

---

## Current Tree Used By The Shipped Stack

```text
~/.openpalm/
├── config/
│   ├── assistant/
│   ├── automations/
│   └── stack.yaml
├── stack/
│   ├── core.compose.yml
│   ├── start.sh
│   └── addons/
│       ├── admin/
│       ├── api/
│       ├── chat/
│       ├── discord/
│       ├── ollama/
│       ├── openviking/
│       ├── slack/
│       └── voice/
├── vault/
│   ├── stack/
│   │   ├── stack.env
│   │   ├── auth.json
│   │   └── services/
│   │       └── memory/
│   │           └── managed.env
│   └── user/
│       └── user.env
├── data/
│   ├── admin/
│   ├── assistant/
│   ├── guardian/
│   ├── memory/
│   ├── stash/
│   └── workspace/
└── logs/
    ├── admin-audit.jsonl
    ├── guardian-audit.log
    └── opencode/
```

---

## What Each Core Service Mounts

### Memory

- `$OP_HOME/data/memory -> /data`

### Assistant

- `$OP_HOME/config -> /etc/openpalm`
- `$OP_HOME/config/assistant -> /home/opencode/.config/opencode`
- `$OP_HOME/vault/stack/auth.json -> /home/opencode/.local/share/opencode/auth.json`
- `$OP_HOME/vault/user/user.env -> /etc/openpalm-vault/user.env:ro`
- `$OP_HOME/data/assistant -> /home/opencode`
- `$OP_HOME/data/stash -> /home/opencode/.akm`
- `$OP_HOME/data/workspace -> /work`
- `$OP_HOME/logs/opencode -> /home/opencode/.local/state/opencode`

### Guardian

- `$OP_HOME/data/guardian -> /app/data`
- `$OP_HOME/logs -> /app/audit`

### Scheduler

- `$OP_HOME/config -> /openpalm/config:ro`

### Admin addon

- `$OP_HOME -> /openpalm`
- `$OP_HOME/data/admin -> /home/node`
- `$OP_HOME/data/workspace -> /work`
- `${HOME}/.cache/openpalm/registry -> /cache/registry`
- `${GNUPGHOME:-${HOME}/.gnupg} -> /home/node/.gnupg:ro`

### Docker socket proxy addon

- `${OP_DOCKER_SOCK:-/var/run/docker.sock} -> /var/run/docker.sock:ro`

---

## Durable Data Policy

| Path | Used by | Notes |
|---|---|---|
| `data/admin/` | admin | Admin runtime home |
| `data/assistant/` | assistant | Assistant home and local runtime state |
| `data/guardian/` | guardian | Guardian nonce / rate-limit state |
| `data/memory/` | memory | SQLite, mem0 compatibility data, generated config |
| `data/stash/` | assistant | AKM stash |
| `data/workspace/` | assistant, admin | Shared working directory mounted at `/work` |

Do not treat `data/` as user configuration. It is durable, but service-owned.

---

## Logs And Cache

| Host path | Purpose |
|---|---|
| `logs/guardian-audit.log` | Guardian audit trail |
| `logs/admin-audit.jsonl` | Admin audit trail |
| `logs/opencode/` | Assistant OpenCode state and logs |
| `~/.cache/openpalm/rollback/` | Rollback snapshots |
| `~/.cache/openpalm/registry/` | Registry cache used by admin helpers |

---

## Docker Networks

| Network | Purpose |
|---|---|
| `assistant_net` | Core internal mesh for memory, assistant, guardian, scheduler, and admin |
| `channel_lan` | Default LAN-facing channel ingress network |
| `channel_public` | Public ingress isolation for intentionally exposed overlays |
| `admin_docker_net` | Isolated network between admin and docker-socket-proxy |

---

## Runtime Updates

To change the running stack:

1. Edit files under `config/`, `vault/`, or `stack/`.
2. Rerun Docker Compose with `stack/core.compose.yml` plus any addon overlays.
3. Or use `stack/start.sh` with the same addon selection.

The wrapper always includes:

- `vault/stack/stack.env`
- `vault/user/user.env`

The `memory` service may also load `vault/stack/services/memory/managed.env`.
