#!/usr/bin/env bash
# Bump the "version" field in platform package.json files only.
# Platform packages = root, core/admin, core/guardian, core/cli.
# npm packages (channels-sdk, channel-*, assistant-tools) are versioned
# independently via their own publish workflows.
#
# Usage: ./scripts/bump-platform.sh 0.8.0
set -euo pipefail

VERSION="${1:?Usage: bump-platform.sh <version>}"

if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Platform manifests — these ship as Docker images or CLI binaries and
# share a single coordinated version number.
MANIFESTS=(
  package.json
  core/admin/package.json
  core/guardian/package.json
  core/cli/package.json
)

for manifest in "${MANIFESTS[@]}"; do
  file="${ROOT}/${manifest}"
  if [ ! -f "${file}" ]; then
    echo "skip (not found): ${manifest}"
    continue
  fi

  # Only update the version field — leave dependency references untouched
  # so npm packages keep their own independent versions.
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('${file}', 'utf-8'));
    pkg.version = '${VERSION}';
    fs.writeFileSync('${file}', JSON.stringify(pkg, null, 2) + '\n');
  "

  echo "  ${manifest} → ${VERSION}"
done

echo "Platform versions set to ${VERSION}"
