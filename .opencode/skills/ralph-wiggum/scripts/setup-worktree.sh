#!/bin/bash

# Worktree Setup Script
# Creates a git worktree for isolated task implementation.
# The worktree path and branch are output to stdout for capture by callers.
# The ralph-wiggum plugin manages session-to-worktree mapping via
# .opencode/worktrees.local.json (written by the plugin, not this script).

set -euo pipefail

LABEL="${1:-tasks}"

# Normalise label for use in a branch name (lowercase, replace spaces/special chars with dashes)
SLUG="$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/-\+/-/g' | sed 's/^-//;s/-$//')"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BRANCH="task-impl/${SLUG}-${TIMESTAMP}"

# Resolve repo root (works even if called from a sub-directory)
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/${BRANCH//\//-}"

# Create the worktree on a new branch.
# IMPORTANT: keep stdout reserved for the final machine-readable path so callers
# can safely capture WORKTREE without parsing git/human output.
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_DIR" >&2

cat >&2 <<EOF

Git worktree created
   Branch:   $BRANCH
   Path:     $WORKTREE_DIR

All implementation work should happen inside the worktree path above.
When the task list is complete, open a pull request from $BRANCH -> main.

To remove the worktree later:
  git worktree remove "$WORKTREE_DIR"
  git branch -d "$BRANCH"

EOF

echo "$WORKTREE_DIR"
