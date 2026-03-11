#!/usr/bin/env bash
# OpenPalm — Production Setup Script
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh | bash
#
# Re-run to update (assets are re-downloaded, secrets are never overwritten).
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────

SCRIPT_VERSION="0.9.0-rc9"
REPO="itlackey/openpalm"
SCRIPT_VERSION="0.9.0-rc9"          # Stamped at release time by CI
DEFAULT_VERSION="v${SCRIPT_VERSION}"
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
die() { printf "${RED}✗${NC} %s\n" "$*" >&2; exit 1; }
header() { printf "\n${BOLD}── %s ──${NC}\n\n" "$*"; }

# ── Usage ─────────────────────────────────────────────────────────────

usage() {
	cat <<EOF
Usage: setup.sh [OPTIONS]

Install or update the OpenPalm stack using published Docker Hub images.

Options:
  --force       Skip confirmation prompts (for updates)
  --version TAG GitHub ref to download assets from (default: v${SCRIPT_VERSION})
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
  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v${SCRIPT_VERSION}/scripts/setup.sh | bash

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

# ── Image tag resolution ─────────────────────────────────────────────

resolve_image_tag() {
	if [[ -n "${OPENPALM_IMAGE_TAG:-}" ]]; then
		echo "$OPENPALM_IMAGE_TAG"
	elif [[ "$OPT_VERSION" == v[0-9]* ]]; then
		echo "$OPT_VERSION"
	else
		echo "latest"
	fi
}

# ── Preflight checks ─────────────────────────────────────────────────

header "Preflight checks"

command -v docker &>/dev/null || die "Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/"
docker info &>/dev/null || die "Docker is not running (or current user lacks permission). Start Docker and retry."
ok "Docker is running"

docker compose version &>/dev/null || die "Docker Compose v2 is required. Install it: https://docs.docker.com/compose/install/"
ok "Docker Compose v2 available"

command -v curl &>/dev/null || die "curl is required but not found."
command -v openssl &>/dev/null || die "openssl is required but not found."

# ── Platform detection ────────────────────────────────────────────────

header "Detecting platform"

case "$(uname -s)" in
Linux) PLATFORM="linux" ;;
Darwin) PLATFORM="darwin" ;;
*) die "Unsupported platform: $(uname -s)" ;;
esac

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
ok "Platform: $PLATFORM (UID=$HOST_UID GID=$HOST_GID)"

# Docker socket — detect from active context (supports OrbStack, Colima, etc.)
DOCKER_SOCK="/var/run/docker.sock"
if host_url="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
	case "$host_url" in
	unix://*)
		detected_sock="${host_url#unix://}"
		[[ -S "$detected_sock" ]] && DOCKER_SOCK="$detected_sock"
		;;
	esac
fi
ok "Docker socket: $DOCKER_SOCK"

# Browser command (best-effort)
OPEN_CMD=""
if [[ "$PLATFORM" == "darwin" ]]; then
	OPEN_CMD="open"
elif command -v xdg-open &>/dev/null; then
	OPEN_CMD="xdg-open"
fi

# ── Path resolution ───────────────────────────────────────────────────

header "Resolving paths"

CONFIG_HOME="${OPENPALM_CONFIG_HOME:-${HOME}/.config/openpalm}"
DATA_HOME="${OPENPALM_DATA_HOME:-${HOME}/.local/share/openpalm}"
STATE_HOME="${OPENPALM_STATE_HOME:-${HOME}/.local/state/openpalm}"
WORK_DIR="${OPENPALM_WORK_DIR:-${HOME}/openpalm}"

info "CONFIG_HOME: $CONFIG_HOME"
info "DATA_HOME:   $DATA_HOME"
info "STATE_HOME:  $STATE_HOME"
info "WORK_DIR:    $WORK_DIR"

# ── Existing install check ────────────────────────────────────────────

IS_UPDATE=0
if [[ -f "${CONFIG_HOME}/secrets.env" ]]; then
	IS_UPDATE=1
	warn "OpenPalm appears to be installed (secrets.env exists)."

	if [[ $OPT_FORCE -eq 0 ]]; then
		printf "%s" "Update existing installation? [y/N] " >&2
		if read -r answer </dev/tty 2>/dev/null; then
			case "$answer" in
			[yY] | [yY][eE][sS]) info "Continuing with update." ;;
			*) info "Exiting. No changes made."; exit 0 ;;
			esac
		else
			die "Cannot read from terminal. Use --force to skip confirmation."
		fi
	fi
fi

# ── Directory creation ────────────────────────────────────────────────

header "Creating directories"

mkdir -p \
	"$CONFIG_HOME" "$CONFIG_HOME/channels" "$CONFIG_HOME/assistant" \
	"$CONFIG_HOME/automations" "$CONFIG_HOME/stash" \
	"$DATA_HOME" "$DATA_HOME/memory" "$DATA_HOME/assistant" \
	"$DATA_HOME/guardian" "$DATA_HOME/caddy/data" "$DATA_HOME/caddy/config" \
	"$DATA_HOME/automations" \
	"$STATE_HOME" "$STATE_HOME/artifacts" "$STATE_HOME/audit" \
	"$STATE_HOME/artifacts/channels" "$STATE_HOME/automations" \
	"$WORK_DIR"
ok "Directory tree created"

# ── Asset download ────────────────────────────────────────────────────

header "Downloading assets"

download_asset() {
	local filename="$1" dest="$2"
	local tmp="${dest}.tmp"
	local release_url="https://github.com/${REPO}/releases/download/${OPT_VERSION}/${filename}"
	local raw_url="https://raw.githubusercontent.com/${REPO}/${OPT_VERSION}/core/assets/${filename}"

	if curl -fsSL --retry 2 -o "$tmp" "$release_url" 2>/dev/null; then
		ok "Downloaded $filename (release)"
	elif curl -fsSL --retry 2 -o "$tmp" "$raw_url" 2>/dev/null; then
		ok "Downloaded $filename (raw)"
	else
		rm -f "$tmp"
		die "Failed to download $filename from GitHub. Check network and --version."
	fi

	if [[ ! -s "$tmp" ]]; then
		rm -f "$tmp"
		die "Downloaded $filename is empty. Check --version and network."
	fi

	# Checksum verification — validate against SHA256SUMS if available
	if [[ -n "${CHECKSUMS_FILE:-}" ]]; then
		local expected
		expected="$(grep -F "$filename" "$CHECKSUMS_FILE" 2>/dev/null | awk '{print $1}')"
		if [[ -n "$expected" ]]; then
			local actual
			actual="$(sha256sum "$tmp" | awk '{print $1}')"
			if [[ "$actual" != "$expected" ]]; then
				rm -f "$tmp"
				die "Checksum mismatch for $filename (expected=$expected, got=$actual)"
			fi
			ok "Checksum verified: $filename"
		fi
	fi

	mv -f "$tmp" "$dest"
}

# Try to download SHA256SUMS for checksum verification
CHECKSUMS_FILE=""
checksums_tmp="$(mktemp 2>/dev/null || echo "/tmp/openpalm-checksums.$$")"
checksums_release_url="https://github.com/${REPO}/releases/download/${OPT_VERSION}/SHA256SUMS"
checksums_raw_url="https://raw.githubusercontent.com/${REPO}/${OPT_VERSION}/core/assets/SHA256SUMS"
if curl -fsSL --retry 1 -o "$checksums_tmp" "$checksums_release_url" 2>/dev/null && [[ -s "$checksums_tmp" ]]; then
	CHECKSUMS_FILE="$checksums_tmp"
	ok "Downloaded SHA256SUMS (release)"
elif curl -fsSL --retry 1 -o "$checksums_tmp" "$checksums_raw_url" 2>/dev/null && [[ -s "$checksums_tmp" ]]; then
	CHECKSUMS_FILE="$checksums_tmp"
	ok "Downloaded SHA256SUMS (raw)"
else
	rm -f "$checksums_tmp"
	info "No SHA256SUMS found — skipping checksum verification"
fi

download_asset "docker-compose.yml" "${DATA_HOME}/docker-compose.yml"
download_asset "Caddyfile" "${DATA_HOME}/caddy/Caddyfile"

# Clean up checksums temp file
[[ -n "${CHECKSUMS_FILE:-}" ]] && rm -f "$CHECKSUMS_FILE"

# Bootstrap staging: copy to STATE so compose can start admin before first apply
cp "${DATA_HOME}/docker-compose.yml" "${STATE_HOME}/artifacts/docker-compose.yml"
cp "${DATA_HOME}/caddy/Caddyfile" "${STATE_HOME}/artifacts/Caddyfile"

# ── Pull admin image ─────────────────────────────────────────────────

if [[ $OPT_NO_START -eq 0 ]]; then
	header "Pulling admin image"
	docker pull "${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:$(resolve_image_tag)"
	ok "Admin image ready"
fi

# ── Secrets generation ────────────────────────────────────────────────

header "Configuring secrets"

if [[ -f "${CONFIG_HOME}/secrets.env" ]]; then
	ok "secrets.env exists — not overwriting"
else
	detected_user="${USER:-${LOGNAME:-$(whoami 2>/dev/null || echo "default_user")}}"

	cat >"${CONFIG_HOME}/secrets.env" <<EOF
# OpenPalm Secrets — generated by setup.sh
# All values are configured via the setup wizard.

ADMIN_TOKEN=

# OpenAI-compatible LLM provider (configured via setup wizard)
OPENAI_API_KEY=
OPENAI_BASE_URL=

# Memory
MEMORY_USER_ID=${detected_user}
EOF
	ok "Generated secrets.env (admin token will be set by setup wizard)"
fi

# ── Stack env generation ──────────────────────────────────────────────

header "Configuring stack environment"

data_stack_env="${DATA_HOME}/stack.env"
staged_stack_env="${STATE_HOME}/artifacts/stack.env"

if [[ -f "$data_stack_env" ]]; then
	ok "stack.env exists — not overwriting"
else
	cat >"$data_stack_env" <<EOF
# OpenPalm Stack Bootstrap — system-managed, do not edit

OPENPALM_CONFIG_HOME=${CONFIG_HOME}
OPENPALM_DATA_HOME=${DATA_HOME}
OPENPALM_STATE_HOME=${STATE_HOME}
OPENPALM_WORK_DIR=${WORK_DIR}

OPENPALM_UID=${HOST_UID}
OPENPALM_GID=${HOST_GID}

OPENPALM_DOCKER_SOCK=${DOCKER_SOCK}

OPENPALM_IMAGE_NAMESPACE=${OPENPALM_IMAGE_NAMESPACE:-openpalm}
OPENPALM_IMAGE_TAG=$(resolve_image_tag)
EOF
	ok "Generated stack.env"
fi

cp "$data_stack_env" "$staged_stack_env"

# ── OpenCode config seeding ──────────────────────────────────────────

opencode_config="${CONFIG_HOME}/assistant/opencode.json"
if [[ ! -f "$opencode_config" ]]; then
	cat >"$opencode_config" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
fi
mkdir -p "${CONFIG_HOME}/assistant/tools" "${CONFIG_HOME}/assistant/plugins" "${CONFIG_HOME}/assistant/skills"

# ── Docker Compose lifecycle ──────────────────────────────────────────

compose_cmd() {
	docker compose \
		--project-name openpalm \
		-f "${STATE_HOME}/artifacts/docker-compose.yml" \
		--env-file "${CONFIG_HOME}/secrets.env" \
		--env-file "${STATE_HOME}/artifacts/stack.env" \
		"$@"
}

if [[ $OPT_NO_START -eq 1 ]]; then
	ok "Skipping Docker start (--no-start). Run manually:"
	info "  docker compose --project-name openpalm \\"
	info "    -f ${STATE_HOME}/artifacts/docker-compose.yml \\"
	info "    --env-file ${CONFIG_HOME}/secrets.env \\"
	info "    --env-file ${STATE_HOME}/artifacts/stack.env \\"
	info "    up -d"
else
	header "Starting services"

	if [[ $IS_UPDATE -eq 1 ]]; then
		compose_cmd up -d
	else
		compose_cmd up -d docker-socket-proxy admin
	fi
	ok "Services started"

	# ── Health check ──────────────────────────────────────────────────
	header "Waiting for admin to become healthy"

	elapsed=0
	while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
		if curl -sf http://127.0.0.1:8100/ >/dev/null 2>&1; then
			ok "Admin is healthy"
			break
		fi
		sleep "$HEALTH_INTERVAL"
		elapsed=$((elapsed + HEALTH_INTERVAL))
		printf "."
	done

	if [[ $elapsed -ge $HEALTH_TIMEOUT ]]; then
		printf "\n"
		warn "Admin did not respond within ${HEALTH_TIMEOUT}s."
		warn "Check logs: docker compose --project-name openpalm -f ${STATE_HOME}/artifacts/docker-compose.yml logs admin"
		exit 1
	fi

	# ── Open browser ──────────────────────────────────────────────────
	if [[ $OPT_NO_OPEN -eq 0 && -n "$OPEN_CMD" ]]; then
		local_url="http://localhost:8100/"
		[[ $IS_UPDATE -eq 0 ]] && local_url="http://localhost:8100/setup"
		"$OPEN_CMD" "$local_url" 2>/dev/null || true
	fi
fi

# ── Summary ───────────────────────────────────────────────────────────

header "OpenPalm admin is running"

if [[ $IS_UPDATE -eq 1 ]]; then
	printf "${BOLD}Admin Console:${NC} http://localhost:8100/\n"
else
	printf "${BOLD}Setup Wizard:${NC}  http://localhost:8100/setup\n"

	# Display the setup token for the wizard
	SETUP_TOKEN_FILE="${STATE_HOME}/setup-token.txt"
	if [[ -f "$SETUP_TOKEN_FILE" ]]; then
		SETUP_TOKEN="$(cat "$SETUP_TOKEN_FILE")"
		printf "\n"
		printf "${BOLD}${YELLOW}Setup Token:${NC}   ${BOLD}%s${NC}\n" "$SETUP_TOKEN"
		info "Paste this token into the setup wizard to authenticate."
	fi
fi
printf "\n"
printf "${BOLD}Config:${NC}        %s\n" "$CONFIG_HOME"
printf "${BOLD}Data:${NC}          %s\n" "$DATA_HOME"
printf "${BOLD}State:${NC}         %s\n" "$STATE_HOME"
printf "${BOLD}Work dir:${NC}      %s\n" "$WORK_DIR"

if [[ $IS_UPDATE -eq 0 ]]; then
	printf "\n"
	info "Complete setup in your browser. The wizard will configure"
	info "your admin token, LLM provider, and start the remaining services."
fi
