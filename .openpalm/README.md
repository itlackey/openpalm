# ~/.openpalm

This bundle is the shipped OpenPalm home directory skeleton. Copy it to
`~/.openpalm/` (or another location via `OP_HOME`). The repo bundle is the
source asset set; the copied directory becomes the runtime home.

## Directory layout

```text
~/.openpalm/
  config/
    stack/             Stack configuration and composition
      stack.yml        Capabilities only
      stack.env        System-managed env vars (written by CLI/admin)
      guardian.env     Channel HMAC secrets (written by CLI/admin)
      core.compose.yml Core services (always used)
      addons/          Enabled addon overlays only
    host.yaml          Optional host metadata written by setup tooling
    assistant/         OpenCode user tools, plugins, skills, commands
    automations/       Enabled automation definitions only
    akm/               AKM config directory

  registry/
    addons/            Shipped addon catalog
    automations/       Shipped automation catalog

  vault/
    user/              User-managed secrets and overrides

  data/
    admin/             Admin home
    assistant/         Assistant home
    guardian/          Guardian runtime state
    akm/               AKM operational data
    stash/             AKM stash
    workspace/         Shared /work mount
    logs/              Audit and debug logs

  cache/
    akm/               AKM cache (regenerable)
    guardian/          Guardian cache
    rollback/          Rollback snapshots
```

## Quick start

Recommended install path:

```bash
openpalm install
```

Manual setup:

```bash
cp -r .openpalm/ ~/.openpalm/
$EDITOR ~/.openpalm/config/stack/stack.env
$EDITOR ~/.openpalm/vault/user/user.env
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/config/stack/stack.env \
  --env-file ~/.openpalm/vault/user/user.env \
  --env-file ~/.openpalm/config/stack/guardian.env \
  -f ~/.openpalm/config/stack/core.compose.yml \
  -f ~/.openpalm/config/stack/addons/chat/compose.yml \
  -f ~/.openpalm/config/stack/addons/admin/compose.yml \
  up -d
```

Before running that command, enable each addon you want by copying it from the
catalog into the runtime stack, for example:

```bash
cp -r ~/.openpalm/registry/addons/chat ~/.openpalm/config/stack/addons/chat
cp -r ~/.openpalm/registry/addons/admin ~/.openpalm/config/stack/addons/admin
```

See [Manual Compose Runbook](../docs/operations/manual-compose-runbook.md) for the full reference.

The live stack is defined by `config/stack/core.compose.yml` plus whichever enabled
addon compose files you include from `config/stack/addons/`. `config/stack/stack.yml`
stores capabilities only; it does not replace Compose as the runtime source of
truth.

## Ownership rules

| Directory | Owner | Who writes |
|---|---|---|
| `config/` | User | User edits, explicit admin actions, assistant via authenticated admin API |
| `config/stack/` | System | CLI/admin (stack.env, guardian.env, core.compose.yml, addons/) |
| `vault/user/` | User | User edits and explicit admin UI/API secret updates |
| `data/` | Services | Containers at runtime |
| `cache/` | System | Regenerable artifacts (AKM cache, rollback snapshots) |
| `logs/` | Services | Containers at runtime |

## Runtime notes

- Docker Compose global env files: `config/stack/stack.env` (system-managed) and `vault/user/user.env` (user-managed).
- Guardian loads channel HMAC secrets from `config/stack/guardian.env` with hot-reload support (via `GUARDIAN_SECRETS_PATH`).
- The assistant workspace is `data/workspace/`, mounted at `/work`.
- The CLI always runs from the host and manages Docker Compose directly. Admin UI is a host process started by `openpalm admin serve` — no container is needed.
