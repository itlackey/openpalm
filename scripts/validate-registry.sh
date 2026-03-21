#!/usr/bin/env bash
# validate-registry.sh — CI validation for .openpalm/stack/addons/ directories.
#
# Scans .openpalm/stack/addons/ and validates each addon:
#   1. Has compose.yml + .env.schema
#   2. compose.yml has required openpalm.name and openpalm.description labels
#   3. compose.yml uses a static service name (not ${INSTANCE_ID})
#   4. .env.schema is parseable (non-empty, valid variable definitions)
#   5. No vault mount violations
#   6. Joins at least one stack network
#
# Exit code: 0 on success, 1 on any validation failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDONS_DIR="$REPO_ROOT/.openpalm/stack/addons"

errors=0
checked=0

if [ ! -d "$ADDONS_DIR" ]; then
  echo "ERROR: Addons directory not found at $ADDONS_DIR"
  exit 1
fi

for addon_dir in "$ADDONS_DIR"/*/; do
  # Skip non-directories
  [ -d "$addon_dir" ] || continue

  addon_id="$(basename "$addon_dir")"
  compose_file="$addon_dir/compose.yml"
  schema_file="$addon_dir/.env.schema"

  echo "--- Validating: $addon_id ---"
  checked=$((checked + 1))

  # 1. Check required files exist
  if [ ! -f "$compose_file" ]; then
    echo "  FAIL: Missing compose.yml"
    errors=$((errors + 1))
    continue
  fi

  if [ ! -f "$schema_file" ]; then
    echo "  FAIL: Missing .env.schema"
    errors=$((errors + 1))
    continue
  fi

  # 2. Check compose.yml has required labels
  if ! grep -q 'openpalm\.name:' "$compose_file"; then
    echo "  FAIL: compose.yml missing openpalm.name label"
    errors=$((errors + 1))
  fi

  if ! grep -q 'openpalm\.description:' "$compose_file"; then
    echo "  FAIL: compose.yml missing openpalm.description label"
    errors=$((errors + 1))
  fi

  # 3. Check compose.yml does NOT use legacy ${INSTANCE_ID} pattern
  if grep -q '\${INSTANCE_ID}' "$compose_file"; then
    echo "  FAIL: compose.yml still uses \${INSTANCE_ID} — should use static service names"
    errors=$((errors + 1))
  fi

  # 4. Check for vault mount violations — look for full vault directory mounts
  # (mounting a specific config file like vault/user/ov.conf:ro is allowed)
  if grep -qE '^\s*-\s+.*vault(/|")?\s*:/' "$compose_file" && ! grep -qE '^\s*-\s+.*vault/[^:]+:.*:ro' "$compose_file"; then
    echo "  FAIL: compose.yml mounts vault directory (security violation)"
    errors=$((errors + 1))
  fi

  # 5. Check .env.schema is non-empty and parseable
  if [ ! -s "$schema_file" ]; then
    echo "  FAIL: .env.schema is empty"
    errors=$((errors + 1))
  else
    # Validate basic structure: should have at least one VAR= line
    if ! grep -qE '^[A-Z_][A-Z0-9_]*=' "$schema_file"; then
      echo "  FAIL: .env.schema has no variable definitions (expected KEY=value lines)"
      errors=$((errors + 1))
    fi
  fi

  # 6. Check compose.yml joins a valid stack network (channel_lan, channel_public, or assistant_net)
  if ! grep -qE 'channel_lan|channel_public|assistant_net|admin_docker_net' "$compose_file"; then
    echo "  FAIL: compose.yml must join at least one stack network"
    errors=$((errors + 1))
  fi

  echo "  OK"
done

echo ""
echo "=== Addon Validation Summary ==="
echo "Addons checked: $checked"
echo "Errors found: $errors"

if [ "$checked" -eq 0 ]; then
  echo "WARNING: No addon directories found in $ADDONS_DIR"
  exit 1
fi

if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors validation error(s)"
  exit 1
fi

echo "PASSED: All addons valid"
exit 0
