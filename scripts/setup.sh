#!/usr/bin/env bash
# OpenPalm — Production Setup Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
#
# Re-run to update (assets are re-downloaded, secrets are never overwritten).
#
# Flow:
#   1. Preflight checks, directory creation, asset download
#   2. Pull ONLY the admin image in the background while prompting for admin token
#   3. Start the admin service, wait for it to be healthy
#   4. Open the setup wizard in the browser (http://localhost:8100/setup)
#   5. The wizard collects LLM/memory config and triggers full-stack install
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────

REPO="itlackey/openpalm"
DEFAULT_VERSION="main"
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=3

# ── Colors / Output ──────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info() { printf "${BLUE}▸${NC} %s\n" "$*"; }
ok() { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*" >&2; }
err() { printf "${RED}✗${NC} %s\n" "$*" >&2; }
die() {
	err "$@"
	exit 1
}
header() { printf "\n${BOLD}── %s ──${NC}\n\n" "$*"; }

# ── Usage ─────────────────────────────────────────────────────────────

usage() {
	cat <<'EOF'
Usage: setup.sh [OPTIONS]

Install or update the OpenPalm stack using published Docker Hub images.

Options:
  --force       Skip confirmation prompts (for updates)
  --version TAG GitHub ref to download assets from (default: main)
  --no-start    Set up files but don't start Docker services
  --no-open     Don't open the admin UI in a browser after install
  -h, --help    Show this help

Environment overrides:
  OPENPALM_CONFIG_HOME   Config directory (default: ~/.config/openpalm)
  OPENPALM_DATA_HOME     Data directory   (default: ~/.local/share/openpalm)
  OPENPALM_STATE_HOME    State directory  (default: ~/.local/state/openpalm)
  OPENPALM_WORK_DIR      Work directory   (default: ~/openpalm)

Examples:
  # Standard install
  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash

  # Install with custom paths
  OPENPALM_CONFIG_HOME=/opt/openpalm/config bash setup.sh

  # Update to latest (skip prompt)
  setup.sh --force
EOF
}

# ── Argument parsing ──────────────────────────────────────────────────

OPT_FORCE=0
OPT_VERSION="$DEFAULT_VERSION"
OPT_NO_START=0
OPT_NO_OPEN=0

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--force) OPT_FORCE=1 ;;
		--version)
			shift
			OPT_VERSION="${1:?--version requires a value}"
			;;
		--no-start) OPT_NO_START=1 ;;
		--no-open) OPT_NO_OPEN=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "Unknown option: $1 (see --help)" ;;
		esac
		shift
	done
}

# ── Preflight checks ─────────────────────────────────────────────────

preflight_checks() {
	header "Preflight checks"

	# Docker
	if ! command -v docker &>/dev/null; then
		die "Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/"
	fi
	if ! docker info &>/dev/null; then
		die "Docker is not running (or current user lacks permission). Start Docker and retry."
	fi
	ok "Docker is running"

	# Docker Compose v2
	if ! docker compose version &>/dev/null; then
		die "Docker Compose v2 is required. Install it: https://docs.docker.com/compose/install/"
	fi
	ok "Docker Compose v2 available"

	# curl
	if ! command -v curl &>/dev/null; then
		die "curl is required but not found."
	fi
	ok "curl available"

	# openssl
	if ! command -v openssl &>/dev/null; then
		die "openssl is required but not found."
	fi
	ok "openssl available"
}

# ── Platform detection ────────────────────────────────────────────────

PLATFORM=""
OPEN_CMD=""
HOST_UID=""
HOST_GID=""
DOCKER_GID=""

detect_platform() {
	header "Detecting platform"

	case "$(uname -s)" in
	Linux) PLATFORM="linux" ;;
	Darwin) PLATFORM="darwin" ;;
	*) die "Unsupported platform: $(uname -s)" ;;
	esac
	ok "Platform: $PLATFORM"

	HOST_UID="$(id -u)"
	HOST_GID="$(id -g)"
	ok "User: UID=$HOST_UID GID=$HOST_GID"

	# Docker socket GID (needed for admin container)
	if [[ "$PLATFORM" == "linux" ]]; then
		if [[ -S /var/run/docker.sock ]]; then
			DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "$HOST_GID")"
		else
			DOCKER_GID="$HOST_GID"
		fi
	else
		# macOS: Docker Desktop handles socket perms, fall back to user GID
		if [[ -S /var/run/docker.sock ]]; then
			DOCKER_GID="$(stat -f '%g' /var/run/docker.sock 2>/dev/null || echo "$HOST_GID")"
		else
			DOCKER_GID="$HOST_GID"
		fi
	fi
	ok "Docker GID: $DOCKER_GID"

	# Browser command (best-effort)
	if [[ "$PLATFORM" == "darwin" ]]; then
		OPEN_CMD="open"
	elif command -v xdg-open &>/dev/null; then
		OPEN_CMD="xdg-open"
	fi
}

# ── Path resolution ───────────────────────────────────────────────────

CONFIG_HOME=""
DATA_HOME=""
STATE_HOME=""
WORK_DIR=""

resolve_paths() {
	header "Resolving paths"

	CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}"
	DATA_HOME="${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}"
	STATE_HOME="${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}"
	WORK_DIR="${OPENPALM_WORK_DIR:-${HOME}/openpalm}"

	info "CONFIG_HOME: $CONFIG_HOME"
	info "DATA_HOME:   $DATA_HOME"
	info "STATE_HOME:  $STATE_HOME"
	info "WORK_DIR:    $WORK_DIR"
}

# ── Existing install check ────────────────────────────────────────────

IS_UPDATE=0

check_existing() {
	local secrets_path="${CONFIG_HOME}/secrets.env"

	if [[ -f "$secrets_path" ]]; then
		IS_UPDATE=1
		warn "OpenPalm appears to be installed ($secrets_path exists)."

		if [[ $OPT_FORCE -eq 1 ]]; then
			info "Continuing with update (--force)."
			return 0
		fi

		# When piped via curl, stdin is the pipe — read from /dev/tty
		printf "%s" "Update existing installation? [y/N] " >&2
		local answer
		if read -r answer </dev/tty 2>/dev/null; then
			case "$answer" in
			[yY] | [yY][eE][sS]) info "Continuing with update." ;;
			*)
				info "Exiting. No changes made."
				exit 0
				;;
			esac
		else
			die "Cannot read from terminal. Use --force to skip confirmation."
		fi
	fi
}

# ── Directory creation ────────────────────────────────────────────────

create_directories() {
	header "Creating directories"

	local dirs=(
		# CONFIG_HOME — user-editable
		"$CONFIG_HOME"
		"$CONFIG_HOME/channels"
		"$CONFIG_HOME/opencode"

		# DATA_HOME — persistent service data
		"$DATA_HOME"
		"$DATA_HOME/postgres"
		"$DATA_HOME/qdrant"
		"$DATA_HOME/openmemory"
		"$DATA_HOME/assistant"
		"$DATA_HOME/guardian"
		"$DATA_HOME/caddy"
		"$DATA_HOME/caddy/data"
		"$DATA_HOME/caddy/config"

		# STATE_HOME — assembled runtime
		"$STATE_HOME"
		"$STATE_HOME/artifacts"
		"$STATE_HOME/audit"

		# WORK_DIR — assistant working directory
		"$WORK_DIR"
	)

	for dir in "${dirs[@]}"; do
		mkdir -p "$dir"
	done

	ok "Directory tree created"
}

# ── Asset download ────────────────────────────────────────────────────

download_asset() {
	local filename="$1"
	local dest="$2"

	# Try GitHub release first, then fall back to raw.githubusercontent.com
	local release_url="https://github.com/${REPO}/releases/download/${OPT_VERSION}/${filename}"
	local raw_url="https://raw.githubusercontent.com/${REPO}/${OPT_VERSION}/assets/${filename}"

	if curl -fsSL --retry 2 -o "$dest" "$release_url" 2>/dev/null; then
		ok "Downloaded $filename (release)"
	elif curl -fsSL --retry 2 -o "$dest" "$raw_url" 2>/dev/null; then
		ok "Downloaded $filename (raw)"
	else
		die "Failed to download $filename from GitHub. Check network and --version."
	fi
}

download_assets() {
	header "Downloading assets"

	# STATE artifacts — always overwritten
	download_asset "docker-compose.yml" "${STATE_HOME}/artifacts/docker-compose.yml"
	download_asset "Caddyfile" "${STATE_HOME}/Caddyfile"
}

# ── Background admin image pull ──────────────────────────────────────

PULL_PID=""
PULL_LOG=""

cleanup() {
	if [[ -n "${PULL_PID:-}" ]] && kill -0 "$PULL_PID" 2>/dev/null; then
		kill "$PULL_PID" 2>/dev/null || true
		wait "$PULL_PID" 2>/dev/null || true
	fi
	[[ -n "${PULL_LOG:-}" ]] && rm -f "$PULL_LOG"
}

start_admin_pull() {
	if [[ $OPT_NO_START -eq 1 ]]; then
		return 0
	fi

	PULL_LOG="$(mktemp)"
	info "Downloading admin image in the background..."

	docker pull "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}" \
		>"$PULL_LOG" 2>&1 &
	PULL_PID=$!
}

wait_for_pull() {
	if [[ -z "${PULL_PID:-}" ]]; then
		return 0
	fi

	# If pull is already done, just collect the exit code
	if ! kill -0 "$PULL_PID" 2>/dev/null; then
		local exit_code=0
		wait "$PULL_PID" || exit_code=$?
		PULL_PID=""
		if [[ $exit_code -ne 0 ]]; then
			err "Admin image download failed (exit code $exit_code):"
			cat "$PULL_LOG" >&2
			die "Fix the issue above and re-run setup."
		fi
		ok "Admin image downloaded"
		return 0
	fi

	header "Waiting for admin image download"

	printf "  Downloading"
	while kill -0 "$PULL_PID" 2>/dev/null; do
		printf "."
		sleep 2
	done
	printf "\n"

	local exit_code=0
	wait "$PULL_PID" || exit_code=$?
	PULL_PID=""

	if [[ $exit_code -ne 0 ]]; then
		err "Admin image download failed (exit code $exit_code):"
		cat "$PULL_LOG" >&2
		die "Fix the issue above and re-run setup."
	fi

	ok "Admin image downloaded"
}

# ── Admin token prompt ────────────────────────────────────────────────

USER_ADMIN_TOKEN=""

prompt_admin_token() {
	# Skip prompt and token generation for updates (existing secrets.env) or --force
	if [[ $IS_UPDATE -eq 1 || $OPT_FORCE -eq 1 ]]; then
		return 0
	fi

	# Auto-generate a candidate token (only needed for fresh installs)
	USER_ADMIN_TOKEN="$(openssl rand -hex 32)"

	header "Configure Admin Token"

	printf "  Generated: ${BOLD}%s${NC}\n" "$USER_ADMIN_TOKEN"
	printf "  Press Enter to accept, or type a custom token: "

	local answer
	if read -r answer </dev/tty 2>/dev/null; then
		if [[ -n "$answer" ]]; then
			USER_ADMIN_TOKEN="$answer"
		fi
	fi
	ok "Admin token set"
}

# ── Secrets generation ────────────────────────────────────────────────

generate_secrets() {
	header "Configuring secrets"

	local secrets_path="${CONFIG_HOME}/secrets.env"

	if [[ -f "$secrets_path" ]]; then
		ok "secrets.env exists — not overwriting"
		return 0
	fi

	cat >"$secrets_path" <<EOF
# OpenPalm Secrets — generated by setup.sh
# LLM provider keys and OpenMemory settings are configured via the setup wizard.
# To update manually, edit this file then restart the stack.

ADMIN_TOKEN=${USER_ADMIN_TOKEN}

# OpenAI-compatible LLM provider (configured via setup wizard)
OPENAI_API_KEY=
OPENAI_BASE_URL=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=

# OpenMemory
OPENMEMORY_USER_ID=default_user

# Optional: uncomment to use non-default XDG directories
# OPENPALM_CONFIG_HOME=/custom/path
# OPENPALM_DATA_HOME=/custom/path
# OPENPALM_STATE_HOME=/custom/path
# OPENPALM_WORK_DIR=/custom/path
EOF

	ok "Generated secrets.env with new ADMIN_TOKEN"
}

# ── Stack env generation ──────────────────────────────────────────────

generate_stack_env() {
	header "Configuring stack environment"

	local stack_env_path="${STATE_HOME}/artifacts/stack.env"

	cat >"$stack_env_path" <<EOF
# OpenPalm Stack Bootstrap — system-managed, do not edit
# Written by setup.sh for initial admin startup. Overwritten by admin on each apply.
OPENPALM_UID=${HOST_UID}
OPENPALM_GID=${HOST_GID}
OPENPALM_DOCKER_GID=${DOCKER_GID}
EOF

	ok "Generated stack.env (UID=${HOST_UID} GID=${HOST_GID} DOCKER_GID=${DOCKER_GID})"
}

# ── OpenCode config seeding ──────────────────────────────────────────

seed_opencode() {
	header "Seeding OpenCode config"

	local opencode_dir="${CONFIG_HOME}/opencode"
	local config_file="${opencode_dir}/opencode.json"

	# Write-once: skip if config already exists
	if [[ ! -f "$config_file" ]]; then
		cat >"$config_file" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
		ok "Created opencode.json"
	else
		ok "opencode.json exists — not overwriting"
	fi

	# Always ensure subdirs exist
	mkdir -p "${opencode_dir}/tools" "${opencode_dir}/plugins" "${opencode_dir}/skills"
	ok "OpenCode subdirectories ready"
}

# ── Docker Compose lifecycle ──────────────────────────────────────────

compose_cmd() {
	docker compose \
		--project-name openpalm \
		-f "${STATE_HOME}/artifacts/docker-compose.yml" \
		--env-file "${CONFIG_HOME}/secrets.env" \
		--env-file "${STATE_HOME}/artifacts/stack.env" \
		"$@"
}

compose_up_admin() {
	header "Starting admin service"

	if [[ $OPT_NO_START -eq 1 ]]; then
		ok "Skipping Docker start (--no-start). Run manually:"
		info "  docker compose --project-name openpalm \\"
		info "    -f ${STATE_HOME}/artifacts/docker-compose.yml \\"
		info "    --env-file ${CONFIG_HOME}/secrets.env \\"
		info "    --env-file ${STATE_HOME}/artifacts/stack.env \\"
		info "    up -d"
		return 0
	fi

	info "Starting admin container..."
	# Start only the admin service; do not start or validate dependent services (e.g. postgres).
	# This avoids needing a placeholder POSTGRES_PASSWORD value at this stage.
	compose_cmd up -d --no-deps admin

	ok "Admin service started"
}

# ── Health check ──────────────────────────────────────────────────────

wait_healthy() {
	if [[ $OPT_NO_START -eq 1 ]]; then
		return 0
	fi

	header "Waiting for admin to become healthy"

	local elapsed=0
	while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
		if curl -sf http://127.0.0.1:8100/ >/dev/null 2>&1; then
			ok "Admin is healthy"
			return 0
		fi
		sleep "$HEALTH_INTERVAL"
		elapsed=$((elapsed + HEALTH_INTERVAL))
		printf "."
	done

	printf "\n"
	warn "Admin did not respond within ${HEALTH_TIMEOUT}s."
	warn "Check logs: docker compose --project-name openpalm -f ${STATE_HOME}/artifacts/docker-compose.yml logs admin"
	exit 1
}

# ── Summary ───────────────────────────────────────────────────────────

print_summary() {
	header "OpenPalm admin is running"

	# Extract ADMIN_TOKEN from secrets.env for display
	local admin_token
	admin_token="$(grep '^ADMIN_TOKEN=' "${CONFIG_HOME}/secrets.env" | cut -d= -f2-)"

	if [[ $IS_UPDATE -eq 1 ]]; then
		printf "${BOLD}Admin Console:${NC} http://localhost:8100/\n"
	else
		printf "${BOLD}Setup Wizard:${NC}  http://localhost:8100/setup\n"
	fi
	printf "${BOLD}Admin token:${NC}   %s\n" "$admin_token"
	printf "\n"
	printf "${BOLD}Config:${NC}        %s\n" "$CONFIG_HOME"
	printf "${BOLD}Data:${NC}          %s\n" "$DATA_HOME"
	printf "${BOLD}State:${NC}         %s\n" "$STATE_HOME"
	printf "${BOLD}Work dir:${NC}      %s\n" "$WORK_DIR"

	if [[ $IS_UPDATE -eq 0 ]]; then
		printf "\n"
		info "Complete setup in your browser. The wizard will configure"
		info "your LLM provider and start the remaining services."
		printf "\n"
		info "Paste the admin token shown above when prompted."
	else
		printf "\n"
		info "Admin updated. Use the console to manage services."
	fi
}

# ── Browser open ──────────────────────────────────────────────────────

open_browser() {
	if [[ $OPT_NO_START -eq 1 || $OPT_NO_OPEN -eq 1 ]]; then
		return 0
	fi

	local url
	if [[ $IS_UPDATE -eq 1 ]]; then
		url="http://localhost:8100/"
	else
		url="http://localhost:8100/setup"
	fi

	if [[ -n "$OPEN_CMD" ]]; then
		"$OPEN_CMD" "$url" 2>/dev/null || true
	fi
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
	printf "\n${BOLD}OpenPalm Setup${NC}\n"

	parse_args "$@"
	preflight_checks
	detect_platform
	resolve_paths
	check_existing
	create_directories
	download_assets

	# Background: pull admin image while we prompt for config
	trap cleanup EXIT
	start_admin_pull
	prompt_admin_token

	generate_secrets
	generate_stack_env
	seed_opencode

	# Wait for admin image, then start admin-only
	wait_for_pull
	compose_up_admin
	wait_healthy

	# Open browser and show summary
	open_browser
	print_summary

	trap - EXIT
	[[ -n "${PULL_LOG:-}" ]] && rm -f "$PULL_LOG"
}

main "$@"