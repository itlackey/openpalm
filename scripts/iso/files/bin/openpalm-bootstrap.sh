#!/usr/bin/env bash
set -euo pipefail

OPENPALM_HOME='/opt/openpalm'
export OPENPALM_CONFIG_HOME='/var/lib/openpalm/config'
export OPENPALM_STATE_HOME='/var/lib/openpalm/state'
export OPENPALM_DATA_HOME='/var/lib/openpalm/data'
export OPENPALM_WORK_DIR='/var/lib/openpalm/work'

mkdir -p "$OPENPALM_CONFIG_HOME" "$OPENPALM_STATE_HOME" "$OPENPALM_DATA_HOME" "$OPENPALM_WORK_DIR"

if [[ ! -f "$OPENPALM_CONFIG_HOME/secrets.env" ]]; then
  cp "$OPENPALM_HOME/assets/secrets.env" "$OPENPALM_CONFIG_HOME/secrets.env"
  chmod 600 "$OPENPALM_CONFIG_HOME/secrets.env"
fi

if [[ ! -f "$OPENPALM_CONFIG_HOME/Caddyfile" ]]; then
  cp "$OPENPALM_HOME/assets/Caddyfile" "$OPENPALM_CONFIG_HOME/Caddyfile"
fi

if [[ ! -f "$OPENPALM_STATE_HOME/docker-compose.yml" ]]; then
  cp "$OPENPALM_HOME/assets/docker-compose.yml" "$OPENPALM_STATE_HOME/docker-compose.yml"
fi

if [[ ! -d "$OPENPALM_CONFIG_HOME/channels" ]]; then
  mkdir -p "$OPENPALM_CONFIG_HOME/channels"
fi

if [[ -f "$OPENPALM_HOME/image-cache/openpalm-images.tar.zst" && ! -f /var/lib/openpalm/.images-loaded ]]; then
  zstd -dc "$OPENPALM_HOME/image-cache/openpalm-images.tar.zst" | docker load
  touch /var/lib/openpalm/.images-loaded
fi

cd "$OPENPALM_STATE_HOME"
docker compose --env-file "$OPENPALM_CONFIG_HOME/secrets.env" -f "$OPENPALM_STATE_HOME/docker-compose.yml" up -d
