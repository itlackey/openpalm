#!/usr/bin/env bash
# Bump the "version" field in every workspace package.json to the given semver.
# Usage: ./scripts/bump-versions.sh 0.6.0
set -euo pipefail

VERSION="${1:?Usage: bump-versions.sh <version>}"

if ! echo "${VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "Error: version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${VERSION}'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Build manifest list dynamically from workspace entries in root package.json
MANIFESTS=(package.json)
while IFS= read -r ws; do
  MANIFESTS+=("${ws}/package.json")
done < <(node -e "
  const pkg = JSON.parse(require('fs').readFileSync('${ROOT}/package.json', 'utf-8'));
  (pkg.workspaces || []).forEach(w => console.log(w));
")

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
