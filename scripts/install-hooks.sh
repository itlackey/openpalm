#!/bin/sh
# Install OpenPalm git hooks for this repository.
# Run this once after cloning: ./scripts/install-hooks.sh

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="${REPO_ROOT}/scripts/hooks"
HOOKS_DEST="${REPO_ROOT}/.git/hooks"

install_hook() {
  local name="$1"
  local src="${HOOKS_SRC}/${name}"
  local dest="${HOOKS_DEST}/${name}"

  if [ ! -f "$src" ]; then
    echo "install-hooks: source not found: $src" >&2
    return 1
  fi

  cp "$src" "$dest"
  chmod +x "$dest"
  echo "Installed: .git/hooks/${name}"
}

install_hook pre-commit

echo "Done. Git hooks installed."
