#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: smoke-lean-image.sh IMAGE assistant|guardian|portal}
kind=${2:?usage: smoke-lean-image.sh IMAGE assistant|guardian|portal}
root=$(mktemp -d)
container="openpalm-${kind}-smoke-$$"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	rm -rf "$root"
}
trap cleanup EXIT

wait_for_health() {
	local deadline=$((SECONDS + 90))
	while ((SECONDS < deadline)); do
		status=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
		case "$status" in
		healthy) return 0 ;;
		unhealthy | exited | dead)
			docker logs "$container" >&2
			return 1
			;;
		esac
		sleep 1
	done
	docker logs "$container" >&2
	echo "Timed out waiting for $kind image health" >&2
	return 1
}

case "$kind" in
assistant)
	mkdir -p \
		"$root/data/.cache/opencode" \
		"$root/data/.config/opencode" \
		"$root/data/.local/share/opencode" \
		"$root/data/.local/state/opencode" \
		"$root/knowledge/secrets" \
		"$root/workspace" \
		"$root/config"
	cp -R packages/skeleton/system/assistant "$root/system"
	cp -R packages/skeleton/config/assistant/. "$root/config/"
	cp packages/skeleton/config/akm/config.json "$root/akm.json"
	printf '%s\n' 'assistant-smoke-password-0000000000000000' >"$root/password"
	printf '%s\n' '{}' >"$root/knowledge/secrets/auth.json"
	chmod -R a+rwX "$root/data" "$root/knowledge" "$root/workspace"
	docker run -d --name "$container" \
		-e OPENCODE_SERVER_PASSWORD_FILE=/run/openpalm/password \
		-v "$root/data:/home/opencode" \
		-v "$root/system:/etc/opencode:ro" \
		-v "$root/config:/home/opencode/.config/opencode:ro" \
		-v "$root/akm.json:/etc/akm/config.json:ro" \
		-v "$root/knowledge:/stash" \
		-v "$root/knowledge/secrets/auth.json:/home/opencode/.local/share/opencode/auth.json" \
		-v "$root/workspace:/work" \
		-v "$root/password:/run/openpalm/password:ro" \
		"$image" >/dev/null
	wait_for_health
	docker exec "$container" curl -sf -u 'opencode:assistant-smoke-password-0000000000000000' http://127.0.0.1:4096/config >/dev/null
	docker exec "$container" sh -c \
		'command -v akm >/dev/null && command -v opencode >/dev/null && command -v supercronic >/dev/null && test -x /usr/local/bin/openpalm-task && test -r /opt/openpalm/tools/node_modules/akm-opencode/dist/index.js'
	;;
guardian)
	mkdir -p "$root/credentials/owner" "$root/config" "$root/logs" "$root/workspace" "$root/auth"
	cp -R packages/skeleton/system/guardian "$root/system"
	cp -R packages/skeleton/config/guardian/. "$root/config/"
	printf '%s\n' 'guardian-smoke-password-0000000000000000' >"$root/password"
	printf '%s\n' 'guardian-smoke-handle-key-000000000000000' >"$root/handle"
	printf '%s\n' 'guardian-smoke-credential-000000000000000' >"$root/credentials/owner/key"
	printf '%s\n' '{"version":1,"credentials":[{"username":"owner","id":"owner","policy":"read"}]}' >"$root/credentials/registry.json"
	printf '%s\n' '{}' >"$root/auth/auth.json"
	chmod -R a+rwX "$root/logs"
	docker run -d --name "$container" \
		-e GUARDIAN_AUTH_DIR=/run/openpalm-credentials \
		-e GUARDIAN_HANDLE_KEY_FILE=/run/openpalm/handle \
		-e OPENCODE_SERVER_PASSWORD_FILE=/run/openpalm/password \
		-e GUARDIAN_OAUTH_CONFIG_FILE=/opt/openpalm/guardian/.config/opencode/oauth.json \
		-e GUARDIAN_OAUTH_IDENTITIES_FILE=/opt/openpalm/guardian/.config/opencode/oauth-identities.json \
		-v "$root/credentials:/run/openpalm-credentials:ro" \
		-v "$root/system:/opt/openpalm/moderator-config:ro" \
		-v "$root/config:/opt/openpalm/guardian/.config/opencode:ro" \
		-v "$root/auth/auth.json:/opt/openpalm/guardian/.local/share/opencode/auth.json:ro" \
		-v "$root/logs:/opt/openpalm/logs" \
		-v "$root/workspace:/work:ro" \
		-v "$root/password:/run/openpalm/password:ro" \
		-v "$root/handle:/run/openpalm/handle:ro" \
		"$image" >/dev/null
	wait_for_health
	docker exec "$container" curl -sf http://127.0.0.1:8080/health >/dev/null
	status=$(docker exec "$container" curl -sS -o /dev/null -w '%{http_code}' -X POST \
		http://127.0.0.1:8080/mcp -H 'content-type: application/json' \
		--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
	test "$status" = 401
	docker exec "$container" curl -sf -X POST http://127.0.0.1:8080/mcp \
		-H 'content-type: application/json' \
		-H 'accept: application/json, text/event-stream' \
		-H 'authorization: Bearer guardian-smoke-credential-000000000000000' \
		--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' >/dev/null
	;;
portal)
	docker run --rm --entrypoint sh "$image" -c \
		'test "$(id -u)" != 0 && test -r /app/src/index.ts && command -v bun >/dev/null && command -v curl >/dev/null'
	if docker run --name "$container" "$image" >/dev/null 2>&1; then
		echo 'Portal image started without selecting a guarded adapter' >&2
		exit 1
	fi
	;;
*)
	echo "Unknown image kind: $kind" >&2
	exit 1
	;;
esac
