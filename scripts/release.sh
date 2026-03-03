#!/usr/bin/env bash
# Bump all workspace versions, commit, push, and tag a release.
# The push triggers npm publish workflows for all packages.
# The tag triggers the Release workflow (Docker images, CLI binaries, GitHub release).
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

# --- Bump versions ---
echo "Bumping all packages to ${VERSION}..."
./scripts/bump-versions.sh "${VERSION}"

# --- Update lockfile ---
echo "Updating lockfile..."
bun install

# --- Run tests ---
echo "Running tests..."
bun run test
bun run admin:check

# --- Commit ---
echo "Committing..."
git add -A
git commit -m "chore: release ${VERSION}"

# --- Push (triggers npm publish workflows) ---
echo "Pushing to main..."
git push origin main

# --- Tag and push (triggers Release workflow) ---
echo "Tagging ${TAG} and pushing..."
git tag "${TAG}"
git push origin "${TAG}"

echo ""
echo "Release ${VERSION} initiated."
echo "  npm publishes:  triggered by push to main"
echo "  Docker + CLI:   triggered by tag ${TAG}"
echo "  Monitor:        gh run list --limit 10"
