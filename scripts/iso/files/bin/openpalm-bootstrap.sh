#!/usr/bin/env bash
set -euo pipefail

# ISO bootstrap — single OP_HOME layout, no split roots.
# All state lives under /var/lib/openpalm/ with the standard v0.11.0
# subdirectory structure: config/, stash/, state/, cache/, workspace/.

export OP_HOME='/var/lib/openpalm'
INSTALL_HOME='/opt/openpalm'

mkdir -p \
	"$OP_HOME/config/stack" \
	"$OP_HOME/stash/vaults/secrets" \
	"$OP_HOME/config/assistant" \
	"$OP_HOME/config/akm" \
	"$OP_HOME/stash/vaults" \
	"$OP_HOME/state/assistant" \
	"$OP_HOME/state/guardian" \
	"$OP_HOME/cache/akm/data" \
	"$OP_HOME/cache/akm/state" \
	"$OP_HOME/cache/akm/cache" \
	"$OP_HOME/cache/logs" \
	"$OP_HOME/cache/backups" \
	"$OP_HOME/cache/rollback" \
	"$OP_HOME/workspace"

if [[ ! -f "$OP_HOME/stash/vaults/user.env" ]]; then
	touch "$OP_HOME/stash/vaults/user.env"
	chmod 600 "$OP_HOME/stash/vaults/user.env"
fi

if [[ ! -f "$OP_HOME/config/stack/stack.env" ]]; then
	touch "$OP_HOME/config/stack/stack.env"
	chmod 600 "$OP_HOME/config/stack/stack.env"
fi

chmod 700 "$OP_HOME/stash/vaults/secrets"

# Seed core compose into config/stack/ (source of truth for compose)
if [[ ! -f "$OP_HOME/config/stack/core.compose.yml" ]]; then
	cp "$INSTALL_HOME/.openpalm/config/stack/core.compose.yml" "$OP_HOME/config/stack/core.compose.yml"
fi

if [[ -f "$INSTALL_HOME/image-cache/openpalm-images.tar.zst" && ! -f "$OP_HOME/.images-loaded" ]]; then
	zstd -dc "$INSTALL_HOME/image-cache/openpalm-images.tar.zst" | docker load
	touch "$OP_HOME/.images-loaded"
fi

docker compose \
	--project-name openpalm \
	--env-file "$OP_HOME/config/stack/stack.env" \
	-f "$OP_HOME/config/stack/core.compose.yml" up -d
