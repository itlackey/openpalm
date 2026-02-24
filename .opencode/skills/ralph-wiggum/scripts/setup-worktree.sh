#!/bin/bash

# Worktree Setup Script
# Creates a git worktree for isolated task implementation.
# Writes the worktree path to .opencode/worktree.local.md so every
# Ralph loop iteration can navigate back to the same working tree.

set -euo pipefail

LABEL="${1:-tasks}"

# Normalise label for use in a branch name (lowercase, replace spaces/special chars with dashes)
SLUG="$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/-\+/-/g' | sed 's/^-//;s/-$//')"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BRANCH="task-impl/${SLUG}-${TIMESTAMP}"

# Resolve repo root (works even if called from a sub-directory)
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/${BRANCH//\//-}"

# Create the worktree on a new branch
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_DIR"

# Persist state so Ralph loop iterations can reference the worktree
mkdir -p "${REPO_ROOT}/.opencode"
cat > "${REPO_ROOT}/.opencode/worktree.local.md" <<EOF
---
branch: "$BRANCH"
path: "$WORKTREE_DIR"
created_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---
EOF

cat <<EOF

✅ Git worktree created
   Branch:   $BRANCH
   Path:     $WORKTREE_DIR

All implementation work should happen inside the worktree path above.
When the task list is complete, open a pull request from $BRANCH → main.

To remove the worktree later:
  git worktree remove "$WORKTREE_DIR"
  git branch -d "$BRANCH"

EOF

echo "$WORKTREE_DIR"
