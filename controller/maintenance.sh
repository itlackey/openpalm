#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"
STATE_HOME="${OPENPALM_STATE_HOME:-/workspace}"
LOG_DIR="${OPENPALM_MAINTENANCE_LOG_DIR:-${STATE_HOME}/observability/maintenance}"
COMPOSE_PROJECT_PATH="${COMPOSE_PROJECT_PATH:-${STATE_HOME}}"
OPENPALM_COMPOSE_BIN="${OPENPALM_COMPOSE_BIN:-docker}"
OPENPALM_COMPOSE_SUBCOMMAND="${OPENPALM_COMPOSE_SUBCOMMAND:-compose}"
OPENPALM_CONTAINER_SOCKET_URI="${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/openpalm-container.sock}"
POSTGRES_USER="${POSTGRES_USER:-openpalm}"
POSTGRES_DB="${POSTGRES_DB:-openpalm}"

TMP_DIR="${STATE_HOME}/observability/tmp"
mkdir -p "$LOG_DIR" "$TMP_DIR"

compose() {
  local compose_args=()
  if [[ -n "$OPENPALM_COMPOSE_SUBCOMMAND" ]]; then
    compose_args+=("$OPENPALM_COMPOSE_SUBCOMMAND")
  fi
  (
    cd "$COMPOSE_PROJECT_PATH"
    DOCKER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" CONTAINER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" \
      "$OPENPALM_COMPOSE_BIN" "${compose_args[@]}" -f docker-compose.yml "$@"
  )
}

log() {
  echo "[$(date -Iseconds)] $*"
}

case "$TASK" in
  pull-and-restart)
    log "pulling updated images and recreating services"
    compose -p openpalm pull
    compose -p openpalm up -d
    ;;
  log-rotate)
    log "rotating maintenance logs"
    find "$LOG_DIR" -type f -name "*.log" -size +5M -mtime +0 -print0 | while IFS= read -r -d '' file; do
      gzip -f "$file"
    done
    find "$LOG_DIR" -type f -name "*.gz" -mtime +14 -delete
    ;;
  prune-images)
    log "pruning unused images older than 7 days"
    DOCKER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" docker image prune -af --filter "until=168h"
    ;;
  health-check)
    log "running health checks"
    for endpoint in http://localhost:8090/health http://admin:8088/health http://gateway:8080/health; do
      if ! curl -fsS --max-time 8 "$endpoint" >/dev/null; then
        log "health probe failed: $endpoint"
      fi
    done
    if command -v jq >/dev/null 2>&1; then
      compose -p openpalm ps --format json \
        | jq -r '.[] | select(((.State // "" | ascii_downcase) | test("running|healthy|up")) | not) | .Service' \
        | while IFS= read -r svc; do
            [[ -z "$svc" ]] && continue
            log "restarting non-running service: $svc"
            compose -p openpalm restart "$svc" || true
          done
    fi
    ;;
  security-scan)
    log "running security scan"
    if DOCKER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" docker scout version >/dev/null 2>&1; then
      while IFS= read -r image; do
        [[ -z "$image" ]] && continue
        DOCKER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" docker scout quickview "$image" || true
      done < <(compose -p openpalm config --images | sort -u)
    else
      log "docker scout unavailable; skipping vulnerability scan"
    fi
    ;;
  db-maintenance)
    log "running postgres vacuum analyze"
    if compose -p openpalm ps --services --filter status=running | grep -qx "postgres"; then
      compose -p openpalm exec -T postgres vacuumdb --all --analyze-in-stages -U "$POSTGRES_USER" || true
    else
      log "postgres is not running; skipping maintenance"
    fi
    ;;
  filesystem-cleanup)
    log "cleaning old temporary files"
    find "$TMP_DIR" -type f -mtime +7 -delete
    ;;
  metrics-report)
    log "scraping runtime metrics snapshot"
    find "$LOG_DIR" -type f -name "metrics-*.jsonl" -mtime +7 -delete
    DOCKER_HOST="$OPENPALM_CONTAINER_SOCKET_URI" docker stats --no-stream --format '{{json .}}' > "$LOG_DIR/metrics-$(date +%Y%m%d%H%M%S).jsonl" || true
    ;;
  *)
    echo "usage: $0 {pull-and-restart|log-rotate|prune-images|health-check|security-scan|db-maintenance|filesystem-cleanup|metrics-report}" >&2
    exit 1
    ;;
esac
