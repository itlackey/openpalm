#!/usr/bin/env bash
set -euo pipefail

OP_HOME='/opt/openpalm'
export OP_CONFIG_HOME='/var/lib/openpalm/config'
export OP_STATE_HOME='/var/lib/openpalm/state'
export OP_DATA_HOME='/var/lib/openpalm/data'
export OP_WORK_DIR='/var/lib/openpalm/work'
VAULT_HOME='/var/lib/openpalm/vault'

mkdir -p "$OP_CONFIG_HOME" "$OP_STATE_HOME" "$OP_DATA_HOME" "$OP_WORK_DIR"
mkdir -p "$VAULT_HOME/stack" "$VAULT_HOME/user"
mkdir -p "$OP_CONFIG_HOME/stash"
mkdir -p "$OP_CONFIG_HOME/components"
mkdir -p "$OP_DATA_HOME/admin"

if [[ ! -f "$VAULT_HOME/user/user.env" ]]; then
	cp "$OP_HOME/vault/user.env.example" "$VAULT_HOME/user/user.env"
	chmod 600 "$VAULT_HOME/user/user.env"
fi

if [[ ! -f "$VAULT_HOME/stack/stack.env" ]]; then
	cp "$OP_HOME/vault/stack.env.example" "$VAULT_HOME/stack/stack.env"
	chmod 600 "$VAULT_HOME/stack/stack.env"
fi

if [[ ! -f "$OP_CONFIG_HOME/components/core.yml" ]]; then
	cp "$OP_HOME/.openpalm/stack/core.compose.yml" "$OP_CONFIG_HOME/components/core.yml"
fi

if [[ -f "$OP_HOME/image-cache/openpalm-images.tar.zst" && ! -f /var/lib/openpalm/.images-loaded ]]; then
	zstd -dc "$OP_HOME/image-cache/openpalm-images.tar.zst" | docker load
	touch /var/lib/openpalm/.images-loaded
fi

cd "$OP_CONFIG_HOME"
docker compose \
	--env-file "$VAULT_HOME/stack/stack.env" \
	--env-file "$VAULT_HOME/user/user.env" \
	-f "$OP_CONFIG_HOME/components/core.yml" up -d
