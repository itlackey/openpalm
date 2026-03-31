#!/usr/bin/env bash
# Bump the "version" field in platform package.json files only.
# Platform package manifests are sourced from
# .github/release-package-groups.json -> platformManifests.
# Independent npm packages (channel-*, assistant-tools, admin-tools) are
# published by their own workflows.
#
# Usage: ./scripts/bump-platform.sh 0.8.0
set -euo pipefail

VERSION="${1:?Usage: bump-platform.sh <version>}"

if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

GROUPS_JSON="${ROOT}/.github/release-package-groups.json"
if [ ! -f "${GROUPS_JSON}" ]; then
  echo "Error: missing ${GROUPS_JSON}" >&2
  exit 1
fi

mapfile -t MANIFESTS < <(
  node -e "
    const fs = require('node:fs');
    const groups = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    if (!Array.isArray(groups.platformManifests)) {
      console.error('Error: platformManifests must be an array.');
      process.exit(1);
    }
    process.stdout.write(groups.platformManifests.join('\n'));
  " "${GROUPS_JSON}"
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
