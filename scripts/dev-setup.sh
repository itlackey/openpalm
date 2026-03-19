#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--seed-env] [--force]

Creates local .dev directories and seeds dev config files.

Options:
  --seed-env   Copy assets/secrets.env to .dev/config/secrets.env if missing,
               and generate STATE_HOME/artifacts/stack.env with auto-detected values.
  --force      Overwrite seeded files even if they already exist.
  -h, --help   Show this help
EOF
}

seed_env=0
force=0

for arg in "$@"; do
	case "$arg" in
	--seed-env) seed_env=1 ;;
	--force) force=1 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Init submodules ──────────────────────────────────────────────
if [ -f "$ROOT_DIR/.gitmodules" ]; then
	git -C "$ROOT_DIR" submodule update --init --depth 1
fi

DEV_ROOT="$ROOT_DIR/.dev"
CONFIG_DIR="$DEV_ROOT/config"
STATE_DIR="$DEV_ROOT/state"
DATA_DIR="$DEV_ROOT/data"

mkdir -p \
	"$CONFIG_DIR/assistant/tools" "$CONFIG_DIR/assistant/plugins" "$CONFIG_DIR/assistant/skills" \
	"$CONFIG_DIR/channels" "$CONFIG_DIR/automations" "$CONFIG_DIR/stash" \
	"$STATE_DIR/artifacts/channels/public" "$STATE_DIR/artifacts/channels/lan" \
	"$STATE_DIR/audit" "$STATE_DIR/automations" "$STATE_DIR/opencode" \
	"$DATA_DIR/memory" "$DATA_DIR/assistant/.config/opencode" \
	"$DATA_DIR/guardian" "$DATA_DIR/caddy/data" "$DATA_DIR/caddy/config" \
	"$DATA_DIR/automations" "$DATA_DIR/models" "$DATA_DIR/opencode" \
	"$DEV_ROOT/work"

# ── Seed core assets to DATA_HOME (write-once unless --force) ────
CADDY_DEST="$DATA_DIR/caddy/Caddyfile"
COMPOSE_DEST="$DATA_DIR/docker-compose.yml"

[[ ! -f "$CADDY_DEST" || $force -eq 1 ]] && cp "$ROOT_DIR/assets/Caddyfile" "$CADDY_DEST"
[[ ! -f "$COMPOSE_DEST" || $force -eq 1 ]] && cp "$ROOT_DIR/assets/docker-compose.yml" "$COMPOSE_DEST"

# Bootstrap staging: copy to STATE so compose works before admin's first apply
cp "$COMPOSE_DEST" "$STATE_DIR/artifacts/docker-compose.yml"
cp "$CADDY_DEST" "$STATE_DIR/artifacts/Caddyfile"
touch "$STATE_DIR/artifacts/secrets.env"

# ── Seed environment files ───────────────────────────────────────
if [[ $seed_env -eq 1 ]]; then
	env_dest="$CONFIG_DIR/secrets.env"
	if [[ ! -f "$env_dest" || $force -eq 1 ]]; then
		cp "$ROOT_DIR/assets/secrets.env" "$env_dest"
		sed -i 's/^export OPENPALM_ADMIN_TOKEN=$/export OPENPALM_ADMIN_TOKEN=dev-admin-token/' "$env_dest"
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
	[[ -f "$env_dest" ]] && cp "$env_dest" "$STATE_DIR/artifacts/secrets.env"

	stack_env="$DATA_DIR/stack.env"
	if [[ ! -f "$stack_env" || $force -eq 1 ]]; then
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

		cat >"$stack_env" <<EOF
# OpenPalm Stack Configuration — system-managed, do not edit

OPENPALM_CONFIG_HOME=$DEV_ROOT/config
OPENPALM_DATA_HOME=$DEV_ROOT/data
OPENPALM_STATE_HOME=$DEV_ROOT/state
OPENPALM_WORK_DIR=$DEV_ROOT/work

OPENPALM_UID=$(id -u)
OPENPALM_GID=$(id -g)

OPENPALM_DOCKER_SOCK=$docker_sock

OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=latest

OPENPALM_INGRESS_BIND_ADDRESS=127.0.0.1
OPENPALM_INGRESS_PORT=8080
EOF
	fi

	[[ -f "$stack_env" ]] && cp "$stack_env" "$STATE_DIR/artifacts/stack.env"
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

# ── Fix ownership ────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
	chown -R "$(id -u):$(id -g)" "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR"
else
	echo "Note: running as root; ownership left as-is." >&2
fi

echo "Dev setup complete."
