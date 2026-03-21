# Manual Setup

This is the plain Docker Compose path. No installer is required.

OpenPalm ships a working `.openpalm/` asset bundle in the repo. Copy that bundle to `~/.openpalm/`, fill in the env files, and start the stack with `docker compose`.

For the convenience-oriented version of the same flow, see [setup-guide.md](setup-guide.md).

---

## What is authoritative

- The live stack is defined only by compose files under `~/.openpalm/stack/`.
- Enabled addons come from the compose command you run, for example extra `-f addons/<name>/compose.yml` flags.
- `~/.openpalm/config/stack.yaml` is optional metadata for helper tooling. It is not deployment truth.
- `~/.openpalm/stack/start.sh` is a convenience wrapper around `docker compose`, not a separate control plane.

---

## Prerequisites

- Docker Engine or Docker Desktop with Compose V2
- `git` or another way to copy files from this repo
- `openssl` if you want to generate fresh secrets locally

---

## 1. Copy the bundle

Clone the repo, then copy `.openpalm/` into your home directory:

```bash
git clone https://github.com/itlackey/openpalm.git
cp -R openpalm/.openpalm "$HOME/.openpalm"
```

If you already have a `~/.openpalm/` with data you want to keep, do not delete it. Copy only the files you need from the repo bundle instead.

---

## 2. Review the layout

After copying, the important paths are:

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Base compose file, addon compose files, `start.sh` |
| `~/.openpalm/vault/stack/stack.env` | System values used by compose |
| `~/.openpalm/vault/user/user.env` | User secrets like provider API keys |
| `~/.openpalm/config/` | User-editable config and automations |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Logs and audit output |

---

## 3. Fill in env files

Edit the copied env files before first start.

### `~/.openpalm/vault/user/user.env`

Set at least one model provider key or endpoint your assistant can use.

Example:

```dotenv
OPENAI_API_KEY=your-key-here
```

### `~/.openpalm/vault/stack/stack.env`

Review host-specific values such as paths, ports, image tags, and tokens.

If you want a fresh admin token or signing secret, generate values locally and paste them into the file:

```bash
openssl rand -hex 24
```

---

## 4. Start the core stack

Run Docker Compose directly from `~/.openpalm/stack/`:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

That starts the foundation services only.

---

## 5. Add addons explicitly

Add an addon by including its compose file in the command.

Example: core + admin + chat

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

Common addon files:

| Addon | Compose file |
|---|---|
| `admin` | `addons/admin/compose.yml` |
| `chat` | `addons/chat/compose.yml` |
| `api` | `addons/api/compose.yml` |
| `discord` | `addons/discord/compose.yml` |
| `slack` | `addons/slack/compose.yml` |
| `voice` | `addons/voice/compose.yml` |
| `ollama` | `addons/ollama/compose.yml` |
| `openviking` | `addons/openviking/compose.yml` |

Each addon directory may also contain an `.env.schema` file that documents extra variables you need to set.

---

## 6. Optional convenience wrapper

If you do not want to type the full compose command each time, use the bundled wrapper:

```bash
cd "$HOME/.openpalm/stack"
./start.sh admin chat
./start.sh --status admin chat
./start.sh --stop admin chat
```

Use raw `docker compose` whenever you want the clearest possible source of truth.
For `status`, `stop`, and `down`, pass the same addon set you used for `up`.

---

## 7. Optional `config/stack.yaml`

`~/.openpalm/config/stack.yaml` can list preferred addons or other metadata for scripts and tooling.

Important: changing `stack.yaml` alone does not change the running stack unless the tool you use reads it and turns it into a compose command. Docker Compose still only sees the files you pass with `-f`.

---

## 8. Verify

Check container status:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  ps
```

If you started the `admin` addon, open `http://localhost:3880/`.

If you started the `chat` addon, follow its exposed URL or port from `docker compose ps`.

---

## Updating

To update the live definition, replace files in `~/.openpalm/stack/` with newer versions from the repo bundle, review env changes, then run the same compose command again.

Because the deployment truth is the compose file set itself, updates stay simple:

- refresh the copied bundle files you want
- keep your env files and data
- rerun `docker compose ... up -d`

---

## Troubleshooting

**Compose file works differently than expected**

Make sure you are passing every addon you intend to enable. If a file is not included with `-f`, it is not part of the deployment.

**`stack.yaml` changes did nothing**

That is expected unless you used a helper that reads `config/stack.yaml`. Docker Compose does not read it directly.

**An addon fails to start**

Check its `.env.schema` file and container logs:

```bash
docker compose logs <service-name>
```

**Need to stop everything**

Run the same file set with `down` instead of `up`:

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

---

## Further reading

- [setup-guide.md](setup-guide.md) - Convenience path and optional tooling
- [.openpalm/stack/README.md](../.openpalm/stack/README.md) - Compose file and addon reference
- [technical/core-principles.md](technical/core-principles.md) - Security and filesystem rules
- [managing-openpalm.md](managing-openpalm.md) - Day-to-day operations
