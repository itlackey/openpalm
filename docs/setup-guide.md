# Setup Guide

OpenPalm now uses a manual-first setup model:

- copy the repo's `.openpalm/` bundle to `~/.openpalm/`
- edit the env files you need
- run `docker compose` against files in `~/.openpalm/stack/`

Helper scripts still exist, but they are optional.

For the fully explicit path, see [technical/manual-setup.md](technical/manual-setup.md).

---

## Prerequisites

You need Docker with Compose V2.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop or OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com | sh` |

---

## Recommended path

The clearest setup is:

```bash
git clone https://github.com/itlackey/openpalm.git
cp -R openpalm/.openpalm "$HOME/.openpalm"
$EDITOR "$HOME/.openpalm/vault/stack/stack.env"
$EDITOR "$HOME/.openpalm/vault/user/user.env"
```

Then start the stack using the compose commands in the [Manual Compose Runbook](operations/manual-compose-runbook.md). That starts the base stack plus any addons you choose after you review the copied env files.

The running deployment is always the exact compose file list you pass to Docker Compose.

---

## Deployment truth

- `~/.openpalm/stack/` is the only deployment foundation.
- Base services come from `~/.openpalm/stack/core.compose.yml`.
- Addons come from `~/.openpalm/stack/addons/<name>/compose.yml`.
- `~/.openpalm/config/stack.yaml` is optional metadata for tools or wrappers. It is not deployment truth.

This keeps the live system understandable: if a compose file is not in the command, it is not part of the stack.

---

## Convenience options

The primary workflow is always raw `docker compose` as shown above. The options
below are typing shortcuts only.

For the full compose command reference including convenience shortcuts, see the
[Manual Compose Runbook](operations/manual-compose-runbook.md).

### Setup scripts

Repo setup scripts can still help bootstrap files on a fresh machine, but they should be understood as convenience tooling that prepares the same `~/.openpalm/` layout. They do not replace the compose-first model.

If you use helper tooling that reads `config/stack.yaml`, treat that file as input to the tool - not as the thing Docker Compose deploys.

---

## Common tasks

For all common compose operations (start, stop, status, pull, logs, restart), see the [Manual Compose Runbook](operations/manual-compose-runbook.md).

**Change model keys**

Edit `~/.openpalm/vault/stack/stack.env`, then recreate services that need the new values.

---

## After setup

The copied bundle gives you a predictable host layout:

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Compose files |
| `~/.openpalm/vault/stack/stack.env` | Stack-level env values |
| `~/.openpalm/vault/user/user.env` | Optional user extensions |
| `~/.openpalm/config/` | User-managed config |
| `~/.openpalm/data/` | Persistent container data |
| `~/.openpalm/logs/` | Logs |

If you include the `admin` addon, the UI is available on its configured host port from `stack.env`.

---

## Troubleshooting

### Docker not found

Verify Docker is installed and running:

```bash
docker info
```

### Wrong services started

Re-check the exact compose file list in your command. Docker Compose only deploys the files you pass.

### `config/stack.yaml` had no effect

That file is optional metadata. It only matters when a helper tool reads it.

### An addon fails to start

Review its `.env.schema` file under `~/.openpalm/stack/addons/<name>/` and then inspect logs (see [Manual Compose Runbook](operations/manual-compose-runbook.md) for log commands).

### Start over

Stop the stack, remove `~/.openpalm/` if you truly want a clean reset, then copy the bundle again and rerun your compose command.

---

## Next steps

| Guide | What's inside |
|---|---|
| [technical/manual-setup.md](technical/manual-setup.md) | Fully explicit compose workflow |
| [managing-openpalm.md](managing-openpalm.md) | Day-to-day operations |
| [how-it-works.md](how-it-works.md) | Architecture overview |
| [technical/directory-structure.md](technical/directory-structure.md) | Host paths and mounts |
| [technical/authoritative/core-principles.md](technical/authoritative/core-principles.md) | Security and architecture rules |
