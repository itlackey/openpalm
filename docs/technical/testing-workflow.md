# Testing workflow

The active checks intentionally ignore preserved legacy source.

## Local quality gate

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bash -n scripts/dev-setup.sh \
  containers/assistant/entrypoint.lean.sh \
  containers/guardian/entrypoint.lean.sh
```

`check` type-checks Lib, Guardian, Portal, CLI, and Admin. `test` runs stack
intent/migration/security tests, Guardian protocol tests, portal policy/state
tests, and CLI installation tests.

## Compose validation

Compose validation does not require a running daemon:

```bash
tmp_home="$(mktemp -d)"
OP_HOME="$tmp_home" OPENPALM_REPO_ROOT="$PWD" OP_ALLOW_ROOT=1 \
  bun run packages/cli/src/main-lean.ts install --no-start

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
docker build -f containers/assistant/Dockerfile.lean \
  --build-arg PLATFORM_VERSION=dev -t openpalm/assistant:dev .
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION=dev -t openpalm/guardian:dev .
docker build -f containers/portal/Dockerfile \
  -t openpalm/portal:dev .
```

Inspect each image's configured user and run the relevant health/startup smoke
when a Docker daemon is available.

## CI

`.github/workflows/gates.yml` is the one reusable gate. It runs the local
checks, materializes a fresh home, validates every profile, enforces the active
surface, builds each image, and checks for a non-root image user.
