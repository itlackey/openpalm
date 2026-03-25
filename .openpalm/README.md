# ~/.openpalm

This bundle is the shipped OpenPalm home directory skeleton. Copy it to
`~/.openpalm/` (or another location via `OP_HOME`). The repo bundle is the
source asset set; the copied directory becomes the runtime home.

## Directory layout

```text
~/.openpalm/
  config/
    stack.yml          Capabilities only
    host.yaml          Optional host metadata written by setup tooling
    assistant/         OpenCode user tools, plugins, skills, commands
    automations/       Enabled automation definitions only

  registry/
    addons/            Shipped addon catalog
    automations/       Shipped automation catalog

  vault/
    stack/             System-managed env and auth files
      stack.env
      guardian.env
      auth.json
    user/              User-managed secrets and overrides

  data/
    admin/             Admin home
    assistant/         Assistant home
    guardian/          Guardian runtime state
    memory/            Memory database and related files
    stash/             AKM stash
    workspace/         Shared /work mount

  stack/
    core.compose.yml   Core services
    addons/            Enabled addon overlays only

  logs/
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
  --env-file ~/.openpalm/vault/stack/guardian.env \
  -f ~/.openpalm/stack/core.compose.yml \
  -f ~/.openpalm/stack/addons/chat/compose.yml \
  -f ~/.openpalm/stack/addons/admin/compose.yml \
  up -d
```

Before running that command, enable each addon you want by copying it from the
catalog into the runtime stack, for example:

```bash
cp -r ~/.openpalm/registry/addons/chat ~/.openpalm/stack/addons/chat
cp -r ~/.openpalm/registry/addons/admin ~/.openpalm/stack/addons/admin
```

See [Manual Compose Runbook](../docs/operations/manual-compose-runbook.md) for the full reference.

The live stack is defined by `stack/core.compose.yml` plus whichever enabled
addon compose files you include from `stack/addons/`. `config/stack.yml`
stores capabilities only; it does not replace Compose as the runtime source of
truth.

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
