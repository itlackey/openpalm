#!/usr/bin/env bash
# Bump the "version" field in every workspace package.json to the given semver.
# Usage: ./scripts/bump-versions.sh 0.6.0
set -euo pipefail

VERSION="${1:?Usage: bump-versions.sh <version>}"

if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be semver (e.g. 1.2.3), got '${VERSION}'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Every package.json that carries a version field
MANIFESTS=(
  package.json
  core/admin/package.json
  core/guardian/package.json
  packages/lib/package.json
  channels/chat/package.json
  channels/api/package.json
  channels/discord/package.json
  channels/base/package.json
)

for manifest in "${MANIFESTS[@]}"; do
  file="${ROOT}/${manifest}"
  if [ ! -f "${file}" ]; then
    echo "skip (not found): ${manifest}"
    continue
  fi

  # Replace the top-level "version" field in-place
  tmp=$(mktemp)
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('${file}', 'utf-8'));
    pkg.version = '${VERSION}';
    fs.writeFileSync('${file}', JSON.stringify(pkg, null, 2) + '\n');
  "
  rm -f "${tmp}"

  echo "  ${manifest} → ${VERSION}"
done

echo "All workspace versions set to ${VERSION}"
