# Testing workflow

Verification has three layers: deterministic package tests, image/startup
checks, and opt-in real-provider acceptance. A passing unit gate does not prove
that a real model, scheduler timer, or external chat platform works.

## Local quality gate

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/claude-desktop pack
bun run --cwd packages/electron bundle
bash -n scripts/dev-setup.sh \
  scripts/setup.sh \
  scripts/smoke-image.sh \
  containers/assistant/entrypoint.sh \
  containers/assistant/healthcheck.sh \
  containers/assistant/opencode-run.sh \
  containers/guardian/entrypoint.sh
```

`check` type-checks Lib, Guardian, Portal, CLI, Admin, and the Claude Desktop
bridge. `test` runs stack intent/import/security tests, Guardian protocol tests,
portal policy/state tests, and fresh-install tests.

`scripts/acceptance.test.ts` verifies deterministic control-plane wiring: fresh
install, provider readiness through a fake provider boundary, file persistence
across runtime reconciliation, task-helper behavior through a fake AKM runner,
credential-to-portal mapping, portable backup, dry-run/apply import, and source
immutability. Its knowledge and task results are fixtures, not evidence of
automatic extraction, a real timer firing, or an actual provider response.

Guardian's socket-only body-limit test runs in CI and can be enabled locally
with `OPENPALM_SOCKET_TESTS=1`. OAuth tests sign real JWTs and cover expiry,
audience, scopes, signing-key rotation, and live issuer/subject mapping changes.

The opt-in `bun run admin:e2e` check drives the real Electron Admin against a
disposable Docker stack. It verifies the default setup path with advanced
network choices closed, operation locking, Assistant and Guardian health,
provider discovery, truthful readiness failure, credential policy, portal
mapping, restart/reload persistence, authenticated MCP policy filtering,
complete client connection recipes, visible recovery from an interrupted first
start, minimum control sizes, visible focus, and document reflow. Without a
provider secret, it stops the visible setup journey at the truthful provider
gate and uses a clearly reported test-only completion marker for subsequent
management-UI coverage. A provider-backed run instead completes setup and
verifies the installed default provider and an MCP response after restart.
It needs a desktop session and locally built images matching the checkout's
version, so it is not part of the portable unit-test gate. See the
[Admin setup verification runbook](../operations/admin-setup-verification.md).

## Real-provider runtime acceptance

`scripts/live-acceptance.ts` is an opt-in entrypoint for the runner under
`packages/guardian/scripts/`, next to its private MCP client dependency. It
requires an already-onboarded disposable Admin E2E home, loopback Assistant and
Guardian, and automatic memory enabled. It rejects ordinary operator projects.

Build the version-matching images below, then run Admin E2E with a provider key
and `OPENPALM_ADMIN_E2E_KEEP_RUNNING=true`. Use a private generated directory so
the retained provider authentication, sessions, knowledge, and logs cannot be
mistaken for disposable public artifacts:

```bash
test_root="$(mktemp -d /tmp/openpalm-live-e2e.XXXXXX)"
OPENPALM_ADMIN_E2E_HOME="$test_root/home" \
OPENPALM_ADMIN_E2E_OUTPUT="$test_root/admin-report" \
OPENPALM_ADMIN_E2E_KEEP_RUNNING=true \
OPENPALM_ADMIN_E2E_PROVIDER=opencode-go \
OPENPALM_ADMIN_E2E_PROVIDER_KEY_FILE=/absolute/path/to/private/provider-key \
  bun run admin:e2e

OPENPALM_LIVE_TEST_HOME="$test_root/home" \
OPENPALM_LIVE_TEST_REPORT="$test_root/live-report.json" \
  bun run scripts/live-acceptance.ts
```

Use a provider ID returned by OpenCode and a private key file; never put a key
in command arguments, fixtures, or a committed report. The Admin walkthrough
verifies that automatic-memory opt-out persists, then re-enables it for this
runtime suite.

The live suite asserts:

- A durable fact from a trusted native personal session is automatically
  captured into AKM knowledge. Automatic capture is intentionally limited to
  trusted native sessions; guarded remote and scheduled profiles are excluded.
- A natural-language request creates a recurring task. A real scheduler timer
  produces the expected durable output and a completed history entry, followed
  by pause/resume checks. The suite does not manually execute that task.
- `update --no-pull` refreshes managed assets and restarts the stack while a new
  session can still recall the retained fact through AKM.
- MCP policy catalogs distinguish `chat`, `read`, and `full`; workspace reads
  stay inside their permitted boundary; resumable jobs complete; another
  credential cannot inspect the job or list its session.
- Rotating a credential immediately rejects the old key and accepts the new
  one.
- A full-policy MCP job surfaces an explicit permission interaction. Another
  identity cannot approve it; the owning credential approves once and the
  resumed job completes with the expected command output.

The report records `ok`, individual checks, and `directModelRequests`. The
direct-request counter does not include background extraction or timer model
requests; reserve provider-budget headroom. Failures suppress model output and
credential-bearing transport errors. Reports and private test homes are
retained for review, not deleted by the live runner. Its cleanup closes MCP
clients and attempts to pause its generated task; it does not stop the stack.

Stop only the retained test installation when finished:

```bash
OP_HOME="$test_root/home" OPENPALM_REPO_ROOT="$PWD" \
  bun run packages/cli/src/main.ts stop
```

Inspect the exact printed/generated paths before deleting retained data.
Successful runtime acceptance does not substitute for interactive provider
OAuth, public HTTPS/OAuth connector, Slack, or Discord platform verification.

## Compose validation

Compose validation does not require a running daemon:

```bash
tmp_home="$(mktemp -d)"
OP_HOME="$tmp_home" OPENPALM_REPO_ROOT="$PWD" \
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

Build all active images with the checkout's exact candidate version. Do not
reuse an older local image for release acceptance:

```bash
release_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION="$release_version" -t "openpalm/assistant:$release_version" .
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION="$release_version" -t "openpalm/guardian:$release_version" .
docker build -f containers/portal/Dockerfile \
  -t "openpalm/portal:$release_version" .

bash scripts/smoke-image.sh "openpalm/assistant:$release_version" assistant
bash scripts/smoke-image.sh "openpalm/guardian:$release_version" guardian
bash scripts/smoke-image.sh "openpalm/portal:$release_version" portal
```

`scripts/smoke-image.sh` verifies each image as its configured non-root
user. Assistant and Guardian must become healthy; Guardian must reject an
unknown key and accept an authenticated MCP initialize request. Assistant
health includes OpenCode, scheduler, and recent task reconciliation. Portal
must contain its runtime and fail closed when no adapter is selected. These
smokes do not prove a live model, successful task execution, or platform events.

## CI

`.github/workflows/gates.yml` is the one reusable gate. It runs the local
checks and deterministic acceptance lane, materializes a fresh home, validates
every profile, enforces the active surface, builds each image, checks its
non-root user, and runs its startup/security smoke.

Release artifact jobs also launch their native CLI and packaged Admin against
fresh homes. Keep real-provider and external-platform evidence with the release
sign-off; those checks are not implied by portable CI passing.
