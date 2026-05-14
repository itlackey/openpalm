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
echo "The pre-commit hook pattern-matches staged additions for common API key"
echo "formats (OpenAI sk-, Groq gsk_, Google AIza, raw hex64). It is a best-"
echo "effort guard — for full vault inspection, run 'openpalm scan'."
echo ""
echo "Done. Git hooks installed."
