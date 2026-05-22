#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--seed-env] [--force] [--enable-addon <name>] [--pass [--gpg-id <key>]]

Creates local .dev directories and seeds dev config files.

Options:
  --seed-env          Seed .dev/stash/vaults/user.env from the user.env.schema template
                      (if missing) and generate .dev/config/stack/stack.env with auto-detected values.
  --force             Overwrite seeded files even if they already exist.
  --enable-addon <n>  Copy .dev/registry/addons/<n>/ into .dev/config/stack/addons/<n>/.
                      Repeat to enable multiple dev addons.
  --pass              Initialize a pass backend for secret storage (requires GPG key).
  --gpg-id <key>      GPG key ID for the pass backend (required with --pass).
  -h, --help          Show this help
EOF
}

seed_env=0
force=0
use_pass=0
gpg_id=""
enabled_addons=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--seed-env)
		seed_env=1
		shift
		;;
	--force)
		force=1
		shift
		;;
	--enable-addon)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --enable-addon requires a name" >&2
			exit 1
		fi
		enabled_addons+=("$2")
		shift 2
		;;
	--pass)
		use_pass=1
		shift
		;;
	--gpg-id)
		gpg_id="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Check Ollama prerequisites (warning only) ────────────────────
# Dev defaults assume a local Ollama instance. Warn if it appears
# unreachable or required models are not pulled.
if command -v ollama &>/dev/null; then
	if ! ollama list &>/dev/null 2>&1; then
		echo "WARNING: 'ollama' CLI found but 'ollama list' failed." >&2
		echo "  Is the Ollama server running? Start it with: ollama serve" >&2
		echo ""
	else
		missing_models=()
		for model in "qwen2.5-coder:3b" "nomic-embed-text:latest"; do
			# ollama list outputs "NAME  ID  SIZE  MODIFIED" — match model name prefix
			if ! ollama list 2>/dev/null | grep -qiF "$model"; then
				missing_models+=("$model")
			fi
		done
		if [[ ${#missing_models[@]} -gt 0 ]]; then
			echo "WARNING: The following Ollama models are not pulled:" >&2
			for m in "${missing_models[@]}"; do
				echo "  - $m    (pull with: ollama pull $m)" >&2
			done
			echo "  Dev defaults require these models for the assistant." >&2
			echo ""
		fi
	fi
else
	echo "WARNING: 'ollama' command not found." >&2
	echo "  Dev defaults assume a local Ollama instance for LLM and embeddings." >&2
	echo "  Install Ollama from https://ollama.ai and pull required models:" >&2
	echo "    ollama pull qwen2.5-coder:3b" >&2
	echo "    ollama pull nomic-embed-text" >&2
	echo ""
fi

# ── Init submodules ──────────────────────────────────────────────
if [ -f "$ROOT_DIR/.gitmodules" ]; then
	git -C "$ROOT_DIR" submodule update --init --depth 1
fi

DEV_ROOT="$ROOT_DIR/.dev"
CONFIG_DIR="$DEV_ROOT/config"
STASH_DIR="$DEV_ROOT/stash"
DATA_DIR="$DEV_ROOT/data"
LOGS_DIR="$DEV_ROOT/logs"

mkdir -p \
	"$CONFIG_DIR/assistant/tools" "$CONFIG_DIR/assistant/plugins" "$CONFIG_DIR/assistant/skills" \
	"$CONFIG_DIR/automations" "$CONFIG_DIR/stack/addons" \
	"$STASH_DIR/vaults" \
	"$DEV_ROOT/registry/addons" "$DEV_ROOT/registry/automations" \
	"$DATA_DIR/assistant/.config/opencode" \
	"$DATA_DIR/guardian" \
	"$DATA_DIR/automations" "$DATA_DIR/ollama" "$DATA_DIR/stash" "$DATA_DIR/guardian-stash" \
	"$DATA_DIR/akm-cache" "$DATA_DIR/guardian-cache" "$DATA_DIR/workspace" \
	"$LOGS_DIR/opencode" \
	"$DEV_ROOT/work"

# ── Seed core assets (write-once unless --force) ─────────────────
COMPOSE_DEST="$CONFIG_DIR/stack/core.compose.yml"

[[ ! -f "$COMPOSE_DEST" || $force -eq 1 ]] && cp "$ROOT_DIR/.openpalm/config/stack/core.compose.yml" "$COMPOSE_DEST"

# Seed registry catalog from repo template.
# Replace shipped addon directories wholesale so removed support files do not linger.
for src_dir in "$ROOT_DIR/.openpalm/state/registry/addons/"*; do
	[[ -d "$src_dir" ]] || continue
	addon_name="$(basename "$src_dir")"
	rm -rf "$DEV_ROOT/registry/addons/$addon_name"
	cp -r "$src_dir" "$DEV_ROOT/registry/addons/$addon_name"
done
cp -r "$ROOT_DIR/.openpalm/state/registry/automations/"* "$DEV_ROOT/registry/automations/" 2>/dev/null || true

# Enable requested addons in the dev runtime
for addon in "${enabled_addons[@]}"; do
	src_dir="$DEV_ROOT/registry/addons/$addon"
	dest_dir="$CONFIG_DIR/stack/addons/$addon"
	if [[ ! -d "$src_dir" ]]; then
		echo "Error: dev registry addon not found: $addon" >&2
		exit 1
	fi
	rm -rf "$dest_dir"
	cp -r "$src_dir" "$dest_dir"
done

# Seed stack.yml (version marker only — LLM/embedding config lives in config/akm/config.json)
STACK_YAML="$CONFIG_DIR/stack.yml"
if [[ ! -f "$STACK_YAML" || $force -eq 1 ]]; then
	cat >"$STACK_YAML" <<'SYEOF'
version: 2
SYEOF
fi

# Seed auth.json (empty — prevents Docker creating it as directory)
AUTH_JSON="$CONFIG_DIR/stack/auth.json"
if [[ ! -f "$AUTH_JSON" || $force -eq 1 ]]; then
	echo '{}' >"$AUTH_JSON"
	chmod 600 "$AUTH_JSON"
fi

# ── Seed environment files ───────────────────────────────────────
if [[ $seed_env -eq 1 ]]; then
	env_dest="$STASH_DIR/vaults/user.env"
	if [[ ! -f "$env_dest" || $force -eq 1 ]]; then
		# Seed user.env with dev-friendly defaults (Ollama backend, dev tokens).
		# The schema template (stash/vaults/user.env.schema) documents all supported
		# variables but contains no values; we write concrete dev values here.
		cat >"$env_dest" <<USEREOF
# OpenPalm user.env — dev environment
# Seeded by dev-setup.sh; safe to edit.

# LLM provider (Ollama for local dev)
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
USEREOF
	fi

	system_env="$CONFIG_DIR/stack/stack.env"
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

		assistant_token=$(openssl rand -hex 32)

		cat >"$system_env" <<EOF
# OpenPalm System Environment — system-managed, do not edit

# WARNING: dev-admin-token is for local development only.
# NEVER use this value in production — generate a strong random token instead.
OP_UI_TOKEN=dev-admin-token
OP_ASSISTANT_TOKEN=${assistant_token}
OP_OPENCODE_PASSWORD=

OP_HOME=$DEV_ROOT

OP_UID=$(id -u)
OP_GID=$(id -g)

OP_DOCKER_SOCK=$docker_sock

OP_IMAGE_NAMESPACE=openpalm
OP_IMAGE_TAG=dev

# Compose project name — MUST differ from production. The default name
# "openpalm" is what ~/.openpalm/ uses; sharing it would let a dev stack
# accidentally clobber a running production stack via docker compose up.
OP_PROJECT_NAME=openpalm-dev

# Host-side port bindings for the compose stack.
# These are intentionally offset from the production defaults (3800/8100/8180)
# so a dev/test stack never conflicts with a production instance running on the
# same machine. Playwright e2e test defaults match these ports so that
# global-setup.ts auto-builds the correct ADMIN_URL/ASSISTANT_URL from stack.env.
OP_ASSISTANT_PORT=4800
OP_ADMIN_PORT=9100
OP_GUARDIAN_PORT=9180
EOF
	fi
fi

# Ensure env files exist (compose needs them even if empty)
touch "$STASH_DIR/vaults/user.env" "$CONFIG_DIR/stack/stack.env"

# Generate channel HMAC secrets in guardian.env (the canonical location)
guardian_env="$CONFIG_DIR/stack/guardian.env"
if [[ ! -f "$guardian_env" || $force -eq 1 ]]; then
	channel_chat_secret=$(openssl rand -hex 16)
	channel_api_secret=$(openssl rand -hex 16)
	channel_voice_secret=$(openssl rand -hex 16)
	channel_discord_secret=$(openssl rand -hex 16)
	channel_slack_secret=$(openssl rand -hex 16)

	cat >"$guardian_env" <<EOF
# Guardian channel HMAC secrets — managed by openpalm
CHANNEL_CHAT_SECRET=${channel_chat_secret}
CHANNEL_API_SECRET=${channel_api_secret}
CHANNEL_VOICE_SECRET=${channel_voice_secret}
CHANNEL_DISCORD_SECRET=${channel_discord_secret}
CHANNEL_SLACK_SECRET=${channel_slack_secret}
EOF
fi

# ── Seed OpenCode user config ─────────────────────────────────────
# Copy all files from repo source. opencode.json references assistant.md
# via "instructions", so both must be present.
for src_file in "$ROOT_DIR/.openpalm/config/assistant/"*; do
	[[ -f "$src_file" ]] || continue
	dest_file="$CONFIG_DIR/assistant/$(basename "$src_file")"
	if [[ ! -f "$dest_file" || $force -eq 1 ]]; then
		cp "$src_file" "$dest_file"
	fi
done

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
# Use Docker to fix root-owned files created by containers (qdrant, opencode, etc.)
if docker info >/dev/null 2>&1; then
	docker run --rm -v "$DEV_ROOT:/cleanup" alpine sh -c \
		"find /cleanup -user root -exec chown $(id -u):$(id -g) {} +" 2>/dev/null || true
fi

if [[ $EUID -ne 0 ]]; then
	chown -R "$(id -u):$(id -g)" "$CONFIG_DIR" "$STASH_DIR" "$DATA_DIR" "$LOGS_DIR" 2>/dev/null || true
else
	echo "Note: running as root; ownership left as-is." >&2
fi

echo "Dev setup complete."
