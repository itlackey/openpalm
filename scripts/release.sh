#!/usr/bin/env bash
# Thin wrapper that dispatches the platform release workflow.
#
# The orchestrator (.github/workflows/platform-release.yml) owns the ENTIRE
# release: it bumps versions, stamps setup scripts, runs the test/regression
# gates, builds + pushes Docker images, publishes the npm DAG, builds the CLI +
# desktop archives, and tags + creates the GitHub release — all on the ref you
# pass. This script just validates the version and dispatches that workflow, so
# there is one source of truth for the release process.
#
# For fine-grained unit selection (host / web_ui / portals / assistant / voice),
# call the workflow directly, e.g.:
#   gh workflow run platform-release.yml --ref main \
#     -f version=0.12.0 -f ref=release/0.12.0 -f release_voice=true -f dry_run=true
#
# Usage:
#   ./scripts/release.sh <version> [ref]
#   DRY_RUN=1 ./scripts/release.sh 0.12.0           # validate-only workflow run
#
# Examples:
#   ./scripts/release.sh 0.12.0                      # release current branch
#   ./scripts/release.sh 0.12.0 release/0.12.0       # release a specific ref
#
# See docs/operations/release-management.md for the full process.
set -euo pipefail

VERSION="${1:?Usage: release.sh <version> [ref]}"
REF="${2:-$(git rev-parse --abbrev-ref HEAD)}"
DRY_RUN_INPUT="false"
[[ "${DRY_RUN:-}" == "1" ]] && DRY_RUN_INPUT="true"

# --- Validate semver ---
if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: the gh CLI is required to dispatch platform-release.yml" >&2
  exit 1
fi

echo "" >&2
echo "Dispatching platform-release.yml:" >&2
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

gh workflow run "platform-release.yml" \
  --ref main \
  -f version="${VERSION}" \
  -f ref="${REF}" \
  -f dry_run="${DRY_RUN_INPUT}"

echo ""
echo "Release ${VERSION} dispatched for ref '${REF}' (dry_run=${DRY_RUN_INPUT})."
echo "  Monitor: gh run list --workflow platform-release.yml --limit 5"
echo "  Watch:   gh run watch \$(gh run list --workflow platform-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
