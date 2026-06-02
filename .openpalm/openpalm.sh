#!/usr/bin/env bash
#
# openpalm.sh — example helper for power users.
#
# Wraps the same `docker compose` invocation the OpenPalm CLI and admin UI
# use, so you can drive the stack directly without the CLI installed. This is
# an EXAMPLE: the canonical orchestrator is the `openpalm` CLI (and the admin
# UI). `upgrade` here only pulls images + recreates containers — it does NOT
# refresh shipped assets or the UI build from GitHub the way `openpalm update`
# does.
#
# Usage:
#   ./openpalm.sh up            Start the stack (detached)
#   ./openpalm.sh down          Stop and remove the stack
#   ./openpalm.sh restart       Restart running services
#   ./openpalm.sh upgrade       Pull latest images and recreate containers
#   ./openpalm.sh status        Show container status
#   ./openpalm.sh logs [svc]    Follow logs (optionally for one service)
#   ./openpalm.sh compose ...   Run an arbitrary docker compose subcommand
#
# OP_HOME defaults to this script's directory. Override by exporting OP_HOME.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OP_HOME="${OP_HOME:-$SCRIPT_DIR}"
export OP_HOME

STACK_DIR="$OP_HOME/config/stack"

if [ ! -f "$STACK_DIR/core.compose.yml" ]; then
  echo "error: $STACK_DIR/core.compose.yml not found — is OP_HOME correct?" >&2
  exit 1
fi

# Compose overlays, in the same order the control plane assembles them.
files=(-f "$STACK_DIR/core.compose.yml")
for name in services channels custom; do
  [ -f "$STACK_DIR/$name.compose.yml" ] && files+=(-f "$STACK_DIR/$name.compose.yml")
done

# stack.env (knowledge/env/stack.env) feeds both compose variable substitution
# (--env-file) and the process environment (so COMPOSE_PROFILES and friends
# activate addons).
STACK_ENV="$OP_HOME/knowledge/env/stack.env"
env_args=()
if [ -f "$STACK_ENV" ]; then
  env_args=(--env-file "$STACK_ENV")
  set -a
  # shellcheck disable=SC1091
  . "$STACK_ENV"
  set +a
fi

project="${OP_PROJECT_NAME:-${COMPOSE_PROJECT_NAME:-openpalm}}"

compose() {
  docker compose --project-name "$project" "${files[@]}" "${env_args[@]}" "$@"
}

action="${1:-}"
[ $# -gt 0 ] && shift || true

case "$action" in
  up)      compose up -d "$@" ;;
  down)    compose down "$@" ;;
  restart) compose restart "$@" ;;
  upgrade) compose pull && compose up -d ;;
  status|ps) compose ps "$@" ;;
  logs)    compose logs -f "$@" ;;
  compose) compose "$@" ;;
  ""|-h|--help|help)
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
    ;;
  *)
    echo "error: unknown command '$action' (try: up, down, restart, upgrade, status, logs)" >&2
    exit 1
    ;;
esac
