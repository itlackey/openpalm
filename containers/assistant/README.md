# OpenPalm Assistant Container

The assistant image is OpenPalm's only always-on core container. It runs
OpenCode, the non-admin OpenPalm UI, and BusyBox cron for AKM tasks.

It has no Docker socket, host admin credential, or network path to the host
admin process. It cannot run stack lifecycle operations.

## Runtime Processes

- OpenCode on container port `4096`
- Image-baked `@openpalm/ui` on container port `3000`
- BusyBox `crond`
- `akm tasks sync` at boot and every 60 seconds

The UI reaches OpenCode through its same-origin `/oc` proxy. The default host
publications are `127.0.0.1:3810` for OpenCode and `127.0.0.1:3800` for the UI.

## Image-Baked Assets

Release builds contain exact candidate copies of:

- the OpenCode and AKM tool tree
- compiled `@openpalm/ui`

The Dockerfile packs the local UI candidate during the image build. The
entrypoint does not install or update it from npm. Updating the UI requires a
new assistant image.

OpenCode may resolve explicitly configured plugins according to its own plugin
behavior; their cache is on the assistant cache bind.

## Mounts

The managed Compose definition is
`packages/skeleton/system/stack/core.compose.yml`.

| Host source | Container path | Purpose |
|---|---|---|
| `${OP_HOME}/data/assistant` | `/home/opencode` | Durable assistant home and OpenCode state |
| `${OP_HOME}/cache/assistant` | `/home/opencode/.cache` | Regenerable package/OpenCode cache |
| `${OP_HOME}/system/assistant` | `/etc/opencode` | Managed OpenCode config (`OPENCODE_CONFIG_DIR`) |
| `${OP_HOME}/config/assistant` | `/home/opencode/.config/opencode` | User OpenCode global config |
| `${OP_HOME}/config/akm` | `/etc/akm` | AKM config |
| `${OP_HOME}/knowledge` | `/stash` | AKM knowledge, tasks, skills, and user env |
| `${OP_HOME}/knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | OpenCode provider auth |
| `${OP_HOME}/data/akm/cache` | `/opt/akm/cache` | AKM cache and task logs |
| `${OP_HOME}/data/akm/data` | `/opt/akm/data` | AKM databases |
| `${OP_HOME}/workspace` | `/work` | Shared workspace |
| Host AKM stash or empty fallback | `/host-stash` | Optional secondary AKM source |
| `assistant-persistent` volume | `/opt/persistent` | Persistent prefix-style installs |

Managed config and user config are separate. Update may replace
`system/assistant/`; it preserves existing `config/assistant/` files.

## Secret Boundary

The assistant-readable provider file is
`knowledge/secrets/auth.json`. Delegated UI, Guardian, API, portal, bot, and
OpenCode-server credentials live under host `private/secrets/` and are not
mounted as a tree.

The assistant service receives only the specific UI/OpenCode server secret
files needed by its server processes through Compose `secrets:`. Those paths
are passed to the relevant child process; the assistant does not receive host
control-plane credentials.

`knowledge/env/user.env` is not sourced by the entrypoint. A tool that needs a
user-env value resolves `akm env:user` and loads it in that tool subprocess only.
The OpenCode server and unrelated tools do not inherit the whole file.

## Automations

AKM task files live at `/stash/tasks/*.yml`. Supported targets are `command`,
`prompt`, and `workflow`.

Task commands run inside this container. Host lifecycle commands such as
`openpalm update`, `openpalm status`, and `openpalm validate` cannot run here.
Schedule those with host cron or the host operating system's task scheduler.

## User Configuration

Durable user changes belong under host `config/assistant/`:

```text
opencode.json
persona.md
user-profile.md
tools/
plugins/
skills/
```

Managed instructions, permissions, themes, and plugin configuration come from
`system/assistant/` at `/etc/opencode`.

## Persistent Tools

Install user tools under `$HOME/.local` or `$HOME/.bun`; both survive
recreation. Use `/opt/persistent` for a non-home prefix. Distro packages in the
container writable layer do not survive recreation; build a derived image for
those.

See
[Persisting Assistant-Installed Tools](../../docs/operations/persistent-assistant-tools.md).

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `OPENCODE_CONFIG_DIR` | Managed config path, `/etc/opencode` |
| `OPENCODE_PORT` | OpenCode container port, normally `4096` |
| `OPENCODE_AUTH` | Generated from direct-assistant access; off when the API remains loopback-only |
| `OPENCODE_SERVER_PASSWORD_FILE` | Narrow Compose secret path used when OpenCode auth is enabled |
| `OP_UI_LOGIN_PASSWORD_FILE` | Narrow secret path for UI login |
| `AKM_STASH_DIR` | `/stash` |
| `AKM_CONFIG_DIR` | `/etc/akm` |
| `AKM_CACHE_DIR` | `/opt/akm/cache` |
| `AKM_DATA_DIR` | `/opt/akm/data` |

Host bind policy is controlled by flat service-specific values in
`state/stack.env`; there is no global bind cascade or SSH listener.
