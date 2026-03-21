#!/usr/bin/env bash
set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OP_HOME="${OP_HOME:-$(cd "$STACK_DIR/.." && pwd)}"
PROJECT_NAME="${OP_PROJECT_NAME:-openpalm}"

DEFAULT_ENV_FILES=(
	"$OP_HOME/vault/stack/stack.env"
	"$OP_HOME/vault/stack/services/memory/managed.env"
	"$OP_HOME/vault/user/user.env"
)

usage() {
	cat <<EOF
Usage: $0 [options] [addon ...]

Options:
  --from-stack-yaml       Load addons from $OP_HOME/config/stack.yaml
  --env-file PATH         Add a compose env file (can be used more than once)
  --project-name NAME     Set the compose project name (default: $PROJECT_NAME)
  --dry-run               Print the resolved docker compose command and exit
  --stop                  Run docker compose stop
  --down                  Run docker compose down
  --status                Run docker compose ps
  -h, --help              Show this help

Examples:
  $0
  $0 chat admin
  $0 --from-stack-yaml
  $0 --dry-run --project-name my-openpalm chat

Notes:
  - Explicit addon arguments win over --from-stack-yaml.
  - stop/down/status should use the same addon selection as up.
EOF
}

load_addons_from_stack_yaml() {
	local stack_yaml="$OP_HOME/config/stack.yaml"

	if [[ ! -f "$stack_yaml" ]]; then
		return 0
	fi

	local in_addons=0
	local line

	while IFS= read -r line; do
		if ((in_addons == 0)); then
			if [[ "$line" =~ ^addons:[[:space:]]*$ ]]; then
				in_addons=1
			fi
			continue
		fi

		if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*([A-Za-z0-9._-]+)[[:space:]]*$ ]]; then
			STACK_YAML_ADDONS+=("${BASH_REMATCH[1]}")
			continue
		fi

		if [[ "$line" =~ ^[[:space:]]*$ ]]; then
			continue
		fi

		if [[ "$line" =~ ^[[:space:]]*# ]]; then
			continue
		fi

		if [[ ! "$line" =~ ^[[:space:]] ]]; then
			break
		fi

		echo "Error: unsupported stack.yaml format near: $line" >&2
		echo "Only a simple top-level addons: list is supported." >&2
		exit 1
	done <"$stack_yaml"
}

action="up"
dry_run=0
use_stack_yaml=0
addons=()
extra_env_files=()
STACK_YAML_ADDONS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--stop | stop)
		action="stop"
		shift
		;;
	--down | down)
		action="down"
		shift
		;;
	--status | status | ps)
		action="ps"
		shift
		;;
	--dry-run)
		dry_run=1
		shift
		;;
	--from-stack-yaml)
		use_stack_yaml=1
		shift
		;;
	--project-name)
		if [[ $# -lt 2 ]]; then
			echo "Error: --project-name requires a value" >&2
			exit 1
		fi
		PROJECT_NAME="$2"
		shift 2
		;;
	--env-file)
		if [[ $# -lt 2 ]]; then
			echo "Error: --env-file requires a path" >&2
			exit 1
		fi
		extra_env_files+=("$2")
		shift 2
		;;
	--help | -h)
		usage
		exit 0
		;;
	--*)
		echo "Error: unknown option '$1'" >&2
		exit 1
		;;
	*)
		addons+=("$1")
		shift
		;;
	esac
done

if ((use_stack_yaml == 1)) && [[ ${#addons[@]} -eq 0 ]]; then
	load_addons_from_stack_yaml
	addons=("${STACK_YAML_ADDONS[@]}")
fi

if [[ "$action" != "up" && ${#addons[@]} -eq 0 && $use_stack_yaml -eq 0 ]]; then
	echo "Warning: no addons selected; $action will target the core stack only." >&2
	echo "Pass the same addons used for up, or use --from-stack-yaml." >&2
fi

compose_cmd=(docker compose --project-name "$PROJECT_NAME")

for env_file in "${DEFAULT_ENV_FILES[@]}" "${extra_env_files[@]}"; do
	if [[ -f "$env_file" ]]; then
		compose_cmd+=(--env-file "$env_file")
	fi
done

compose_cmd+=(
	-f "$STACK_DIR/core.compose.yml"
)

for addon in "${addons[@]}"; do
	addon_file="$STACK_DIR/addons/$addon/compose.yml"
	if [[ ! -f "$addon_file" ]]; then
		echo "Error: addon '$addon' not found at $addon_file" >&2
		exit 1
	fi
	compose_cmd+=(-f "$addon_file")
done

case "$action" in
up)
	compose_cmd+=(up -d)
	;;
stop)
	compose_cmd+=(stop)
	;;
down)
	compose_cmd+=(down)
	;;
ps)
	compose_cmd+=(ps)
	;;
esac

printf 'Resolved command:'
for arg in "${compose_cmd[@]}"; do
	printf ' %q' "$arg"
done
printf '\n'

if ((dry_run == 1)); then
	exit 0
fi

exec "${compose_cmd[@]}"
