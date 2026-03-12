#!/usr/bin/env bash
# Install OpenPalm git hooks for this repository.
# Run this once after cloning: ./scripts/install-hooks.sh

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="${REPO_ROOT}/scripts/hooks"
HOOKS_DEST="${REPO_ROOT}/.git/hooks"

install_hook() {
  hook_name="$1"
  hook_src="${HOOKS_SRC}/${hook_name}"
  hook_dest="${HOOKS_DEST}/${hook_name}"

  if [ ! -f "$hook_src" ]; then
    echo "install-hooks: source not found: $hook_src" >&2
    return 1
  fi

  cp "$hook_src" "$hook_dest"
  chmod +x "$hook_dest"
  echo "Installed: .git/hooks/${hook_name}"
}

install_hook pre-commit

echo ""
echo "The hook uses varlock scan when available (catches any secret format)."
echo "Run 'openpalm install' to set up varlock and required secrets files."
echo ""
echo "Done. Git hooks installed."
