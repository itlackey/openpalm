#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--seed-env] [--force] [--pass [--gpg-id <key>]]

Creates local .dev directories and seeds dev config files.

Options:
  --seed-env          Copy assets/secrets.env to .dev/vault/user.env if missing,
                      and generate vault/system.env with auto-detected values.
  --force             Overwrite seeded files even if they already exist.
  --pass              Initialize a pass backend for secret storage (requires GPG key).
  --gpg-id <key>      GPG key ID for the pass backend (required with --pass).
  -h, --help          Show this help
EOF
}

seed_env=0
force=0
use_pass=0
gpg_id=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--seed-env) seed_env=1; shift ;;
	--force) force=1; shift ;;
	--pass) use_pass=1; shift ;;
	--gpg-id) gpg_id="${2:-}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Init submodules ──────────────────────────────────────────────
if [ -f "$ROOT_DIR/.gitmodules" ]; then
	git -C "$ROOT_DIR" submodule update --init --depth 1
fi

DEV_ROOT="$ROOT_DIR/.dev"
CONFIG_DIR="$DEV_ROOT/config"
VAULT_DIR="$DEV_ROOT/vault"
DATA_DIR="$DEV_ROOT/data"
LOGS_DIR="$DEV_ROOT/logs"

mkdir -p \
	"$CONFIG_DIR/assistant/tools" "$CONFIG_DIR/assistant/plugins" "$CONFIG_DIR/assistant/skills" \
	"$CONFIG_DIR/channels" "$CONFIG_DIR/automations" "$CONFIG_DIR/components" "$CONFIG_DIR/stash" \
	"$VAULT_DIR" \
	"$DATA_DIR/memory" "$DATA_DIR/assistant/.config/opencode" \
	"$DATA_DIR/guardian" "$DATA_DIR/caddy/data" "$DATA_DIR/caddy/config" \
	"$DATA_DIR/caddy/channels/public" "$DATA_DIR/caddy/channels/lan" \
	"$DATA_DIR/automations" "$DATA_DIR/models" "$DATA_DIR/stash" "$DATA_DIR/workspace" \
	"$LOGS_DIR/opencode" \
	"$DEV_ROOT/work"

# ── Seed core assets (write-once unless --force) ─────────────────
CADDY_DEST="$DATA_DIR/caddy/Caddyfile"
COMPOSE_DEST="$CONFIG_DIR/components/core.yml"

[[ ! -f "$CADDY_DEST" || $force -eq 1 ]] && cp "$ROOT_DIR/assets/Caddyfile" "$CADDY_DEST"
[[ ! -f "$COMPOSE_DEST" || $force -eq 1 ]] && cp "$ROOT_DIR/assets/docker-compose.yml" "$COMPOSE_DEST"

# Ensure vault env files exist (compose needs them even if empty)
touch "$VAULT_DIR/user.env" "$VAULT_DIR/system.env"

# ── Seed environment files ───────────────────────────────────────
if [[ $seed_env -eq 1 ]]; then
	env_dest="$VAULT_DIR/user.env"
	if [[ ! -f "$env_dest" || $force -eq 1 ]]; then
		cp "$ROOT_DIR/assets/secrets.env" "$env_dest"
		sed -i 's/^export OP_ADMIN_TOKEN=$/export OP_ADMIN_TOKEN=dev-admin-token/' "$env_dest"
		# Uncomment and set the legacy ADMIN_TOKEN alias for dev parity
		sed -i 's/^# export ADMIN_TOKEN=$/export ADMIN_TOKEN=dev-admin-token/' "$env_dest"
		# Seed Ollama as default LLM backend for dev
		sed -i 's/^export OPENAI_API_KEY=$/export OPENAI_API_KEY=ollama/' "$env_dest"
		sed -i 's|^export OPENAI_BASE_URL=$|export OPENAI_BASE_URL=http://host.docker.internal:11434/v1|' "$env_dest"
		# Generate service auth tokens (matches admin's ensureSecrets())
		mem_token=$(openssl rand -hex 32)
		printf '\n# Service auth tokens (auto-generated)\nexport MEMORY_AUTH_TOKEN=%s\n' \
			"$mem_token" >>"$env_dest"
	fi

	system_env="$VAULT_DIR/system.env"
	if [[ ! -f "$system_env" || $force -eq 1 ]]; then
		# Detect Docker socket from active context (supports OrbStack, Colima, etc.)
		docker_sock="/var/run/docker.sock"
		if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
			case "$host_url" in
			unix://*)
				detected_sock="${host_url#unix://}"
				[[ -S "$detected_sock" ]] && docker_sock=$detected_sock
				;;
			esac
		fi

		cat >"$system_env" <<EOF
# OpenPalm System Environment — system-managed, do not edit

OP_HOME=$DEV_ROOT
OP_WORK_DIR=$DEV_ROOT/work

OP_UID=$(id -u)
OP_GID=$(id -g)

OP_DOCKER_SOCK=$docker_sock

OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=latest

OP_INGRESS_BIND_ADDRESS=127.0.0.1
OP_INGRESS_PORT=8080
EOF
	fi
fi

# ── Seed OpenCode user config (Ollama for dev) ──────────────────
# OpenCode has two config files:
#   - Project config (DATA_HOME/assistant/opencode.jsonc) — $schema + plugin ONLY.
#     Seeded by admin's ensureOpenCodeSystemConfig(). Does NOT accept providers,
#     model, or smallModel keys (causes ConfigInvalidError).
#   - User config (CONFIG_HOME/assistant/opencode.json) — $schema + model ONLY.
#     v1.2.24 rejects providers, smallModel, and any other unrecognized keys
#     with a fatal ConfigInvalidError.
#
# OpenCode's "lmstudio" provider uses the Chat Completions API
# (/v1/chat/completions) which Ollama supports. However, the provider
# has a hardcoded base URL of http://127.0.0.1:1234/v1 and a static
# model catalog. The entrypoint.sh uses socat to proxy port 1234
# to the actual LLM provider when LMSTUDIO_BASE_URL is set.
#
# The model name must match one of lmstudio's catalog entries:
#   - qwen/qwen3-30b-a3b-2507, qwen/qwen3-coder-30b, openai/gpt-oss-20b
# For Ollama, create a model alias: ollama cp <your-model> qwen/qwen3-coder-30b

OC_CONFIG="$CONFIG_DIR/assistant/opencode.json"
if [[ ! -f "$OC_CONFIG" || $force -eq 1 ]]; then
	cat >"$OC_CONFIG" <<'OCEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "lmstudio/qwen/qwen3-coder-30b"
}
OCEOF
fi

# ── Seed Memory default config ───────────────────────────────────
if [ ! -f "$DATA_DIR/memory/default_config.json" ]; then
	cat >"$DATA_DIR/memory/default_config.json" <<'OMEOF'
{
  "mem0": {
    "llm": {
      "provider": "ollama",
      "config": {
        "model": "qwen2.5-coder:3b",
        "temperature": 0.1,
        "max_tokens": 2000,
        "api_key": "not-needed",
        "openai_base_url": "http://host.docker.internal:11434"
      }
    },
    "embedder": {
      "provider": "ollama",
      "config": {
        "model": "nomic-embed-text:latest",
        "api_key": "not-needed",
        "openai_base_url": "http://host.docker.internal:11434"
      }
    },
    "vector_store": {
      "provider": "sqlite-vec",
      "config": {
        "collection_name": "memory",
        "db_path": "/data/memory.db",
        "embedding_model_dims": 768
      }
    }
  },
  "memory": {
    "custom_instructions": ""
  }
}
OMEOF
fi

# ── Initialize pass backend (optional) ───────────────────────────
if [[ $use_pass -eq 1 ]]; then
	if [[ -z "$gpg_id" ]]; then
		echo "Error: --pass requires --gpg-id <key>" >&2
		exit 1
	fi

	if ! command -v pass &>/dev/null; then
		echo "Error: 'pass' is not installed. Install it first (e.g. apt install pass)." >&2
		exit 1
	fi

	if ! gpg --list-keys "$gpg_id" >/dev/null 2>&1; then
		echo "Error: GPG key not found: $gpg_id" >&2
		exit 1
	fi

	echo "Initializing pass backend..."
	"$ROOT_DIR/scripts/pass-init.sh" --gpg-id "$gpg_id" --home "$DEV_ROOT"

	# Seed test secrets into the pass store
	SECRETS_DIR="$DATA_DIR/secrets"
	export PASSWORD_STORE_DIR="$SECRETS_DIR/pass-store"
	echo "dev-admin-token" | pass insert -m -f openpalm/openpalm/admin-token 2>/dev/null || true
	echo "dev-assistant-token" | pass insert -m -f openpalm/openpalm/assistant-token 2>/dev/null || true
	echo "Seeded test secrets into pass store."
fi

# ── Fix ownership ────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
	chown -R "$(id -u):$(id -g)" "$CONFIG_DIR" "$VAULT_DIR" "$DATA_DIR" "$LOGS_DIR"
else
	echo "Note: running as root; ownership left as-is." >&2
fi

echo "Dev setup complete."
