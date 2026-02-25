#!/usr/bin/env bash
# Reset dev state to first-boot for manual wizard testing.
# Usage: ./dev/reset-wizard-state.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="$REPO_ROOT/.dev"

# Reset setup-state.json to first-boot
cat >"$DEV_DIR/data/admin/setup-state.json" <<'EOF'
{
  "completed": false,
  "accessScope": "host",
  "serviceInstances": {
    "openmemory": "",
    "psql": "",
    "qdrant": ""
  },
  "smallModel": {
    "endpoint": "",
    "modelId": ""
  },
  "profile": {},
  "steps": {},
  "enabledChannels": [],
  "installedExtensions": []
}
EOF

# Clear the runtime .env (removes any previously written ADMIN_TOKEN etc.)
cat >"$DEV_DIR/state/.env" <<'EOF'
EOF

echo "State reset. Ready for wizard test run."
