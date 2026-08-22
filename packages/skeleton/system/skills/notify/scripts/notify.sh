#!/usr/bin/env bash
set -euo pipefail

title="${APPRISE_NOTIFY_TITLE:-Notification}"
body=""
read_stdin=0
dry_run=0

declare -a configs=()
declare -a tags=()
declare -a attachments=()

usage() {
	cat <<'EOF'
notify - Send notifications with Apprise config tags

USAGE:
  bash scripts/notify.sh [options]

COMMON PATTERNS:
  bash scripts/notify.sh --channel ops --subject "Deploy complete" --body "Release is live"
  bash scripts/notify.sh --tag ops --tag email --subject "Deploy complete" --body "Release is live"
  some-command 2>&1 | bash scripts/notify.sh --channel alerts --subject "Command output" --stdin

OPTIONS:
  -c, --channel <tag>      Apprise tag to notify
  -g, --tag <tag>          Apprise tag filter; repeat for OR logic
  -f, --config <path>      Apprise config file; can be repeated
  -s, -t, --subject, --title <text>
                           Notification title
  -b, --body <text>        Message body
      --stdin              Read message body from stdin
      --attach <path|url>  Attachment path or URL; can be repeated
  -d, --dry-run            Resolve config and tags without sending
  -h, --help               Show this help

ENVIRONMENT:
  APPRISE_NOTIFY_CONFIG    Default config file passed to Apprise
  APPRISE_NOTIFY_TITLE     Default title if one is not provided

NOTES:
  - --channel is an alias for --tag.
  - If --config is omitted, Apprise uses its normal config search paths.
  - If --body is omitted and stdin is piped, stdin is used automatically.
  - --tag ops,critical means tag AND logic.
  - --tag ops --tag email means tag OR logic.
EOF
}

require_value() {
	local flag="$1"
	local value="${2:-}"

	if [[ -z "$value" || "$value" == -* ]]; then
		printf 'Error: %s requires a value\n' "$flag" >&2
		exit 1
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	-c | --channel)
		require_value "$1" "${2:-}"
		tags+=("$2")
		shift 2
		;;
	-g | --tag)
		require_value "$1" "${2:-}"
		tags+=("$2")
		shift 2
		;;
	-f | --config)
		require_value "$1" "${2:-}"
		configs+=("$2")
		shift 2
		;;
	-s | -t | --subject | --title)
		require_value "$1" "${2:-}"
		title="$2"
		shift 2
		;;
	-b | --body)
		require_value "$1" "${2:-}"
		body="$2"
		shift 2
		;;
	--stdin)
		read_stdin=1
		shift
		;;
	--attach)
		require_value "$1" "${2:-}"
		attachments+=("$2")
		shift 2
		;;
	-d | --dry-run)
		dry_run=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'Error: unknown option: %s\n' "$1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if ! command -v apprise >/dev/null 2>&1; then
	printf 'Error: apprise CLI not found. Install it with: pip install apprise\n' >&2
	exit 127
fi

if [[ ${#configs[@]} -eq 0 && -n "${APPRISE_NOTIFY_CONFIG:-}" ]]; then
	configs+=("${APPRISE_NOTIFY_CONFIG}")
fi

if [[ ${#tags[@]} -eq 0 ]]; then
	printf 'Error: specify at least one --channel or --tag\n' >&2
	printf 'Tip: use --channel ops for one audience, or --tag ops --tag email for OR logic\n' >&2
	exit 1
fi

if [[ $read_stdin -eq 1 || (-z "$body" && ! -t 0) ]]; then
	body="$(cat)"
fi

if [[ -z "$body" ]]; then
	printf 'Error: specify --body or pipe input with --stdin\n' >&2
	printf 'Tip: example: echo "Build failed" | bash scripts/notify.sh --channel alerts --subject "Build failure" --stdin\n' >&2
	exit 1
fi

cmd=(apprise)

for config in "${configs[@]}"; do
	cmd+=(--config "$config")
done

for tag in "${tags[@]}"; do
	cmd+=(--tag "$tag")
done

for attachment in "${attachments[@]}"; do
	cmd+=(--attach "$attachment")
done

if [[ $dry_run -eq 1 ]]; then
	cmd+=(--dry-run)
fi

cmd+=(--title "$title" --body "$body")

"${cmd[@]}"
