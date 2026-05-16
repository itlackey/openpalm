#!/usr/bin/env bash
# validate-registry.sh — CI validation for .openpalm/registry/addons/ directories.
#
# Scans .openpalm/registry/addons/ and validates each addon:
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
ADDONS_DIR="$REPO_ROOT/.openpalm/registry/addons"

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

	# Detect overlay-only addons: compose.yml that doesn't introduce a new
	# service (no `image:` and no `build:` stanza). Such addons override
	# settings on existing services and don't need .env.schema, labels,
	# healthcheck, or network membership.
	overlay_only=0
	if ! grep -qE '^[[:space:]]+(image|build):' "$compose_file"; then
		overlay_only=1
	fi

	# Vault mount violations apply to every addon (security).
	if grep -qE '^\s*-\s+.*vault(/?)"\s*:' "$compose_file" || grep -qE '^\s*-\s+.*vault(/?)\s*:/' "$compose_file"; then
		echo "  FAIL: compose.yml mounts vault directory (security violation)"
		errors=$((errors + 1))
	fi

	# Legacy ${INSTANCE_ID} pattern check applies to every addon.
	if grep -q '\${INSTANCE_ID}' "$compose_file"; then
		echo "  FAIL: compose.yml still uses \${INSTANCE_ID} — should use static service names"
		errors=$((errors + 1))
	fi

	if [ "$overlay_only" -eq 1 ]; then
		echo "  OK (overlay-only)"
		continue
	fi

	# Full addons must also have:
	if [ ! -f "$schema_file" ]; then
		echo "  FAIL: Missing .env.schema"
		errors=$((errors + 1))
		continue
	fi

	# Required labels
	if ! grep -q 'openpalm\.name:' "$compose_file"; then
		echo "  FAIL: compose.yml missing openpalm.name label"
		errors=$((errors + 1))
	fi

	if ! grep -q 'openpalm\.description:' "$compose_file"; then
		echo "  FAIL: compose.yml missing openpalm.description label"
		errors=$((errors + 1))
	fi

	# .env.schema is non-empty and parseable
	if [ ! -s "$schema_file" ]; then
		echo "  FAIL: .env.schema is empty"
		errors=$((errors + 1))
	else
		if ! grep -qE '^[A-Z_][A-Z0-9_]*=' "$schema_file"; then
			echo "  FAIL: .env.schema has no variable definitions (expected KEY=value lines)"
			errors=$((errors + 1))
		fi
	fi

	# Stack network membership
	if ! grep -qE 'channel_lan|channel_public|assistant_net' "$compose_file"; then
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
