# @openpalm/skeleton

This package contains release-shipped seed and managed assets. It is an input to
the OpenPalm installer, not a complete runtime home.

Do not copy this directory to `~/.openpalm/` and expect a working installation.
Install/setup also generates app state, delegated private secrets, cache paths,
host records, UI/runtime files, permissions, and other required directories.

## Install

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

For unattended generation:

```bash
openpalm install --file ./setup-spec.yaml
```

See [Installation](../../docs/installation.md) and
[Manual and Headless Install](../../docs/operations/manual-headless-install.md).

## Package Assets

```text
packages/skeleton/
  config/
    assistant/              user-config defaults, seeded if missing
    guardian/               user Guardian model config, seeded if missing
    akm/                    user AKM config seed
    stack/custom.compose.yml
  system/
    assistant/              managed assistant OpenCode config
    guardian/               managed Guardian OpenCode config
    stack/
      core.compose.yml
      services.compose.yml
      portals.compose.yml
      voice.compose.cdi.yml
      voice.compose.rootless.yml
  knowledge/                shipped AKM skills and task examples
  data/                     empty durable-directory seeds
  openpalm.sh               example Bash Compose helper
  openpalm.ps1              example PowerShell Compose helper
```

The installer copies managed assets into `system/`, seeds missing user assets
under `config/`, and creates everything not represented by this package.

Product releases package this workspace into the GitHub host-assets archive.
The host control plane verifies and materializes it; service images do not carry
or fetch a second skeleton copy.

## Generated Runtime Layout

After installation, `OP_HOME` (default `~/.openpalm/`) includes:

```text
config/                         user-owned non-secret config
  stack/custom.compose.yml      only user Compose overlay
system/                         managed release assets
  stack/{core,services,portals}.compose.yml
  assistant/                    managed config -> /etc/opencode
  guardian/                     managed config -> /etc/opencode
state/stack.env                 sole non-secret Compose env file
private/secrets/                delegated runtime credentials
knowledge/
  secrets/auth.json             assistant-readable provider auth
  env/user.env                  AKM env loaded on demand
  tasks/                        AKM YAML tasks
data/                           durable service data and backups
cache/                          regenerable assistant/Guardian caches
workspace/                      assistant /work mount
```

## Ownership

| Tree | Owner | Lifecycle behavior |
|---|---|---|
| `config/` | User | Existing files are preserved; defaults are seeded if missing |
| `system/` | OpenPalm release | Refreshed on reconcile/update |
| `state/` | OpenPalm app | Updated as runtime records change |
| `private/` | OpenPalm app | Delegated secrets, never mounted as a tree into the assistant |
| `knowledge/` | User/services | AKM stash, provider auth, tasks, and user env |
| `data/` | Services | Durable runtime state |
| `cache/` | Services | Regenerable and excluded from lifecycle backups |
| `workspace/` | User/assistant | Shared work area |

## Compose Contract

The fixed Compose assembly is:

```text
system/stack/core.compose.yml
system/stack/services.compose.yml
system/stack/portals.compose.yml
config/stack/custom.compose.yml
```

`state/stack.env` is the only `--env-file`. OpenPalm converts
`OP_ENABLED_ADDONS` to profiles; raw Docker Compose requires explicit
`--profile addon.<id>` arguments or `COMPOSE_PROFILES`.

Voice bring-up may append the managed `voice.compose.cdi.yml` overlay when CDI
is required, the managed `voice.compose.rootless.yml` overlay for rootless
Docker, or both. They are conditional additions to the fixed assembly, not user
overlays.

See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md).
