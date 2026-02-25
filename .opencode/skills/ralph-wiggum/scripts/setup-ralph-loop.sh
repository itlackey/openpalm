#!/bin/bash

# Ralph Loop Setup Script
# Creates state file for in-session Ralph loop

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
MAX_ITERATIONS=0
COMPLETION_PROMISE="null"
WORKTREE=""
SESSION_PENDING="__PENDING_CLAIM__"
REGISTRY_PENDING_PREFIX="pending:"
SESSION_ID_ARG=""

resolve_worktree_path() {
	local raw="$1"
	local abs=""
	if [[ -z "$raw" ]]; then
		echo ""
		return 0
	fi

	# Fast path: exact input is already a directory
	if [[ -d "$raw" ]]; then
		abs="$(cd "$raw" && pwd -P)"
		echo "$abs"
		return 0
	fi

	# Recovery path: command substitution may include extra lines. Select the last
	# non-empty line that resolves to a directory.
	local candidate=""
	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		if [[ -d "$line" ]]; then
			candidate="$line"
		fi
	done <<<"$raw"

	if [[ -n "$candidate" ]]; then
		abs="$(cd "$candidate" && pwd -P)"
		echo "$abs"
		return 0
	fi

	echo ""
	return 0
}

upsert_pending_registry_entry() {
	local repo_root="$1"
	local worktree_path="$2"
	local iteration="$3"
	local started_at="$4"
	local session_key="$5"

	[[ -z "$worktree_path" ]] && return 0

	local branch
	branch="$(git -C "$worktree_path" branch --show-current 2>/dev/null || true)"
	if [[ -z "$branch" ]]; then
		branch="task-impl/unknown"
	fi

	local registry_dir="${repo_root}/.opencode"
	local registry_path="${registry_dir}/worktrees.local.json"
	mkdir -p "$registry_dir"

	local temp_file
	temp_file="$(mktemp)"

	python3 - "$registry_path" "$temp_file" "$REGISTRY_PENDING_PREFIX" "$worktree_path" "$branch" "$iteration" "$started_at" "$session_key" <<'PY'
import json
import os
import sys

registry_path = sys.argv[1]
temp_path = sys.argv[2]
prefix = sys.argv[3]
worktree_path = sys.argv[4]
branch = sys.argv[5]
iteration = int(sys.argv[6])
started_at = sys.argv[7]
session_key = sys.argv[8]

registry = {}
if os.path.exists(registry_path):
    try:
        with open(registry_path, "r", encoding="utf-8") as f:
            value = json.load(f)
            if isinstance(value, dict):
                registry = value
    except Exception:
        registry = {}

if not session_key:
    session_key = f"{prefix}{worktree_path}"

registry[session_key] = {
    "branch": branch,
    "path": worktree_path,
    "iteration": iteration,
    "started_at": started_at,
}

# If we now have a concrete session key, remove stale pending entries for this path.
if not session_key.startswith(prefix):
    stale = [k for k, v in registry.items() if k.startswith(prefix) and isinstance(v, dict) and v.get("path") == worktree_path]
    for key in stale:
        del registry[key]

with open(temp_path, "w", encoding="utf-8") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")
PY

	mv "$temp_file" "$registry_path"
}

resolve_session_id() {
	if [[ -n "$SESSION_ID_ARG" ]]; then
		echo "$SESSION_ID_ARG"
		return 0
	fi

	for candidate in "${OPENCODE_SESSION_ID:-}" "${SESSION_ID:-}" "${sessionID:-}"; do
		if [[ -n "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done

	# Fallback: discover session-like env vars from the current process context.
	local discovered
	discovered="$(
		python3 - <<'PY'
import os
import re

pattern = re.compile(r"session[_-]?id|session.*id", re.IGNORECASE)
candidates = []

for key, value in os.environ.items():
    if not value:
        continue
    if not pattern.search(key):
        continue
    candidates.append((key, value))

# Prefer canonical OpenCode-like IDs if present.
for _, value in candidates:
    if value.startswith("ses_"):
        print(value)
        raise SystemExit(0)

if candidates:
    print(candidates[0][1])
PY
	)"

	if [[ -n "$discovered" ]]; then
		echo "$discovered"
		return 0
	fi

	echo ""
	return 0
}

resolve_registry_root() {
	local worktree_path="$1"
	local common_dir=""
	local root=""

	if common_dir="$(git -C "$worktree_path" rev-parse --git-common-dir 2>/dev/null)"; then
		if [[ "$common_dir" != /* ]]; then
			common_dir="$(cd "$worktree_path" && cd "$common_dir" && pwd -P)"
		fi
		root="$(cd "${common_dir}/.." && pwd -P)"
		echo "$root"
		return 0
	fi

	# Fallback for non-git contexts.
	echo "$(pwd -P)"
	return 0
}

ensure_plugin_registered() {
	local config_path="$1"
	local plugin_id="./plugins/ralph-wiggum.ts"
	local config_dir
	config_dir="$(dirname "$config_path")"
	mkdir -p "$config_dir"

	python3 - "$config_path" "$plugin_id" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
plugin_id = sys.argv[2]

cfg = {}
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        value = json.load(f)
        if isinstance(value, dict):
            cfg = value

plugins = cfg.get("plugin")
if not isinstance(plugins, list):
    plugins = []

if plugin_id not in plugins:
    plugins.append(plugin_id)

cfg["plugin"] = plugins

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
}

ensure_plugin_registered_for_context() {
	local repo_root="$1"
	local worktree_path="${2:-}"

	ensure_plugin_registered "${repo_root}/.opencode/opencode.json"

	if [[ -n "$worktree_path" ]]; then
		ensure_plugin_registered "${worktree_path}/.opencode/opencode.json"
	fi

	if [[ -n "${OPENCODE_CONFIG_PATH:-}" ]]; then
		ensure_plugin_registered "${OPENCODE_CONFIG_PATH}"
	fi
}

# Parse options and positional arguments
while [[ $# -gt 0 ]]; do
	case $1 in
	-h | --help)
		cat <<'HELP_EOF'
Ralph Loop - Interactive self-referential development loop

USAGE:
  /ralph-loop [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial prompt to start the loop (can be multiple words without quotes)

OPTIONS:
  --max-iterations <n>           Maximum iterations before auto-stop (default: unlimited)
  --completion-promise '<text>'  Promise phrase (USE QUOTES for multi-word)
  --worktree <path>              Create state file inside worktree instead of repo root
  --session-id <id>              Pre-claim loop for a known session ID
  -h, --help                     Show this help message

DESCRIPTION:
  Starts a Ralph Wiggum loop in your CURRENT session. The stop hook prevents
  exit and feeds your output back as input until completion or iteration limit.

  To signal completion, you must output: <promise>YOUR_PHRASE</promise>

  Use this for:
  - Interactive iteration where you want to see progress
  - Tasks requiring self-correction and refinement
  - Learning how Ralph works

EXAMPLES:
  /ralph-loop Build a todo API --completion-promise 'DONE' --max-iterations 20
  /ralph-loop --max-iterations 10 Fix the auth bug
  /ralph-loop Refactor cache layer  (runs forever)
  /ralph-loop --completion-promise 'TASK COMPLETE' Create a REST API
  /ralph-loop --worktree /abs/.worktrees/my-task Build feature X

STOPPING:
  Only by reaching --max-iterations or detecting --completion-promise
  No manual stop - Ralph runs infinitely by default!

MONITORING:
  # View current iteration:
  grep '^iteration:' .opencode/ralph-loop.local.md

  # View full state:
  head -10 .opencode/ralph-loop.local.md
HELP_EOF
		exit 0
		;;
	--max-iterations)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --max-iterations requires a number argument" >&2
			echo "" >&2
			echo "   Valid examples:" >&2
			echo "     --max-iterations 10" >&2
			echo "     --max-iterations 50" >&2
			echo "     --max-iterations 0  (unlimited)" >&2
			echo "" >&2
			echo "   You provided: --max-iterations (with no number)" >&2
			exit 1
		fi
		if ! [[ "$2" =~ ^[0-9]+$ ]]; then
			echo "Error: --max-iterations must be a positive integer or 0, got: $2" >&2
			echo "" >&2
			echo "   Valid examples:" >&2
			echo "     --max-iterations 10" >&2
			echo "     --max-iterations 50" >&2
			echo "     --max-iterations 0  (unlimited)" >&2
			echo "" >&2
			echo "   Invalid: decimals (10.5), negative numbers (-5), text" >&2
			exit 1
		fi
		MAX_ITERATIONS="$2"
		shift 2
		;;
	--completion-promise)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --completion-promise requires a text argument" >&2
			echo "" >&2
			echo "   Valid examples:" >&2
			echo "     --completion-promise 'DONE'" >&2
			echo "     --completion-promise 'TASK COMPLETE'" >&2
			echo "     --completion-promise 'All tests passing'" >&2
			echo "" >&2
			echo "   You provided: --completion-promise (with no text)" >&2
			echo "" >&2
			echo "   Note: Multi-word promises must be quoted!" >&2
			exit 1
		fi
		COMPLETION_PROMISE="$2"
		shift 2
		;;
	--worktree)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --worktree requires a path argument" >&2
			echo "" >&2
			echo "   Valid examples:" >&2
			echo "     --worktree /abs/.worktrees/my-task" >&2
			echo "     --worktree .worktrees/my-task" >&2
			exit 1
		fi
		WORKTREE="$2"
		shift 2
		;;
	--session-id)
		if [[ -z "${2:-}" ]]; then
			echo "Error: --session-id requires a value" >&2
			exit 1
		fi
		SESSION_ID_ARG="$2"
		shift 2
		;;
	*)
		# Non-option argument - collect all as prompt parts
		PROMPT_PARTS+=("$1")
		shift
		;;
	esac
done

# Join all prompt parts with spaces
PROMPT="${PROMPT_PARTS[*]}"

# Validate prompt is non-empty
if [[ -z "$PROMPT" ]]; then
	echo "Error: No prompt provided" >&2
	echo "" >&2
	echo "   Ralph needs a task description to work on." >&2
	echo "" >&2
	echo "   Examples:" >&2
	echo "     /ralph-loop Build a REST API for todos" >&2
	echo "     /ralph-loop Fix the auth bug --max-iterations 20" >&2
	echo "     /ralph-loop --completion-promise 'DONE' Refactor code" >&2
	echo "" >&2
	echo "   For all options: /ralph-loop --help" >&2
	exit 1
fi

# Determine state file location
REPO_ROOT=""
if [[ -n "$WORKTREE" ]]; then
	WORKTREE_RESOLVED="$(resolve_worktree_path "$WORKTREE")"
	if [[ -z "$WORKTREE_RESOLVED" ]]; then
		echo "Error: --worktree must point to an existing directory" >&2
		echo "" >&2
		echo "   Received value:" >&2
		printf '     %q\n' "$WORKTREE" >&2
		echo "" >&2
		echo "   Tip: capture setup-worktree output safely, for example:" >&2
		echo "     WORKTREE=\"\$(.../setup-worktree.sh \"task label\")\"" >&2
		exit 1
	fi
	if [[ "$WORKTREE_RESOLVED" != "$WORKTREE" ]]; then
		echo "Warning: normalized --worktree to '$WORKTREE_RESOLVED'" >&2
	fi
	WORKTREE="$WORKTREE_RESOLVED"
	REPO_ROOT="$(resolve_registry_root "$WORKTREE")"

	# Worktree mode: state file lives inside the worktree
	STATE_DIR="${WORKTREE}/.opencode"
else
	if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
		REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)"
	else
		REPO_ROOT="$(pwd -P)"
	fi

	# Default: state file at repo root
	STATE_DIR=".opencode"
fi

ensure_plugin_registered_for_context "$REPO_ROOT" "$WORKTREE"

# Create state file for the ralph-wiggum OpenCode plugin (markdown with YAML frontmatter)
mkdir -p "$STATE_DIR"

# Quote completion promise for YAML if it contains special chars or is not null
if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
	COMPLETION_PROMISE_YAML="\"$COMPLETION_PROMISE\""
else
	COMPLETION_PROMISE_YAML="null"
fi

STATE_FILE="${STATE_DIR}/ralph-loop.local.md"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CLAIMED_SESSION_ID="$(resolve_session_id)"
SESSION_FIELD_VALUE="$SESSION_PENDING"
REGISTRY_SESSION_KEY=""

if [[ -n "$CLAIMED_SESSION_ID" ]]; then
	SESSION_FIELD_VALUE="$CLAIMED_SESSION_ID"
	REGISTRY_SESSION_KEY="$CLAIMED_SESSION_ID"
fi

cat >"$STATE_FILE" <<EOF
---
active: true
session_id: "$SESSION_FIELD_VALUE"
iteration: 0
max_iterations: $MAX_ITERATIONS
completion_promise: $COMPLETION_PROMISE_YAML
started_at: "$STARTED_AT"
---

$PROMPT
EOF

# Seed worktree registry immediately so operators can inspect active loops before
# the first session.idle claim event occurs.
if [[ -n "$WORKTREE" ]]; then
	upsert_pending_registry_entry "$REPO_ROOT" "$WORKTREE" "0" "$STARTED_AT" "$REGISTRY_SESSION_KEY"
fi

# Output setup message
cat <<EOF
Ralph loop activated!

State file: $STATE_FILE
Iteration: 1
Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo $MAX_ITERATIONS; else echo "unlimited"; fi)
Completion promise: $(if [[ "$COMPLETION_PROMISE" != "null" ]]; then echo "${COMPLETION_PROMISE//\"/} (ONLY output when TRUE - do not lie!)"; else echo "none (runs forever)"; fi)

The ralph-wiggum plugin is now active. When the session goes idle, the SAME PROMPT
will be sent back automatically. You'll see your previous work in files, creating
a self-referential loop where you iteratively improve on the same task.

To monitor: head -10 $STATE_FILE

WARNING: This loop cannot be stopped manually! It will run infinitely
    unless you set --max-iterations or --completion-promise.
EOF

# Output the initial prompt if provided
if [[ -n "$PROMPT" ]]; then
	echo ""
	echo "$PROMPT"
fi

# Display completion promise requirements if set
if [[ "$COMPLETION_PROMISE" != "null" ]]; then
	echo ""
	echo "==============================================================="
	echo "CRITICAL - Ralph Loop Completion Promise"
	echo "==============================================================="
	echo ""
	echo "To complete this loop, output this EXACT text:"
	echo "  <promise>$COMPLETION_PROMISE</promise>"
	echo ""
	echo "STRICT REQUIREMENTS (DO NOT VIOLATE):"
	echo "  - Use <promise> XML tags EXACTLY as shown above"
	echo "  - The statement MUST be completely and unequivocally TRUE"
	echo "  - Do NOT output false statements to exit the loop"
	echo "  - Do NOT lie even if you think you should exit"
	echo ""
	echo "IMPORTANT - Do not circumvent the loop:"
	echo "  Even if you believe you're stuck, the task is impossible,"
	echo "  or you've been running too long - you MUST NOT output a"
	echo "  false promise statement. The loop is designed to continue"
	echo "  until the promise is GENUINELY TRUE. Trust the process."
	echo ""
	echo "  If the loop should stop, the promise statement will become"
	echo "  true naturally. Do not force it by lying."
	echo "==============================================================="
fi
