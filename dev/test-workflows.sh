#!/usr/bin/env bash
# dev/test-workflows.sh -- Test GitHub Actions workflows locally using act.
#
# Runs each workflow with act to catch failures before pushing.
# Workflows that require external credentials (Docker Hub, npm OIDC, RELEASE_TOKEN)
# are run with --dry-run or with the push/publish steps excluded.
#
# Usage:
#   ./dev/test-workflows.sh              # Test all workflows
#   ./dev/test-workflows.sh test         # Test a specific workflow
#   ./dev/test-workflows.sh --list       # List available workflows
#   ./dev/test-workflows.sh --dry-run    # Dry-run all (validate YAML only)
#
# Prerequisites: act (https://github.com/nektos/act)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=false
VERBOSE=false
EXTRA_ACT_ARGS=()

# ── Workflow definitions ─────────────────────────────────────────────
# Each workflow has a test function below.
WORKFLOWS=(test publish-images publish-cli release validate-registry update-registry-index version-bump-pr)

usage() {
  cat <<EOF
Usage: $0 [options] [workflow...]

Workflows:
  test                 CI test suite (unit, integration, contracts, security)
  publish-images       Docker image builds (builds only, no push)
  publish-cli          CLI bundle, package, and binary builds (no npm publish)
  release              Release workflow (dry-run only — requires RELEASE_TOKEN)
  validate-registry    Registry entry validation
  update-registry-index  Registry index rebuild
  version-bump-pr      Version bump PR creation (dry-run only)

Options:
  --list, -l         List available workflows
  --dry-run, -n      Validate workflow YAML only (act --dry-run)
  --verbose, -v      Show full act output
  --help, -h         Show this help

Examples:
  $0                      # Test all workflows
  $0 test                 # Test just the CI test suite
  $0 publish-images publish-cli  # Test Docker + CLI publish
  $0 --dry-run            # Validate all workflow YAML
EOF
}

# ── Helpers ──────────────────────────────────────────────────────────

run_act() {
  local workflow="$1"
  local event="$2"
  shift 2
  local args=("$@")

  local act_cmd=(
    act "$event"
    -W ".github/workflows/${workflow}.yml"
    "${args[@]}"
    "${EXTRA_ACT_ARGS[@]}"
  )

  if $DRY_RUN; then
    act_cmd+=(-n)
  fi

  if $VERBOSE; then
    "${act_cmd[@]}"
  else
    "${act_cmd[@]}" 2>&1
  fi
}

# Pipe JSON event payload to act via stdin
run_act_with_event() {
  local workflow="$1"
  local event="$2"
  local event_json="$3"
  shift 3
  local args=("$@")

  local act_cmd=(
    act "$event"
    -W ".github/workflows/${workflow}.yml"
    -e /dev/stdin
    "${args[@]}"
    "${EXTRA_ACT_ARGS[@]}"
  )

  if $DRY_RUN; then
    act_cmd+=(-n)
  fi

  if $VERBOSE; then
    echo "$event_json" | "${act_cmd[@]}"
  else
    echo "$event_json" | "${act_cmd[@]}" 2>&1
  fi
}

# ── Workflow test functions ──────────────────────────────────────────

test_test() {
  echo "Running: test.yml (unit job only — integration/contracts/security depend on it)"
  run_act "test" "push" -j unit
}

test_publish-images() {
  echo "Running: publish-images.yml (prepare + publish jobs, builds only)"
  # Use workflow_dispatch to control inputs. Build one image to validate.
  # Provide dummy Docker Hub secrets so the login action doesn't fail act parsing,
  # but the actual push is skipped because we only build.
  local event_json='{"inputs":{"version":"v0.0.0-test","component":"gateway"}}'
  run_act_with_event "publish-images" "workflow_dispatch" "$event_json" \
    -s DOCKERHUB_USERNAME=test \
    -s DOCKERHUB_TOKEN=test \
    -j prepare
  # Also test that the Docker builds actually succeed by building locally
  echo ""
  echo "Building Docker images locally (mirrors publish job contexts)..."
  local -A IMAGES=(
    [assistant]="./assistant|./assistant/Dockerfile"
    [gateway]=".|./gateway/Dockerfile"
    [admin]=".|./admin/Dockerfile"
    [channel-chat]=".|./channels/chat/Dockerfile"
    [channel-discord]=".|./channels/discord/Dockerfile"
    [channel-voice]=".|./channels/voice/Dockerfile"
    [channel-telegram]=".|./channels/telegram/Dockerfile"
  )
  local failed=()
  for name in "${!IMAGES[@]}"; do
    IFS='|' read -r context dockerfile <<< "${IMAGES[$name]}"
    echo "  Building ${name} (context=${context}, file=${dockerfile})..."
    if docker build -t "openpalm/${name}:workflow-test" -f "$dockerfile" "$context" > /dev/null 2>&1; then
      echo "    [PASS] ${name}"
    else
      echo "    [FAIL] ${name}"
      # Re-run with output visible
      docker build -t "openpalm/${name}:workflow-test" -f "$dockerfile" "$context" 2>&1 | tail -20
      failed+=("$name")
    fi
  done
  if [[ ${#failed[@]} -gt 0 ]]; then
    echo "Docker build failures: ${failed[*]}"
    return 1
  fi
}

test_publish-cli() {
  echo "Running: publish-cli.yml (test + build-binaries jobs, skipping npm publish + release)"
  run_act "publish-cli" "push" \
    --env GITHUB_REF="refs/tags/v0.0.0-test" \
    --env GITHUB_REF_NAME="v0.0.0-test" \
    -j test

  echo ""
  echo "Testing CLI bundle locally (mirrors publish-npm bundle step)..."
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" RETURN

  mkdir -p "$tmpdir/dist"
  bun build packages/cli/src/main.ts --outfile "$tmpdir/dist/openpalm.js" --target bun
  sed -i '1i#!/usr/bin/env bun' "$tmpdir/dist/openpalm.js"

  # Verify shebang
  local first_line
  first_line=$(head -1 "$tmpdir/dist/openpalm.js")
  if [[ "$first_line" != "#!/usr/bin/env bun" ]]; then
    echo "  [FAIL] Shebang missing from bundle"
    return 1
  fi
  echo "  [PASS] Bundle created with shebang"

  # Create package.json
  CLI_VERSION="0.0.0-test" node -e '
    const fs = require("fs");
    const src = JSON.parse(fs.readFileSync("packages/cli/package.json", "utf8"));
    const out = {
      name: src.name,
      version: process.env.CLI_VERSION,
      description: src.description,
      type: src.type,
      license: src.license,
      repository: src.repository,
      homepage: src.homepage,
      keywords: src.keywords,
      bin: { openpalm: "./dist/openpalm.js" },
      files: ["dist/**", "README.md", "LICENSE"],
      engines: src.engines
    };
    fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify(out, null, 2) + "\n");
  ' "$tmpdir"

  cp packages/cli/README.md "$tmpdir/README.md"
  cp LICENSE "$tmpdir/LICENSE"

  # Validate package name
  local pkg_name
  pkg_name=$(node -e "console.log(require('$tmpdir/package.json').name)")
  if [[ "$pkg_name" != "openpalm" ]]; then
    echo "  [FAIL] Package name is '${pkg_name}', expected 'openpalm'"
    return 1
  fi
  echo "  [PASS] Package name: ${pkg_name}"

  # Validate bin entry
  local bin_target
  bin_target=$(node -e "console.log(Object.values(require('$tmpdir/package.json').bin)[0])")
  if [[ ! -f "$tmpdir/$bin_target" ]]; then
    echo "  [FAIL] bin target does not exist: ${bin_target}"
    return 1
  fi
  echo "  [PASS] bin target exists: ${bin_target}"

  # npm pack dry-run
  echo "  Running npm pack --dry-run..."
  (cd "$tmpdir" && npm pack --dry-run 2>&1) | sed 's/^/  /'

  echo ""
  echo "Testing CLI binary build (linux-x64 only)..."
  bun build packages/cli/src/main.ts --compile --target=bun-linux-x64 --outfile "$tmpdir/openpalm-linux-x64"
  if [[ -f "$tmpdir/openpalm-linux-x64" ]]; then
    echo "  [PASS] Binary compiled"
  else
    echo "  [FAIL] Binary compilation failed"
    return 1
  fi
}

test_release() {
  echo "Running: release.yml (dry-run only — requires RELEASE_TOKEN)"
  # This workflow is workflow_dispatch only and requires RELEASE_TOKEN.
  # We can only dry-run to validate the YAML.
  local event_json='{"inputs":{"component":"platform","bump":"patch"}}'
  run_act_with_event "release" "workflow_dispatch" "$event_json" \
    -s RELEASE_TOKEN=test-token \
    -n
}

test_validate-registry() {
  echo "Running: validate-registry.yml"
  run_act "validate-registry" "pull_request" -j validate
}

test_update-registry-index() {
  echo "Running: update-registry-index.yml (dry-run — commits to main)"
  # This workflow commits to main, so always dry-run the git push part.
  run_act "update-registry-index" "push" -j rebuild-index -n
}

test_version-bump-pr() {
  echo "Running: version-bump-pr.yml (dry-run — creates PRs)"
  local event_json='{"inputs":{"component":"platform","bump":"patch"}}'
  run_act_with_event "version-bump-pr" "workflow_dispatch" "$event_json" \
    -s RELEASE_TOKEN=test-token \
    -n
}

# ── Parse arguments ──────────────────────────────────────────────────
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l)
      echo "Available workflows:"
      for w in "${WORKFLOWS[@]}"; do printf "  %s\n" "$w"; done
      exit 0
      ;;
    --dry-run|-n)
      DRY_RUN=true
      shift
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      EXTRA_ACT_ARGS+=("$1")
      shift
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

# Validate act is installed
if ! command -v act &>/dev/null; then
  echo "Error: 'act' is not installed."
  echo "Install from https://github.com/nektos/act"
  exit 1
fi

# Default: run all
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("${WORKFLOWS[@]}")
fi

# Validate targets
for target in "${TARGETS[@]}"; do
  found=false
  for w in "${WORKFLOWS[@]}"; do
    if [[ "$w" == "$target" ]]; then found=true; break; fi
  done
  if ! $found; then
    echo "Unknown workflow: ${target}"
    echo "Run '$0 --list' to see available workflows."
    exit 1
  fi
done

# ── Run ──────────────────────────────────────────────────────────────
PASSED=()
FAILED=()
SKIPPED=()

for target in "${TARGETS[@]}"; do
  echo ""
  echo "================================================================"
  echo "  Workflow: ${target}"
  echo "================================================================"

  func="test_${target}"
  if ! declare -f "$func" &>/dev/null; then
    echo "  [SKIP] No test function defined"
    SKIPPED+=("$target")
    continue
  fi

  if $func; then
    echo "  [PASS] ${target}"
    PASSED+=("$target")
  else
    echo "  [FAIL] ${target}"
    FAILED+=("$target")
  fi
done

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "================================================================"
echo "  Workflow Test Summary"
echo "================================================================"

[[ ${#PASSED[@]} -gt 0 ]]  && echo "  PASSED:  ${PASSED[*]}"
[[ ${#FAILED[@]} -gt 0 ]]  && echo "  FAILED:  ${FAILED[*]}"
[[ ${#SKIPPED[@]} -gt 0 ]] && echo "  SKIPPED: ${SKIPPED[*]}"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  exit 1
fi

echo ""
echo "All workflow tests passed."
