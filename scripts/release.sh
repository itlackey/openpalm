#!/usr/bin/env bash
# Bump platform versions, commit, push the CURRENT branch, and tag a release.
# Platform packages (defined in .github/release-package-groups.json plus Docker
# images) share a single coordinated version. Channel adapters
# (packages/channel-*) are versioned independently via their own publish
# workflows and are NOT touched here.
#
# The tag triggers the Release workflow (Docker images, CLI binaries, GitHub release).
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

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Error: tag ${TAG} already exists." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo ""
echo "This will commit the release prep and push directly to '${CURRENT_BRANCH}'," >&2
echo "then create and push tag '${TAG}' (which triggers the Release workflow)." >&2
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
# The Release workflow's tag-push path VERIFIES (does not bump) that the setup
# scripts carry SCRIPT_VERSION == release version, and bump-platform.sh only
# touches package.json manifests. Stamp them here so the tag created below
# passes that guard. Keep these patterns in lockstep with release.yml.
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

# --- Tag and push (triggers Release workflow) ---
echo "Tagging ${TAG} and pushing..."
git tag "${TAG}"
git push origin "${TAG}"

echo ""
echo "Release ${VERSION} initiated."
echo "  Docker + CLI:   triggered by tag ${TAG}"
echo "  npm packages:   platform packages (lib, channels-sdk, openpalm CLI) via the release workflow; channel adapters publish independently via publish-channel-*.yml"
echo "  Monitor:        gh run list --limit 10"
