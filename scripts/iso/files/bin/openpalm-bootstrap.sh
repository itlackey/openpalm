#!/usr/bin/env bash
set -euo pipefail

# ISO bootstrap — single OP_HOME layout, no split roots.
# All state lives under /var/lib/openpalm/ with the standard subdirectory
# structure: config/, vault/, data/, logs/, stack/.

export OP_HOME='/var/lib/openpalm'
INSTALL_HOME='/opt/openpalm'

mkdir -p \
	"$OP_HOME/config/stash" \
	"$OP_HOME/config/automations" \
	"$OP_HOME/config/assistant" \
	"$OP_HOME/vault/stack" \
	"$OP_HOME/vault/user" \
	"$OP_HOME/data/admin" \
	"$OP_HOME/data/memory" \
	"$OP_HOME/data/assistant" \
	"$OP_HOME/data/guardian" \
	"$OP_HOME/logs" \
	"$OP_HOME/stack"

if [[ ! -f "$OP_HOME/vault/user/user.env" ]]; then
	touch "$OP_HOME/vault/user/user.env"
	chmod 600 "$OP_HOME/vault/user/user.env"
fi

if [[ ! -f "$OP_HOME/vault/stack/stack.env" ]]; then
	touch "$OP_HOME/vault/stack/stack.env"
	chmod 600 "$OP_HOME/vault/stack/stack.env"
fi

if [[ ! -f "$OP_HOME/vault/stack/guardian.env" ]]; then
	touch "$OP_HOME/vault/stack/guardian.env"
	chmod 600 "$OP_HOME/vault/stack/guardian.env"
fi

# Seed core compose into stack/ (source of truth for compose)
if [[ ! -f "$OP_HOME/stack/core.compose.yml" ]]; then
	cp "$INSTALL_HOME/.openpalm/stack/core.compose.yml" "$OP_HOME/stack/core.compose.yml"
fi

if [[ -f "$INSTALL_HOME/image-cache/openpalm-images.tar.zst" && ! -f "$OP_HOME/.images-loaded" ]]; then
	zstd -dc "$INSTALL_HOME/image-cache/openpalm-images.tar.zst" | docker load
	touch "$OP_HOME/.images-loaded"
fi

docker compose \
	--project-name openpalm \
	--env-file "$OP_HOME/vault/stack/stack.env" \
	--env-file "$OP_HOME/vault/user/user.env" \
	--env-file "$OP_HOME/vault/stack/guardian.env" \
	-f "$OP_HOME/stack/core.compose.yml" up -d
