#!/bin/sh
# Documentation lint checks -- run from pre-commit hook and CI.
# Exit non-zero if documentation invariants are violated.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
EXIT=0

# --- api-reference.md must document key admin endpoints ---
API_REF="$REPO_ROOT/dev/docs/api-reference.md"
if [ -f "$API_REF" ]; then
	for endpoint in "/setup/status" "/containers" "/state" "/secrets" "/stack/spec" "/stack/apply" "/channels" "/health"; do
		if ! grep -qF "$endpoint" "$API_REF"; then
			echo "ERROR: $API_REF missing documentation for $endpoint"
			EXIT=1
		fi
	done
fi

# --- README must not reference npx/bunx install paths ---
README="$REPO_ROOT/README.md"
if [ -f "$README" ]; then
	if grep -qE 'npx |npx@' "$README"; then
		echo "ERROR: README.md references npx (ISSUE-5 violation)"
		EXIT=1
	fi
	if grep -qE 'bunx |bunx@' "$README"; then
		echo "ERROR: README.md references bunx (ISSUE-5 violation)"
		EXIT=1
	fi
	if ! grep -qF 'curl -fsSL' "$README"; then
		echo "ERROR: README.md missing curl install instructions"
		EXIT=1
	fi
	if ! grep -qF 'install.sh' "$README"; then
		echo "ERROR: README.md missing install.sh reference"
		EXIT=1
	fi
fi

exit $EXIT
