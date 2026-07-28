#!/usr/bin/env bash
set -euo pipefail

TIER="${1:-}"
if [[ -z "$TIER" || "$TIER" == -h || "$TIER" == --help ]]; then
  cat <<'EOF'
Usage: ./scripts/test-tier.sh <tier>

  1  Type checks
  2  Non-UI unit tests
  3  UI unit/component tests
  4  Self-contained browser tests
  5  Isolated live-stack smoke + Playwright integration tests
EOF
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$TIER" in
  1) bun run check ;;
  2) bun run test ;;
  3) bun run ui:test:unit ;;
  4) bun run ui:test:e2e:mocked ;;
  5) ./scripts/dev-e2e-test.sh --playwright ;;
  *) echo "Unknown tier: $TIER (valid: 1-5)" >&2; exit 1 ;;
esac
