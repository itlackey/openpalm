# ~/.openpalm

This bundle is the shipped OpenPalm home directory skeleton. Copy it to
`~/.openpalm/` (or another location via `OP_HOME`) and run the stack from the
files here.

## Directory layout

```text
~/.openpalm/
  config/             User-editable configuration (non-secret)
    stack.yaml          Optional addon/tooling metadata
    host.yaml           Optional host metadata written by setup tooling
    assistant/          OpenCode user tools, plugins, skills, commands
    automations/        Scheduler automation definitions

  vault/              Secrets boundary
    stack/              System-managed env and auth files
      stack.env
      auth.json
    user/               User-managed secrets (API keys, provider settings)

  data/               Durable service-managed data
    admin/              Admin home
    assistant/          Assistant home
    guardian/           Guardian runtime state
    memory/             Memory database and related files
    stash/              AKM stash
    workspace/          Shared /work mount

  stack/              Docker Compose runtime assets
    core.compose.yml    Core services
    addons/             Optional service overlays

  logs/               Audit and debug logs
    admin-audit.jsonl
    guardian-audit.log
    opencode/
```

## Quick start

Recommended install path:

```bash
openpalm install
```

Manual setup:

```bash
cp -r .openpalm/ ~/.openpalm/
$EDITOR ~/.openpalm/vault/stack/stack.env
$EDITOR ~/.openpalm/vault/user/user.env
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/vault/stack/stack.env \
  --env-file ~/.openpalm/vault/user/user.env \
  -f ~/.openpalm/stack/core.compose.yml \
  -f ~/.openpalm/stack/addons/chat/compose.yml \
  -f ~/.openpalm/stack/addons/admin/compose.yml \
  up -d
```

See [Manual Compose Runbook](../docs/operations/manual-compose-runbook.md) for the full reference.

The live stack is defined by `stack/core.compose.yml` plus whichever addon
compose files you include. `config/stack.yaml` is helper metadata for wrappers;
it does not replace Compose as the runtime source of truth.

## Ownership rules

| Directory | Owner | Who writes |
|---|---|---|
| `config/` | User | User edits, explicit admin actions, assistant via authenticated admin API |
| `vault/stack/` | System | CLI/admin |
| `vault/user/` | User | User edits and explicit admin UI/API secret updates |
| `data/` | Services | Containers at runtime |
| `stack/` | System-managed runtime assembly | CLI/admin lifecycle writes; user may inspect or edit |
| `logs/` | Services | Containers at runtime |

## Runtime notes

- Docker Compose global env files: `vault/stack/stack.env` and `vault/user/user.env`.
- The assistant workspace is `data/workspace/`, mounted at `/work`.
- The admin addon mounts the full OpenPalm home at `/openpalm` and reaches Docker only through `docker-socket-proxy`.
