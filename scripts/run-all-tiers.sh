#!/usr/bin/env bash
#
# Run all 6 test tiers, repeated N times.
# Aborts on first failure.
#
# Usage: ./scripts/run-all-tiers.sh [REPEAT_COUNT] [--skip-first-build]
#
set -euo pipefail

REPEATS="${1:-3}"
SKIP_FIRST_BUILD=0
for arg in "$@"; do
	case "$arg" in
	--skip-first-build) SKIP_FIRST_BUILD=1 ;;
	esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOGDIR="$ROOT_DIR/.dev/test-logs"
mkdir -p "$LOGDIR"

tier_pass() { echo "  ✓ TIER $1 PASSED ($2)"; }
tier_fail() {
	echo "  ✗ TIER $1 FAILED ($2)"
	echo "  Log: $3"
	exit 1
}

for run in $(seq 1 "$REPEATS"); do
	echo ""
	echo "╔══════════════════════════════════════════════════╗"
	echo "║        RUN $run / $REPEATS                              ║"
	echo "╚══════════════════════════════════════════════════╝"
	echo ""

	LOGPREFIX="$LOGDIR/run${run}"

	# ── Tier 1: Type Checking ──────────────────────────────
	echo "── Tier 1: Type Checking & Linting ──"
	LOGFILE="${LOGPREFIX}-tier1.log"
	if bun run check >"$LOGFILE" 2>&1; then
		tier_pass 1 "type check"
	else
		tier_fail 1 "type check" "$LOGFILE"
	fi

	# ── Tier 2: Unit Tests ─────────────────────────────────
	echo "── Tier 2: Unit Tests ──"
	LOGFILE="${LOGPREFIX}-tier2.log"
	if (bun run test && bun run admin:test:unit) >"$LOGFILE" 2>&1; then
		tier_pass 2 "unit tests"
	else
		tier_fail 2 "unit tests" "$LOGFILE"
	fi

	# ── Tier 6: Full Dev E2E (builds fresh stack) ──────────
	echo "── Tier 6: Full Dev E2E ──"
	LOGFILE="${LOGPREFIX}-tier6.log"
	BUILD_FLAG=""
	if [ "$run" -gt 1 ] || [ "$SKIP_FIRST_BUILD" -eq 1 ]; then
		BUILD_FLAG="--skip-build"
	fi
	if ./scripts/dev-e2e-test.sh $BUILD_FLAG >"$LOGFILE" 2>&1; then
		tier_pass 6 "dev e2e"
	else
		tier_fail 6 "dev e2e" "$LOGFILE"
	fi

	# ── Tier 3: Mocked Browser Tests ──────────────────────
	echo "── Tier 3: Mocked Browser Tests ──"
	LOGFILE="${LOGPREFIX}-tier3.log"
	if bun run admin:test:e2e:mocked >"$LOGFILE" 2>&1; then
		tier_pass 3 "mocked e2e"
	else
		tier_fail 3 "mocked e2e" "$LOGFILE"
	fi

	# ── Tier 4-5: Stack + LLM Integration ─────────────────
	echo "── Tier 4-5: Stack + LLM Integration ──"
	LOGFILE="${LOGPREFIX}-tier4-5.log"
	if bun run admin:test:e2e >"$LOGFILE" 2>&1; then
		tier_pass "4-5" "stack + LLM integration"
	else
		tier_fail "4-5" "stack + LLM integration" "$LOGFILE"
	fi

	echo ""
	echo "══════════════════════════════════════════════════"
	echo "  RUN $run / $REPEATS: ALL 6 TIERS PASSED"
	echo "══════════════════════════════════════════════════"
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ALL $REPEATS RUNS PASSED — ALL 6 TIERS EACH        ║"
echo "╚══════════════════════════════════════════════════╝"
