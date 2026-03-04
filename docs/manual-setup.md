# Manual Setup

Step-by-step guide for configuring an OpenPalm host by hand, without using the installer scripts or CLI. This is useful for understanding what the automation does under the hood, for air-gapped environments, or for custom deployments.

For the automated path, see [setup-guide.md](setup-guide.md). For the developer quick-start, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Prerequisites

- Docker Engine 24+ with Compose V2 (`docker compose` subcommand)
- `openssl` (for generating secrets)
- The `core/assets/` files from this repository (or download them from a GitHub release)

---

## 1. Choose your paths

OpenPalm uses three host directories following the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/). Pick paths that work for your system:

| Tier | Default | Purpose |
|------|---------|---------|
| **CONFIG_HOME** | `~/.config/openpalm` | User-editable: secrets, channels, OpenCode extensions |
| **DATA_HOME** | `~/.local/share/openpalm` | Opaque service data (openmemory, assistant, etc.) |
| **STATE_HOME** | `~/.local/state/openpalm` | Assembled runtime artifacts, audit logs |
| **WORK_DIR** | `~/openpalm` | Assistant working directory |

The rest of this guide uses the defaults. Substitute your own paths if needed.

See [directory-structure.md](directory-structure.md) for the full tree and rationale.

---

## 2. Create the directory tree

```bash
# CONFIG_HOME
mkdir -p ~/.config/openpalm/channels
mkdir -p ~/.config/openpalm/automations
mkdir -p ~/.config/openpalm/opencode/{tools,plugins,skills}

# DATA_HOME
mkdir -p ~/.local/share/openpalm/openmemory
mkdir -p ~/.local/share/openpalm/assistant
mkdir -p ~/.local/share/openpalm/guardian
mkdir -p ~/.local/share/openpalm/caddy/{data,config}
mkdir -p ~/.local/share/openpalm/automations

# STATE_HOME
mkdir -p ~/.local/state/openpalm/artifacts/channels
mkdir -p ~/.local/state/openpalm/automations
mkdir -p ~/.local/state/openpalm/audit

# Working directory
mkdir -p ~/openpalm
```

---

## 3. Place the core assets

Two files from `core/assets/` are needed: the Docker Compose definition and the Caddyfile.

Copy them to DATA_HOME (source of truth) **and** stage them to STATE_HOME (runtime):

```bash
# Source of truth (DATA_HOME)
cp core/assets/docker-compose.yml ~/.local/share/openpalm/docker-compose.yml
cp core/assets/Caddyfile           ~/.local/share/openpalm/caddy/Caddyfile

# Staged for runtime (STATE_HOME)
cp core/assets/docker-compose.yml ~/.local/state/openpalm/artifacts/docker-compose.yml
cp core/assets/Caddyfile           ~/.local/state/openpalm/artifacts/Caddyfile
```

If you don't have a local clone, download them from GitHub:

```bash
BASE_URL="https://raw.githubusercontent.com/itlackey/openpalm/main/core/assets"
curl -fsSL "$BASE_URL/docker-compose.yml" -o ~/.local/share/openpalm/docker-compose.yml
curl -fsSL "$BASE_URL/Caddyfile"           -o ~/.local/share/openpalm/caddy/Caddyfile

cp ~/.local/share/openpalm/docker-compose.yml ~/.local/state/openpalm/artifacts/docker-compose.yml
cp ~/.local/share/openpalm/caddy/Caddyfile    ~/.local/state/openpalm/artifacts/Caddyfile
```

---

## 4. Create secrets.env

This file holds your admin token and LLM provider keys. Copy the template from `core/assets/secrets.env` and fill in the values:

```bash
cp core/assets/secrets.env ~/.config/openpalm/secrets.env
```

Or create it manually:

```bash
cat > ~/.config/openpalm/secrets.env << 'EOF'
# Required — change this before exposing the stack
ADMIN_TOKEN=change-me-to-a-strong-token

# At least one LLM key recommended
OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=

OPENMEMORY_USER_ID=default_user
EOF
```

Set `ADMIN_TOKEN` to a strong random value:

```bash
# Generate a token and write it in place
TOKEN=$(openssl rand -hex 24)
sed -i "s/ADMIN_TOKEN=.*/ADMIN_TOKEN=$TOKEN/" ~/.config/openpalm/secrets.env
echo "Your admin token: $TOKEN"
```

Stage it to STATE_HOME for compose:

```bash
cp ~/.config/openpalm/secrets.env ~/.local/state/openpalm/artifacts/secrets.env
```

---

## 5. Create stack.env

`stack.env` holds system-managed infrastructure config. The admin regenerates this on every apply, but it must exist before the first start.

```bash
cat > ~/.local/share/openpalm/stack.env << EOF
# OpenPalm Stack Configuration — system-managed
# Overwritten by admin on each apply.

# ── XDG Paths ──────────────────────────────────────────────────────
OPENPALM_CONFIG_HOME=$HOME/.config/openpalm
OPENPALM_DATA_HOME=$HOME/.local/share/openpalm
OPENPALM_STATE_HOME=$HOME/.local/state/openpalm
OPENPALM_WORK_DIR=$HOME/openpalm

# ── User/Group ──────────────────────────────────────────────────────
OPENPALM_UID=$(id -u)
OPENPALM_GID=$(id -g)

# ── Docker Socket ───────────────────────────────────────────────────
OPENPALM_DOCKER_SOCK=/var/run/docker.sock

# ── Images ──────────────────────────────────────────────────────────
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=latest

# ── Networking ──────────────────────────────────────────────────────
OPENPALM_INGRESS_BIND_ADDRESS=127.0.0.1
OPENPALM_INGRESS_PORT=8080

# ── OpenMemory ──────────────────────────────────────────────────────
OPENMEMORY_DASHBOARD_API_URL=http://localhost:8765
OPENMEMORY_USER_ID=default_user

EOF
```

**Docker socket detection:** If you use OrbStack, Colima, or Rancher Desktop, the socket may not be at `/var/run/docker.sock`. Detect it with:

```bash
docker context inspect --format '{{.Endpoints.docker.Host}}'
# Example output: unix:///Users/you/.colima/default/docker.sock
```

Set `OPENPALM_DOCKER_SOCK` to the path after `unix://`.

Stage it to STATE_HOME:

```bash
cp ~/.local/share/openpalm/stack.env ~/.local/state/openpalm/artifacts/stack.env
```

---

## 6. Seed OpenMemory config (optional)

OpenMemory needs a default config file if you want memory features:

```bash
cat > ~/.local/share/openpalm/openmemory/default_config.json << 'EOF'
{
  "mem0": {
    "llm": {
      "provider": "openai",
      "config": {
        "model": "gpt-4o-mini",
        "temperature": 0.1,
        "max_tokens": 2000,
        "api_key": "env:OPENAI_API_KEY"
      }
    },
    "embedder": {
      "provider": "openai",
      "config": {
        "model": "text-embedding-3-small",
        "api_key": "env:OPENAI_API_KEY"
      }
    },
    "vector_store": {
      "provider": "qdrant",
      "config": {
        "collection_name": "openmemory",
        "path": "/data/qdrant",
        "embedding_model_dims": 1536
      }
    }
  },
  "openmemory": {
    "custom_instructions": ""
  }
}
EOF
```

You also need the patched `memory.py` that enables embedded Qdrant support:

```bash
cp core/assets/openmemory-memory.py ~/.local/share/openpalm/openmemory/memory.py
```

If you don't have a local clone, download it:

```bash
curl -fsSL "https://raw.githubusercontent.com/itlackey/openpalm/main/core/assets/openmemory-memory.py" \
  -o ~/.local/share/openpalm/openmemory/memory.py
```

---

## 7. Set file ownership

Ensure your user owns everything:

```bash
chown -R "$(id -u):$(id -g)" \
  ~/.config/openpalm \
  ~/.local/share/openpalm \
  ~/.local/state/openpalm \
  ~/openpalm
```

---

## 8. Start the stack

```bash
docker compose \
  -f ~/.local/state/openpalm/artifacts/docker-compose.yml \
  --env-file ~/.local/state/openpalm/artifacts/stack.env \
  --env-file ~/.local/state/openpalm/artifacts/secrets.env \
  --project-name openpalm \
  up -d
```

The admin starts first and runs an apply on startup, which re-stages config and starts the remaining services.

---

## 9. Verify

```bash
# Check all containers are running
docker compose --project-name openpalm ps

# Test admin health
curl -s http://localhost:8080/admin/health | head
```

The admin UI is available at `http://localhost:8080/admin/` (through Caddy) or directly at `http://localhost:8100/` (bypassing proxy). Both require the `x-admin-token` header for API calls.

---

## What the admin does on startup

When the admin container starts, it automatically runs an **apply** that:

1. Reads `CONFIG_HOME/channels/` and `CONFIG_HOME/automations/`
2. Stages compose overlays, Caddy routes, and automation files into `STATE_HOME`
3. Merges infrastructure config into `stack.env`
4. Runs `docker compose up -d` against staged files
5. Reloads Caddy with staged routes

After the first apply, the admin manages `stack.env` and `STATE_HOME` — you only need to edit files in `CONFIG_HOME` and restart the admin (or call the apply API) to pick up changes. See [directory-structure.md](directory-structure.md) for the full staging flow.

---

## Adding a channel manually

Channels are compose overlays placed in CONFIG_HOME. Example for the built-in chat channel:

1. Copy the channel definition into CONFIG_HOME:
   ```bash
   cp registry/channels/chat/chat.yml ~/.config/openpalm/channels/chat.yml
   # If it has a Caddy route:
   cp registry/channels/chat/chat.caddy ~/.config/openpalm/channels/chat.caddy
   ```

2. Restart the admin (or call `POST /admin/apply`) to stage and activate:
   ```bash
   docker compose --project-name openpalm restart admin
   ```

The admin auto-generates HMAC secrets for new channels and writes them to `stack.env`. See [managing-openpalm.md](managing-openpalm.md) for details.

---

## File summary

After completing all steps, your host should have:

```
~/.config/openpalm/                  # CONFIG_HOME
├── secrets.env                      # ADMIN_TOKEN + LLM keys
├── channels/                        # Channel overlays (.yml + .caddy)
├── automations/                     # User automation definitions
└── opencode/                        # OpenCode extensions
    ├── tools/
    ├── plugins/
    └── skills/

~/.local/share/openpalm/             # DATA_HOME
├── stack.env                        # System config (source of truth)
├── docker-compose.yml               # Core compose (source of truth)
├── openmemory/
│   ├── default_config.json
│   └── memory.py
├── assistant/
├── guardian/
├── automations/
└── caddy/
    ├── Caddyfile                    # Core Caddy config (source of truth)
    ├── data/
    └── config/

~/.local/state/openpalm/             # STATE_HOME
├── artifacts/
│   ├── docker-compose.yml           # Staged compose
│   ├── stack.env                    # Staged stack config
│   ├── secrets.env                  # Staged secrets
│   ├── Caddyfile                    # Staged Caddy config
│   └── channels/                    # Staged channel routes
├── automations/                     # Staged automation files
└── audit/                           # Audit logs

~/openpalm/                          # WORK_DIR (assistant workspace)
```

---

## Further reading

- [directory-structure.md](directory-structure.md) — Full tree, volume mounts, networks
- [environment-and-mounts.md](environment-and-mounts.md) — Every env var and mount point
- [core-principles.md](core-principles.md) — Security invariants and architectural rules
- [managing-openpalm.md](managing-openpalm.md) — Channels, secrets, access control, automations
- [setup-guide.md](setup-guide.md) — Automated installer reference
