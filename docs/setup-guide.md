# Setup Guide

OpenPalm now uses a manual-first setup model:

- copy the repo's `.openpalm/` bundle to `~/.openpalm/`
- edit the env files you need
- run `docker compose` against files in `~/.openpalm/stack/`

Helper scripts still exist, but they are optional.

For the fully explicit path, see [manual-setup.md](manual-setup.md).

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
cd "$HOME/.openpalm/stack"

# Preflight: validate compose merge and variable substitution before starting
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  config --quiet

# Start the stack
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

That starts the base stack plus `admin` and `chat` after you review the copied env files.

To choose a different stack, change the addon `-f` flags. The running deployment is always the exact compose file list you pass to Docker Compose.

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

### `stack/start.sh` (convenience alternative)

The copied bundle includes `~/.openpalm/stack/start.sh`, a thin wrapper that
prints the resolved `docker compose` command before running it.

Examples:

```bash
cd "$HOME/.openpalm/stack"
./start.sh
./start.sh admin chat
./start.sh --status admin chat
./start.sh --stop admin chat
```

Prefer raw `docker compose` when documenting or debugging the live stack. For
`status`, `stop`, and `down`, pass the same addon set you used for `up`.

### Setup scripts

Repo setup scripts can still help bootstrap files on a fresh machine, but they should be understood as convenience tooling that prepares the same `~/.openpalm/` layout. They do not replace the compose-first model.

If you use helper tooling that reads `config/stack.yaml`, treat that file as input to the tool - not as the thing Docker Compose deploys.

---

## Common tasks

**Start a different addon set**

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/discord/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

**Check status**

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  ps
```

**Stop the stack**

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  down
```

**Update images**

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  pull

docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

**Change model keys**

Edit `~/.openpalm/vault/user/user.env`, then restart any service that needs the new values.

---

## After setup

The copied bundle gives you a predictable host layout:

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Compose files and helper wrapper |
| `~/.openpalm/vault/stack/stack.env` | Stack-level env values |
| `~/.openpalm/vault/user/user.env` | User secrets |
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

Review its `.env.schema` file under `~/.openpalm/stack/addons/<name>/` and then inspect logs:

```bash
docker compose logs <service-name>
```

### Start over

Stop the stack, remove `~/.openpalm/` if you truly want a clean reset, then copy the bundle again and rerun your compose command.

---

## Next steps

| Guide | What's inside |
|---|---|
| [manual-setup.md](manual-setup.md) | Fully explicit compose workflow |
| [managing-openpalm.md](managing-openpalm.md) | Day-to-day operations |
| [how-it-works.md](how-it-works.md) | Architecture overview |
| [technical/directory-structure.md](technical/directory-structure.md) | Host paths and mounts |
| [technical/core-principles.md](technical/core-principles.md) | Security and architecture rules |
