#!/usr/bin/env bash
#
# Run all 6 test tiers, repeated N times.
# Aborts on first failure.
#
# Tier definitions are owned by scripts/test-tier.sh — this script is a
# multi-run wrapper that delegates to that single source of truth.
#
# Usage: ./scripts/run-all-tiers.sh [REPEAT_COUNT] [--skip-first-build]
#
#   REPEAT_COUNT       Number of full passes (default: 3)
#   --skip-first-build Skip rebuilding the dev stack on the first run
#                      (Tier 5/6 still rebuild on subsequent runs because
#                      test-tier.sh always rebuilds for stack-dependent tiers)
#
set -euo pipefail

REPEATS="${1:-3}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOGDIR="$ROOT_DIR/.dev/test-logs"
mkdir -p "$LOGDIR"

TIERS=(1 2 3 4 5 6)

tier_pass() { echo "  ✓ TIER $1 PASSED"; }
tier_fail() {
	echo "  ✗ TIER $1 FAILED"
	echo "  Log: $2"
	exit 1
}

run_tier() {
	local tier="$1" logfile="$2"
	if ./scripts/test-tier.sh "$tier" >"$logfile" 2>&1; then
		tier_pass "$tier"
	else
		tier_fail "$tier" "$logfile"
	fi
}

for run in $(seq 1 "$REPEATS"); do
	echo ""
	echo "╔══════════════════════════════════════════════════╗"
	echo "║        RUN $run / $REPEATS                              ║"
	echo "╚══════════════════════════════════════════════════╝"
	echo ""

	LOGPREFIX="$LOGDIR/run${run}"

	for tier in "${TIERS[@]}"; do
		echo "── Tier $tier ──"
		run_tier "$tier" "${LOGPREFIX}-tier${tier}.log"
	done

	echo ""
	echo "══════════════════════════════════════════════════"
	echo "  RUN $run / $REPEATS: ALL ${#TIERS[@]} TIERS PASSED"
	echo "══════════════════════════════════════════════════"
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ALL $REPEATS RUNS PASSED — ALL ${#TIERS[@]} TIERS EACH        ║"
echo "╚══════════════════════════════════════════════════╝"
