#!/usr/bin/env bash
set -euo pipefail

STATE_HOME="${OPENPALM_STATE_HOME:-/workspace}"
LOG_DIR="${OPENPALM_MAINTENANCE_LOG_DIR:-${STATE_HOME}/observability/maintenance}"
mkdir -p "$LOG_DIR"

cat > /etc/cron.d/openpalm-maintenance <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
OPENPALM_MAINTENANCE_LOG_DIR=${LOG_DIR}
OPENPALM_STATE_HOME=${STATE_HOME}
COMPOSE_PROJECT_PATH=${COMPOSE_PROJECT_PATH:-${STATE_HOME}}
OPENPALM_COMPOSE_BIN=${OPENPALM_COMPOSE_BIN:-docker}
OPENPALM_COMPOSE_SUBCOMMAND=${OPENPALM_COMPOSE_SUBCOMMAND:-compose}
OPENPALM_CONTAINER_SOCKET_URI=${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/openpalm-container.sock}
POSTGRES_USER=${POSTGRES_USER:-openpalm}
POSTGRES_DB=${POSTGRES_DB:-openpalm}

# Pull updated images and recreate services when updates are available.
15 3 * * * root /app/maintenance.sh pull-and-restart >> ${LOG_DIR}/pull-and-restart.log 2>&1
# Rotate/compress maintenance logs.
17 * * * * root /app/maintenance.sh log-rotate >> ${LOG_DIR}/log-rotate.log 2>&1
# Prune unused container images.
45 3 * * 0 root /app/maintenance.sh prune-images >> ${LOG_DIR}/prune-images.log 2>&1
# System health check + auto-restart for failed services.
*/10 * * * * root /app/maintenance.sh health-check >> ${LOG_DIR}/health-check.log 2>&1
# Security scan (best-effort; logs capability if scanner unavailable).
40 2 * * * root /app/maintenance.sh security-scan >> ${LOG_DIR}/security-scan.log 2>&1
# Database maintenance for postgres.
20 2 * * * root /app/maintenance.sh db-maintenance >> ${LOG_DIR}/db-maintenance.log 2>&1
# Filesystem/resource cleanup.
10 4 * * * root /app/maintenance.sh filesystem-cleanup >> ${LOG_DIR}/filesystem-cleanup.log 2>&1
# Scrape lightweight runtime metrics for observability.
*/5 * * * * root /app/maintenance.sh metrics-report >> ${LOG_DIR}/metrics-report.log 2>&1
EOF

chmod 0644 /etc/cron.d/openpalm-maintenance
crontab /etc/cron.d/openpalm-maintenance
cron

exec bun run server.ts
