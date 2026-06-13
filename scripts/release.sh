#!/usr/bin/env bash
# Bump platform versions, commit, push the CURRENT branch, and tag a release.
# Platform packages (defined in .github/release-package-groups.json plus Docker
# images) share a single coordinated version. Portal adapters and the guardian
# OpenAI-compatible API are part of that coordinated platform release.
#
# The tag triggers the platform release workflow (Docker images, CLI binaries, GitHub release).
# See docs/operations/release-management.md for the full process.
#
# Usage: ./scripts/release.sh 0.7.2
#        ./scripts/release.sh 0.8.0-rc1
set -euo pipefail

VERSION="${1:?Usage: release.sh <version>}"
TAG="v${VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

# --- Validate semver ---
if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

# --- Preflight checks ---
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash changes first." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo ""
echo "This will commit the release prep and push directly to '${CURRENT_BRANCH}'," >&2
echo "then dispatch platform-release.yml for ref '${CURRENT_BRANCH}'." >&2
echo "Ensure branch protection allows direct pushes for your account." >&2
echo ""
# Skip the prompt in non-interactive shells (CI) or when RELEASE_YES=1.
if [[ -t 0 && "${RELEASE_YES:-}" != "1" ]]; then
  read -r -p "Continue? [y/N] " confirm
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# --- Bump platform versions ---
echo "Bumping platform packages to ${VERSION}..."
./scripts/bump-platform.sh "${VERSION}"

# --- Stamp install-script versions ---
# The platform release workflow verifies these setup-script versions against the
# requested release version. Stamp them here so the dispatched workflow sees a
# coherent worktree.
echo "Stamping setup scripts to ${VERSION}..."
sed -i "s/^SCRIPT_VERSION=\".*\"/SCRIPT_VERSION=\"${VERSION}\"/" scripts/setup.sh
sed -i "s/^\$ScriptVersion = '.*'/\$ScriptVersion = '${VERSION}'/" scripts/setup.ps1

# --- Update lockfile ---
echo "Updating lockfile..."
bun install

# --- Run tests ---
echo "Running tests..."
bun run test
bun run ui:check

# --- Commit ---
echo "Committing..."
git add -A
git commit -m "chore: release ${VERSION}"

# --- Push ---
echo "Pushing to ${CURRENT_BRANCH}..."
git push origin "${CURRENT_BRANCH}"

# --- Dispatch platform release workflow ---
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required to dispatch platform-release.yml" >&2
  exit 1
fi

echo "Dispatching platform-release.yml..."
gh workflow run "platform-release.yml" --ref main -f version="${VERSION}" -f ref="${CURRENT_BRANCH}" -f dry_run=false

echo ""
echo "Release ${VERSION} initiated."
echo "  Workflow:       platform-release.yml"
echo "  Release ref:    ${CURRENT_BRANCH}"
echo "  npm packages:   platform packages via the platform release workflow; full/host releases include @openpalm/ui"
echo "  Monitor:        gh run list --limit 10"
