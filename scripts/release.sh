#!/usr/bin/env bash
# Thin wrapper that dispatches the release workflow (.github/workflows/release.yml).
#
# The orchestrator owns the complete product candidate, image builds, host
# assets, one GitHub Release, and the final openpalm bootstrap publication.
#
# Usage:
#   ./scripts/release.sh <version> [ref]
#   DRY_RUN=1 ./scripts/release.sh 0.13.0                 # validate-only workflow run
#
# Examples:
#   ./scripts/release.sh 0.13.0                           # full product release
#
# See docs/operations/release-management.md for the full process.
set -euo pipefail

VERSION="${1:?Usage: release.sh <version> [ref]}"
REF="${2:-$(git rev-parse --abbrev-ref HEAD)}"
# In a detached-HEAD checkout (e.g. right after `git checkout <tag>`),
# `--abbrev-ref HEAD` prints the literal string "HEAD", which is not a
# dispatchable ref — fail here with a clear message instead of letting
# `gh workflow run --ref HEAD` die opaquely after the confirm prompt.
if [[ "${REF}" == "HEAD" ]]; then
  echo "Error: detached HEAD — pass an explicit branch or tag name as the third argument" >&2
  exit 1
fi
DRY_RUN_INPUT="false"
[[ "${DRY_RUN:-}" == "1" ]] && DRY_RUN_INPUT="true"

# --- Validate semver ---
if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: the gh CLI is required to dispatch release.yml" >&2
  exit 1
fi

echo "" >&2
echo "Dispatching release.yml:" >&2
echo "  version: ${VERSION}" >&2
echo "  ref:     ${REF}     (the workflow bumps, tests, builds, and tags this ref)" >&2
echo "  dry_run: ${DRY_RUN_INPUT}" >&2
echo "" >&2
# Skip the prompt in non-interactive shells (CI) or when RELEASE_YES=1.
if [[ -t 0 && "${RELEASE_YES:-}" != "1" ]]; then
  read -r -p "Continue? [y/N] " confirm
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

gh workflow run "release.yml" \
  --ref "${REF}" \
  -f version="${VERSION}" \
  -f dry_run="${DRY_RUN_INPUT}"

echo ""
echo "Release ${VERSION} dispatched for ref '${REF}' (dry_run=${DRY_RUN_INPUT})."
echo "  Monitor: gh run list --workflow release.yml --limit 5"
echo "  Watch:   gh run watch \$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
