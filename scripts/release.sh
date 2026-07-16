#!/usr/bin/env bash
# Thin wrapper that dispatches the release workflow (.github/workflows/release.yml).
#
# The orchestrator (`release.yml`, name "Release") owns the ENTIRE release for a
# deployment UNIT: it bumps versions, stamps setup scripts, runs the
# test/regression gates, builds + pushes Docker images, publishes the npm DAG,
# builds the CLI + desktop archives, and tags + creates the GitHub release — all
# on the ref you pass. This script just validates inputs and dispatches that
# workflow, so there is one source of truth for the release process.
#
# UNIT selects the slice to release (see release.yml for the full descriptions):
#   platform | portals | assistant | guardian | images | electron | all
# `all` is the COMPLETE coordinated release; every other unit is PARTIAL by design.
#
# For fine-grained control (bump type, image/electron toggles), call the workflow
# directly, e.g.:
#   gh workflow run release.yml --ref main \
#     -f unit=platform -f version=0.12.0 -f include_images=true -f dry_run=true
#
# Usage:
#   ./scripts/release.sh <unit> <version> [ref]
#   DRY_RUN=1 ./scripts/release.sh all 0.12.0            # validate-only workflow run
#
# Examples:
#   ./scripts/release.sh all 0.12.0                       # full release of current branch
#   ./scripts/release.sh platform 0.12.0 release/0.12.0   # platform slice off a specific ref
#
# See docs/operations/release-management.md for the full process.
set -euo pipefail

UNIT="${1:?Usage: release.sh <unit> <version> [ref]}"
VERSION="${2:?Usage: release.sh <unit> <version> [ref]}"
REF="${3:-$(git rev-parse --abbrev-ref HEAD)}"
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

# --- Validate unit against release.yml's choice list ---
case "${UNIT}" in
  platform|portals|assistant|guardian|images|electron|all) ;;
  *)
    echo "Error: unit must be one of platform|portals|assistant|guardian|images|electron|all, got '${UNIT}'" >&2
    exit 1
    ;;
esac

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
echo "  unit:    ${UNIT}" >&2
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

# The target ref to release IS the dispatch ref (`--ref`): release.yml runs on it
# and releases it. `bump` is passed explicitly because release.yml declares it
# required — its value is ignored whenever `version` is set (as it always is
# here), so `patch` is inert.
gh workflow run "release.yml" \
  --ref "${REF}" \
  -f unit="${UNIT}" \
  -f bump=patch \
  -f version="${VERSION}" \
  -f dry_run="${DRY_RUN_INPUT}"

echo ""
echo "Release ${VERSION} (unit=${UNIT}) dispatched for ref '${REF}' (dry_run=${DRY_RUN_INPUT})."
echo "  Monitor: gh run list --workflow release.yml --limit 5"
echo "  Watch:   gh run watch \$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
