#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/dev-setup.sh [--enable-addon <name>]

Materialize a development home with the same 0.14 installer and control plane
used by packaged OpenPalm builds. The default is .dev; set
OPENPALM_DEV_HOME to choose another development-only location.

Options:
  --enable-addon <n>  Enable gateway, discord, or slack. Repeat as needed.
  -h, --help          Show this help.
EOF
}

enabled_addons=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--enable-addon)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --enable-addon requires a name" >&2
			exit 1
		fi
		case "$2" in
		gateway | discord | slack) enabled_addons+=("$2") ;;
		*)
			echo "Error: supported addons are gateway, discord, and slack" >&2
			exit 1
			;;
		esac
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown option: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ROOT="${OPENPALM_DEV_HOME:-$ROOT_DIR/.dev}"
CLI=(bun run packages/cli/src/main.ts)

export OP_HOME="$DEV_ROOT"
export OPENPALM_REPO_ROOT="$ROOT_DIR"

if [[ -e "$DEV_ROOT" && ! -d "$DEV_ROOT" ]]; then
	echo "Error: development home is not a directory: $DEV_ROOT" >&2
	exit 1
fi

if [[ -f "$DEV_ROOT/system/stack/stack.compose.yml" ]]; then
	"${CLI[@]}" update --no-start
elif [[ ! -d "$DEV_ROOT" || -z "$(find "$DEV_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
	"${CLI[@]}" install --no-start
else
	echo "Error: $DEV_ROOT is not an empty or compatible OpenPalm 0.14 development home." >&2
	echo "Choose a new path with OPENPALM_DEV_HOME; existing data was not changed." >&2
	exit 1
fi

# Development ports intentionally differ from the normal personal stack.
"${CLI[@]}" config assistant --bind 127.0.0.1 --port 4800 --no-apply
"${CLI[@]}" config gateway --bind 127.0.0.1 --port 4830 --no-apply

for addon in "${enabled_addons[@]}"; do
	"${CLI[@]}" addon enable "$addon" --no-apply
done

echo "Development stack ready at $DEV_ROOT"
