# Manual Setup

Step-by-step guide for configuring an OpenPalm host by hand, without using the installer scripts or CLI. This is useful for understanding what the automation does under the hood, for air-gapped environments, or for custom deployments.

For the automated path, see [setup-guide.md](setup-guide.md). For the developer quick-start, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Prerequisites

- Docker Engine 24+ with Compose V2 (`docker compose` subcommand)
- `openssl` (for generating secrets)
- The `assets/` files from this repository (or download them from a GitHub release)

---

## 1. Choose your paths

OpenPalm uses a single home directory with subdirectories for config, vault, data, and logs:

| Directory | Default | Purpose |
|-----------|---------|---------|
| **OP_HOME** | `~/.openpalm` | Root of all OpenPalm state |
| **config/** | `~/.openpalm/config` | User-editable: components, automations, OpenCode extensions |
| **vault/** | `~/.openpalm/vault` | Secrets: `user.env` (LLM keys), `system.env` (admin token, HMAC) |
| **data/** | `~/.openpalm/data` | Service-managed data (memory, assistant, etc.) |
| **logs/** | `~/.openpalm/logs` | Audit and debug logs |
| **WORK_DIR** | `~/openpalm` | Assistant working directory |

`config/` is the user-owned persistent source of truth. Allowed writers are:
user direct edits, explicit admin UI/API config actions, and assistant actions
through authenticated/allowlisted admin APIs on user request. Automatic
lifecycle operations are non-destructive for existing user config files and
only seed missing defaults. See [core-principles.md](technical/core-principles.md) for
the full filesystem contract.

The rest of this guide uses the defaults. Substitute your own paths if needed.

See [directory-structure.md](technical/directory-structure.md) for the full tree and rationale.

---

## 2. Create the directory tree

```bash
# Config
mkdir -p ~/.openpalm/config/components
mkdir -p ~/.openpalm/config/automations
mkdir -p ~/.openpalm/config/assistant/{tools,plugins,skills}

# Vault (secrets)
mkdir -p ~/.openpalm/vault

# Data
mkdir -p ~/.openpalm/data/admin
mkdir -p ~/.openpalm/data/memory
mkdir -p ~/.openpalm/data/assistant
mkdir -p ~/.openpalm/data/guardian
mkdir -p ~/.openpalm/data/catalog

# Logs
mkdir -p ~/.openpalm/logs

# Cache
mkdir -p ~/.cache/openpalm

# Working directory
mkdir -p ~/openpalm
```

---

## 3. Place the core assets

One file from `assets/` is needed: the Docker Compose definition.

Copy it to the data directory:

```bash
cp assets/docker-compose.yml ~/.openpalm/data/docker-compose.yml
```

If you don't have a local clone, download it from GitHub:

```bash
BASE_URL="https://raw.githubusercontent.com/itlackey/openpalm/main/assets"
curl -fsSL "$BASE_URL/docker-compose.yml" -o ~/.openpalm/data/docker-compose.yml
```

---

## 4. Create vault env files

Secrets are split into two files under `~/.openpalm/vault/`:

**`user.env`** -- User-managed secrets (LLM provider keys):

```bash
cat > ~/.openpalm/vault/user.env << 'EOF'
# At least one LLM key recommended
OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=

MEMORY_USER_ID=default_user
EOF
```

**`system.env`** -- System-managed secrets (admin token, infrastructure config):

```bash
TOKEN=$(openssl rand -hex 24)
cat > ~/.openpalm/vault/system.env << EOF
# Required — change this before exposing the stack
ADMIN_TOKEN=$TOKEN
EOF
echo "Your admin token: $TOKEN"
```

---

## 5. Add system config to system.env

Append infrastructure config to `system.env`. The admin regenerates this on every apply, but it must exist before the first start.

```bash
cat >> ~/.openpalm/vault/system.env << EOF

# ── Paths ──────────────────────────────────────────────────────
OP_HOME=$HOME/.openpalm
OP_WORK_DIR=$HOME/openpalm

# ── User/Group ──────────────────────────────────────────────────────
OP_UID=$(id -u)
OP_GID=$(id -g)

# ── Docker Socket ───────────────────────────────────────────────────
OP_DOCKER_SOCK=/var/run/docker.sock

# ── Images ──────────────────────────────────────────────────────────
OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=latest

# ── Networking ──────────────────────────────────────────────────────
OP_INGRESS_BIND_ADDRESS=127.0.0.1
OP_INGRESS_PORT=8080

# ── Memory ──────────────────────────────────────────────────────
MEMORY_DASHBOARD_API_URL=http://localhost:8765
MEMORY_USER_ID=default_user

EOF
```

**Docker socket detection:** If you use OrbStack, Colima, or Rancher Desktop, the socket may not be at `/var/run/docker.sock`. Detect it with:

```bash
docker context inspect --format '{{.Endpoints.docker.Host}}'
# Example output: unix:///Users/you/.colima/default/docker.sock
```

Set `OP_DOCKER_SOCK` to the path after `unix://`.

---

## 6. Seed Memory config (optional)

Memory needs a default config file if you want memory features:

```bash
cat > ~/.openpalm/data/memory/default_config.json << 'EOF'
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
        "collection_name": "memory",
        "path": "/data/qdrant",
        "embedding_model_dims": 1536
      }
    }
  },
  "memory": {
    "custom_instructions": ""
  }
}
EOF
```

---

## 7. Set file ownership

Ensure your user owns everything:

```bash
chown -R "$(id -u):$(id -g)" \
  ~/.openpalm \
  ~/openpalm
```

---

## 8. Start the stack

```bash
docker compose \
  -f ~/.openpalm/data/docker-compose.yml \
  --env-file ~/.openpalm/vault/system.env \
  --env-file ~/.openpalm/vault/user.env \
  --project-name openpalm \
  up -d
```

The admin starts first and runs an apply on startup, which writes config and starts the remaining services.

---

## 9. Verify

```bash
# Check all containers are running
docker compose --project-name openpalm ps

# Test admin health
curl -s http://localhost:8100/health | head
```

The admin UI is available at `http://localhost:8100/`. API calls require the `x-admin-token` header.

---

## What the admin does on startup

When the admin container starts, it automatically runs an **apply** that:

1. Reads `config/components/` and `config/automations/`
2. Assembles compose command with all component overlays
3. Runs `docker compose up -d`

This startup apply does not overwrite existing user files in `config/`; it
only seeds missing defaults.

After the first apply, the admin manages `vault/system.env` -- you only need to edit files in `config/` and `vault/user.env` and restart the admin (or call the apply API) to pick up changes. See [directory-structure.md](technical/directory-structure.md) for details.

---

## Adding a component manually

Components are directories placed in `config/components/`. Example for the built-in chat channel:

1. Copy the component directory from the registry:
   ```bash
   cp -r registry/components/chat ~/.openpalm/config/components/channel-chat
   ```

2. Restart the admin (or call `POST /admin/apply`) to activate:
   ```bash
   docker compose --project-name openpalm restart admin
   ```

The admin auto-generates HMAC secrets for new components and writes them to `vault/system.env`. See [managing-openpalm.md](managing-openpalm.md) for details.

---

## File summary

After completing all steps, your host should have:

```
~/.openpalm/                              # OP_HOME
├── vault/
│   ├── user.env                          # LLM provider keys
│   └── system.env                        # Admin token, HMAC secrets, system config
│
├── config/
│   ├── components/                       # Installed components (compose.yml + .env)
│   ├── automations/                      # User automation definitions
│   └── assistant/                        # OpenCode extensions
│       ├── opencode.json
│       ├── tools/
│       ├── plugins/
│       └── skills/
│
├── data/
│   ├── docker-compose.yml               # Core compose definition
│   ├── memory/
│   │   └── default_config.json
│   ├── assistant/
│   ├── guardian/
│   └── catalog/                          # Installed component catalog
│
└── logs/                                 # Audit and debug logs

~/openpalm/                               # WORK_DIR (assistant workspace)
```

---

## Further reading

- [directory-structure.md](technical/directory-structure.md) — Full tree, volume mounts, networks
- [environment-and-mounts.md](technical/environment-and-mounts.md) — Every env var and mount point
- [core-principles.md](technical/core-principles.md) — Security invariants and architectural rules
- [managing-openpalm.md](managing-openpalm.md) — Channels, secrets, access control, automations
- [setup-guide.md](setup-guide.md) — Automated installer reference
