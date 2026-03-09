#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# run-benchmarks.sh — Run the full benchmark suite with Python comparison
#
# Usage:
#   ./packages/memory/benchmark-tests/run-benchmarks.sh          # all
#   ./packages/memory/benchmark-tests/run-benchmarks.sh perf     # perf only
#   ./packages/memory/benchmark-tests/run-benchmarks.sh quality  # quality only
#   ./packages/memory/benchmark-tests/run-benchmarks.sh --no-python  # TS-only
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.benchmark.yaml"
# Use path within the project tree — snap-installed Docker cannot bind-mount
# files from /tmp (snap confinement silently creates directories instead).
BENCHMARK_DIR="$SCRIPT_DIR/.benchmark-data"
PYTHON_PORT=8766
PYTHON_URL="http://localhost:$PYTHON_PORT"

MODE="${1:-all}"  # all | perf | quality | --no-python
SKIP_PYTHON=false

if [[ "$MODE" == "--no-python" ]]; then
  SKIP_PYTHON=true
  MODE="all"
fi

export RUN_BENCHMARKS=1

# ── Step 1: Clean stale data and generate configs ─────────────────────
echo "==> Cleaning stale benchmark data"
rm -rf "$BENCHMARK_DIR"
mkdir -p "$BENCHMARK_DIR/python-data"

echo "==> Generating benchmark configs in $BENCHMARK_DIR"
cd "$REPO_ROOT"
bun -e "
  const { writeBenchmarkConfigs } = require('./packages/memory/benchmark-tests/config.ts');
  writeBenchmarkConfigs();
  console.log('Configs written to $BENCHMARK_DIR');
"

# Verify config file exists (Docker bind mount requires it before compose up)
if [[ ! -f "$BENCHMARK_DIR/python-config.json" ]]; then
  echo "ERROR: python-config.json was not generated"
  exit 1
fi

# ── Step 2: Start Python reference service ────────────────────────────
cleanup() {
  if [[ "$SKIP_PYTHON" == false ]]; then
    echo ""
    echo "==> Tearing down Python reference service"
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$SKIP_PYTHON" == false ]]; then
  echo ""
  echo "==> Building and starting Python reference service on :$PYTHON_PORT"
  # Tear down any leftover containers first, then start fresh
  docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate --wait 2>&1

  echo "==> Waiting for Python service health..."
  TRIES=0
  MAX_TRIES=30
  until curl -sf "$PYTHON_URL/health" > /dev/null 2>&1; do
    TRIES=$((TRIES + 1))
    if [[ $TRIES -ge $MAX_TRIES ]]; then
      echo "ERROR: Python service failed to start after ${MAX_TRIES}s"
      docker compose -f "$COMPOSE_FILE" logs
      exit 1
    fi
    sleep 1
  done
  echo "==> Python service ready"
  export BENCHMARK_PYTHON_URL="$PYTHON_URL"
fi

# ── Step 3: Run benchmarks ────────────────────────────────────────────
# Call bun test directly (NOT bun run test:benchmark) to avoid recursion
# since package.json scripts point back to this script.
echo ""
cd "$REPO_ROOT"

TIMEOUT=120000
TEST_DIR="packages/memory/benchmark-tests/"

case "$MODE" in
  perf)
    echo "==> Running performance benchmarks"
    bun test "$TEST_DIR" --test-name-pattern '01|02|03|04' --timeout "$TIMEOUT"
    ;;
  quality)
    echo "==> Running quality benchmarks"
    bun test "$TEST_DIR" --test-name-pattern '05|06|07' --timeout "$TIMEOUT"
    ;;
  all)
    echo "==> Running all benchmarks"
    bun test "$TEST_DIR" --timeout "$TIMEOUT"
    ;;
  *)
    echo "Unknown mode: $MODE (use: all, perf, quality, --no-python)"
    exit 1
    ;;
esac

echo ""
echo "==> Results saved to $BENCHMARK_DIR/*.json"
