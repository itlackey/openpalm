#!/usr/bin/env bash
# validate-registry.sh — CI validation for registry component directories.
#
# Scans registry/components/ and validates each component:
#   1. Has compose.yml + .env.schema
#   2. compose.yml has required openpalm.name and openpalm.description labels
#   3. .env.schema is parseable (non-empty, valid @env-spec comments)
#   4. No vault mount violations (no volume mounts containing "vault")
#   5. Service name follows openpalm-${INSTANCE_ID} convention
#
# Exit code: 0 on success, 1 on any validation failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY_DIR="$REPO_ROOT/registry/components"

errors=0
checked=0

if [ ! -d "$REGISTRY_DIR" ]; then
  echo "ERROR: Registry directory not found at $REGISTRY_DIR"
  exit 1
fi

for component_dir in "$REGISTRY_DIR"/*/; do
  # Skip non-directories and index.json
  [ -d "$component_dir" ] || continue

  component_id="$(basename "$component_dir")"
  compose_file="$component_dir/compose.yml"
  schema_file="$component_dir/.env.schema"

  echo "--- Validating: $component_id ---"
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

  # 3. Check compose.yml uses the service name convention
  if ! grep -q 'openpalm-\${INSTANCE_ID}' "$compose_file"; then
    echo "  FAIL: compose.yml service name must use openpalm-\${INSTANCE_ID} convention"
    errors=$((errors + 1))
  fi

  # 4. Check compose.yml uses the env_file convention
  if ! grep -q '\${INSTANCE_DIR}/.env' "$compose_file"; then
    echo "  FAIL: compose.yml must reference \${INSTANCE_DIR}/.env in env_file"
    errors=$((errors + 1))
  fi

  # 5. Check for vault mount violations — look for full vault directory mounts
  # (mounting a specific config file like vault/ov.conf:ro is allowed)
  if grep -qE '^\s*-\s+.*vault(/|")?\s*:/' "$compose_file" && ! grep -qE '^\s*-\s+.*vault/[^:]+:.*:ro' "$compose_file"; then
    echo "  FAIL: compose.yml mounts vault directory (security violation)"
    errors=$((errors + 1))
  fi

  # 6. Check .env.schema is non-empty and parseable
  if [ ! -s "$schema_file" ]; then
    echo "  FAIL: .env.schema is empty"
    errors=$((errors + 1))
  else
    # Validate basic structure: should have at least one VAR= line
    if ! grep -qE '^[A-Z_][A-Z0-9_]*=' "$schema_file"; then
      echo "  FAIL: .env.schema has no variable definitions (expected KEY=value lines)"
      errors=$((errors + 1))
    fi

    # Check for INSTANCE_ID and INSTANCE_DIR identity variables
    if ! grep -q '^INSTANCE_ID=' "$schema_file"; then
      echo "  FAIL: .env.schema missing INSTANCE_ID identity variable"
      errors=$((errors + 1))
    fi
    if ! grep -q '^INSTANCE_DIR=' "$schema_file"; then
      echo "  FAIL: .env.schema missing INSTANCE_DIR identity variable"
      errors=$((errors + 1))
    fi
  fi

  # 7. Check compose.yml joins a valid stack network (channel_lan, channel_public, or assistant_net)
  if ! grep -qE 'channel_lan|channel_public|assistant_net' "$compose_file"; then
    echo "  FAIL: compose.yml must join at least one stack network (channel_lan, channel_public, or assistant_net)"
    errors=$((errors + 1))
  fi

  echo "  OK"
done

echo ""
echo "=== Registry Validation Summary ==="
echo "Components checked: $checked"
echo "Errors found: $errors"

if [ "$checked" -eq 0 ]; then
  echo "WARNING: No component directories found in $REGISTRY_DIR"
  exit 1
fi

if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors validation error(s)"
  exit 1
fi

echo "PASSED: All components valid"
exit 0
