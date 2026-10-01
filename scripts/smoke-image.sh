#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: smoke-image.sh IMAGE assistant|guardian|portal}
kind=${2:?usage: smoke-image.sh IMAGE assistant|guardian|portal}
remote=${OPENPALM_SMOKE_REMOTE:-0}
expected_bun=$(sed -nE 's/^FROM oven\/bun:([0-9.]+).*$/\1/p' "containers/$kind/Dockerfile" | head -n 1)
root=$(mktemp -d)
container="openpalm-${kind}-smoke-$$"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	# Container-owned files may be intentionally inaccessible to the host user.
	# Retain fixtures for diagnosis; disposable CI runners reclaim their temp tree.
	printf 'Smoke fixtures retained at %s\n' "$root"
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

verify_runtime_versions() {
	test "$(docker exec "$container" bun --version)" = "$expected_bun"
	if [ "$kind" = assistant ]; then
		local expected_node expected_tools
		expected_node=$(sed -nE 's/^FROM node:([0-9.]+).*$/\1/p' containers/assistant/Dockerfile)
		test "$(docker exec "$container" node --version)" = "v$expected_node"
		expected_tools=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.stringify(JSON.parse(readFileSync("containers/assistant/tools/package.json", "utf8")).dependencies));')
		docker exec -e EXPECTED_TOOLS="$expected_tools" "$container" bun -e \
			'for (const [name, expected] of Object.entries(JSON.parse(process.env.EXPECTED_TOOLS))) { const actual = (await Bun.file(`/opt/openpalm/tools/node_modules/${name}/package.json`).json()).version; if (actual !== expected) throw Error(`${name}: expected ${expected}, got ${actual}`); console.log(`${name} ${actual}`); }'
	fi
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
		--init --cap-drop=ALL --security-opt no-new-privileges:true \
		-e OPENPALM_CODEX_REMOTE="$remote" \
		-e OPENPALM_CLAUDE_REMOTE="$remote" \
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
	verify_runtime_versions
	docker exec "$container" curl -sf -u 'opencode:assistant-smoke-password-0000000000000000' http://127.0.0.1:4096/config >/dev/null
	docker exec "$container" sh -c \
		'command -v akm >/dev/null && command -v opencode >/dev/null && command -v supercronic >/dev/null && codex --version && claude --version && test -x /usr/local/bin/openpalm-remote && test -x /usr/local/bin/openpalm-remote-setup && test -x /usr/local/bin/openpalm-task && test -r /opt/openpalm/tools/node_modules/akm-opencode/dist/index.js'
	docker exec "$container" bun -e \
		'const { setupCommands } = await import("/usr/local/bin/openpalm-remote-setup"); if (typeof Bun.Terminal !== "function" || setupCommands("codex", "read-only")[0][0] !== "sandbox") throw Error("Guided native setup is unavailable");'
	docker exec "$container" claude plugin validate /akm-marketplace/claude --strict
	docker exec "$container" claude plugin list --json | docker exec -i "$container" bun -e \
		'const plugins = await Bun.stdin.json(); const version = (await Bun.file("/opt/openpalm/tools/package.json").json()).dependencies["akm-opencode"]; if (!plugins.some(p => p.id === "akm@akm-plugins" && p.enabled && p.version === version)) throw Error("Claude AKM plugin not loaded");'
	docker exec "$container" claude plugin details akm
	docker exec "$container" codex plugin list --json | docker exec -i "$container" bun -e \
		'const plugins = await Bun.stdin.json(); const version = (await Bun.file("/opt/openpalm/tools/package.json").json()).dependencies["akm-opencode"]; if (!plugins.installed.some(p => p.pluginId === "akm@akm-plugins" && p.enabled && p.version === version)) throw Error("Codex AKM plugin not installed/enabled");'
	docker cp scripts/smoke-akm-harnesses.mjs "$container:/tmp/smoke-akm-harnesses.mjs"
	docker exec "$container" bun /tmp/smoke-akm-harnesses.mjs
	# An image upgrade refreshes only untouched native installer output. A native
	# user's settings and hook-trust state must survive without merging formats.
	docker exec "$container" bun -e '
		const {readFileSync, writeFileSync, cpSync} = await import("node:fs");
		const home = "/home/opencode";
		const registry = `${home}/.claude/plugins/installed_plugins.json`;
		const previous = `${home}/.openpalm-native-defaults/claude/plugins/installed_plugins.json`;
		const installed = JSON.parse(readFileSync(registry, "utf8"));
		installed.plugins["akm@akm-plugins"][0].version = "0.0.0";
		writeFileSync(registry, JSON.stringify(installed)); cpSync(registry, previous);
		const settings = `${home}/.claude/settings.json`;
		const value = JSON.parse(readFileSync(settings, "utf8")); value.language = "English";
		writeFileSync(settings, JSON.stringify(value));
		const config = `${home}/.codex/config.toml`;
		writeFileSync(config, `${readFileSync(config, "utf8")}\n# user hook-trust preferences retained\n`);
		writeFileSync("/tmp/native-user-settings.json", JSON.stringify([readFileSync(settings,"utf8"), readFileSync(config,"utf8")]));'
	docker restart "$container" >/dev/null
	wait_for_health
	docker exec "$container" bun -e '
		const {readFileSync} = await import("node:fs");
		const home = "/home/opencode";
		const [claude, codex] = JSON.parse(readFileSync("/tmp/native-user-settings.json", "utf8"));
		if (claude !== readFileSync(`${home}/.claude/settings.json`, "utf8") || codex !== readFileSync(`${home}/.codex/config.toml`, "utf8")) throw Error("Native user settings overwritten");
		if (readFileSync(`${home}/.claude/plugins/installed_plugins.json`, "utf8") !== readFileSync("/native-defaults/claude/plugins/installed_plugins.json", "utf8")) throw Error("Untouched native plugin defaults did not refresh");'
	# Upstream hooks invoke Bun directly; do not let workspace .env files inject
	# credentials into those subprocesses.
	printf '%s\n' 'OPENPALM_PLUGIN_ENV_SENTINEL=must-not-load' >"$root/workspace/.env"
	docker exec --workdir /work "$container" bun -e \
		'if (process.env.OPENPALM_PLUGIN_ENV_SENTINEL) throw Error("Workspace .env loaded");'
	if [ "$remote" = 1 ]; then
		# This fixture has no vendor account. Both workers must fail independently
		# without exposing connection output or degrading Assistant health.
		for tool in codex claude; do
			deadline=$((SECONDS + 45))
			while [[ "$(docker exec "$container" openpalm-remote "$tool" status)" != *waiting-to-retry* ]]; do
				if ((SECONDS >= deadline)); then echo "$tool did not fail safely without login" >&2; exit 1; fi
				sleep 1
			done
			docker exec "$container" openpalm-remote "$tool" status
		done
		docker exec "$container" openpalm-healthcheck
		logs=$(docker logs "$container" 2>&1)
		if [[ "$logs" =~ (claude\.(ai|com)/code|pairingCode|manualPairingCode) ]]; then
			echo 'Native pairing output reached Docker logs' >&2; exit 1
		fi
	else
		for tool in codex claude; do
			[[ "$(docker exec "$container" openpalm-remote "$tool" status)" == *not-started* ]]
		done
	fi
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
	verify_runtime_versions
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
	test "$(docker run --rm --entrypoint bun "$image" --version)" = "$expected_bun"
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
