#!/usr/bin/env bash
set -euo pipefail

OP_HOME='/opt/openpalm'
export OP_CONFIG_HOME='/var/lib/openpalm/config'
export OP_STATE_HOME='/var/lib/openpalm/state'
export OP_DATA_HOME='/var/lib/openpalm/data'
export OP_WORK_DIR='/var/lib/openpalm/work'

mkdir -p "$OP_CONFIG_HOME" "$OP_STATE_HOME" "$OP_DATA_HOME" "$OP_WORK_DIR"
mkdir -p "$OP_CONFIG_HOME/stash"
mkdir -p "$OP_DATA_HOME/admin"

if [[ ! -f "$OP_CONFIG_HOME/secrets.env" ]]; then
	cp "$OP_HOME/assets/secrets.env" "$OP_CONFIG_HOME/secrets.env"
	chmod 600 "$OP_CONFIG_HOME/secrets.env"
fi

if [[ ! -f "$OP_CONFIG_HOME/Caddyfile" ]]; then
	cp "$OP_HOME/assets/Caddyfile" "$OP_CONFIG_HOME/Caddyfile"
fi

if [[ ! -f "$OP_STATE_HOME/docker-compose.yml" ]]; then
	cp "$OP_HOME/assets/docker-compose.yml" "$OP_STATE_HOME/docker-compose.yml"
fi

if [[ ! -d "$OP_CONFIG_HOME/channels" ]]; then
	mkdir -p "$OP_CONFIG_HOME/channels"
fi

if [[ -f "$OP_HOME/image-cache/openpalm-images.tar.zst" && ! -f /var/lib/openpalm/.images-loaded ]]; then
	zstd -dc "$OP_HOME/image-cache/openpalm-images.tar.zst" | docker load
	touch /var/lib/openpalm/.images-loaded
fi

cd "$OP_STATE_HOME"
docker compose --env-file "$OP_CONFIG_HOME/secrets.env" -f "$OP_STATE_HOME/docker-compose.yml" up -d
