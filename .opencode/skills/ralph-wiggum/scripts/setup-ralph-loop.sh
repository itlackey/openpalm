#!/bin/bash

# Ralph Loop Setup Script
# Creates state file for in-session Ralph loop

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
MAX_ITERATIONS=0
COMPLETION_PROMISE="null"
WORKTREE=""

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

	# Worktree mode: state file lives inside the worktree
	STATE_DIR="${WORKTREE}/.opencode"
else
	# Default: state file at repo root
	STATE_DIR=".opencode"
fi

# Create state file for the ralph-wiggum OpenCode plugin (markdown with YAML frontmatter)
mkdir -p "$STATE_DIR"

# Quote completion promise for YAML if it contains special chars or is not null
if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
	COMPLETION_PROMISE_YAML="\"$COMPLETION_PROMISE\""
else
	COMPLETION_PROMISE_YAML="null"
fi

STATE_FILE="${STATE_DIR}/ralph-loop.local.md"

cat >"$STATE_FILE" <<EOF
---
active: true
session_id: null
iteration: 0
max_iterations: $MAX_ITERATIONS
completion_promise: $COMPLETION_PROMISE_YAML
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---

$PROMPT
EOF

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
