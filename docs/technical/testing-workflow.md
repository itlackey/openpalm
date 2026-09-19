# Testing workflow

The active checks cover the complete tracked product surface.

## Local quality gate

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bash -n scripts/dev-setup.sh \
  containers/assistant/entrypoint.sh \
  containers/guardian/entrypoint.sh
```

`check` type-checks Lib, Guardian, Portal, CLI, Admin, and the Claude Desktop
bridge. `test` runs stack intent/import/security tests, Guardian protocol tests,
portal policy/state tests, and fresh-install tests.

`scripts/acceptance.test.ts` exercises the complete deterministic product
path: fresh install, authenticated provider readiness against a controllable
provider boundary, persistent knowledge across runtime reconciliation, a
recurring task with durable history and inbox output, credential-to-portal
mapping, portable backup, dry-run/apply import, and source immutability.

Guardian's socket-only body-limit test runs in CI and can be enabled locally
with `OPENPALM_SOCKET_TESTS=1`. OAuth tests sign real JWTs and cover expiry,
audience, scopes, signing-key rotation, and live issuer/subject mapping changes.

## Compose validation

Compose validation does not require a running daemon:

```bash
tmp_home="$(mktemp -d)"
OP_HOME="$tmp_home" OPENPALM_REPO_ROOT="$PWD" OP_ALLOW_ROOT=1 \
  bun run packages/cli/src/main.ts install --no-start

docker compose \
  --project-name openpalm-test \
  --project-directory "$PWD" \
  -f "$tmp_home/system/stack/stack.compose.yml" \
  -f "$tmp_home/config/stack/custom.compose.yml" \
  --env-file "$tmp_home/state/stack.env" \
  --profile gateway --profile discord --profile slack \
  config --quiet
```

Remove only the exact generated temporary directory after the check.

## Image checks

Build all active images:

```bash
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION=dev -t openpalm/assistant:dev .
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION=dev -t openpalm/guardian:dev .
docker build -f containers/portal/Dockerfile \
  -t openpalm/portal:dev .
```

`scripts/smoke-image.sh` verifies each image as its configured non-root
user. Assistant and Guardian must become healthy; Guardian must reject an
unknown key and accept an authenticated MCP initialize request. Portal must
contain its runtime and fail closed when no adapter is selected.

## CI

`.github/workflows/gates.yml` is the one reusable gate. It runs the local
checks and acceptance lane, materializes a fresh home, validates every profile,
enforces the active surface, builds each image, checks its non-root user, and
runs its startup/security smoke.
