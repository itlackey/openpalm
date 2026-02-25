# Remaining Work — Remove OPENPALM_TEST_MODE and Fix Real Compose Path

## Context

All six original recommendations (rec1–rec6) have been completed and pushed to PR #140.
This document captures the remaining work needed to fully eliminate `OPENPALM_TEST_MODE`
and make `setup.complete` exercise the real compose path end-to-end.

---

## Root Cause (from discovery)

`setup.complete` fails in production with:

```
compose_validation_failed: OPENPALM_STATE_HOME variable is not set
POSTGRES_PASSWORD is missing a value
```

The stack generator writes `${OPENPALM_STATE_HOME}`, `${OPENPALM_DATA_HOME}`,
`${OPENPALM_CONFIG_HOME}` into the generated `docker-compose.yml`. When the admin
container runs `docker compose` internally, those vars are not set inside the container
process environment. The design intent is that `/state/.env` (written by the installer)
is passed via `--env-file` to every compose invocation by `compose-runner.ts`.

The `.dev/state/.env` file on the running dev stack does **not** contain these vars —
only bind-address and token values — so compose interpolation fails.

---

## Task 1 — Remove OPENPALM_TEST_MODE

### What

Remove the `OPENPALM_TEST_MODE` escape hatch entirely. It was added to make tests pass
without a real compose environment, but it masks the actual failure and means tests prove
nothing about whether setup works.

### Where

Two source files contain the check:

- `packages/ui/src/routes/command/+server.ts` line 342
- `packages/ui/src/routes/setup/complete/+server.ts` line 23

Both have the same structure:

```typescript
const testMode = process.env.OPENPALM_TEST_MODE === '1';
let applyResult: unknown = { skipped: true };
if (!testMode) {
    applyResult = await applyStack(stackManager);
    const startupResult = await composeAction('up', [...SetupCoreServices]);
    if (!startupResult.ok) throw new Error(`core_startup_failed:${startupResult.stderr}`);
}
```

### Change

Remove the `testMode` check. Always run `applyStack` and `composeAction`:

```typescript
const applyResult = await applyStack(stackManager);
const startupResult = await composeAction('up', [...SetupCoreServices]);
if (!startupResult.ok) throw new Error(`core_startup_failed:${startupResult.stderr}`);
```

### Impact on Playwright e2e tests

`packages/ui/e2e/env.ts` line 100 sets `OPENPALM_TEST_MODE: '1'` in the test server
environment. Once the check is removed from source, this line is inert (no code reads it)
but it also sets `OPENPALM_COMPOSE_BIN: '/usr/bin/true'` which routes all compose
commands to `/usr/bin/true` — a no-op binary that exits 0.

The compose runner already honours `OPENPALM_COMPOSE_BIN` (compose-runner.ts line 21).
So after removing `OPENPALM_TEST_MODE`, the Playwright tests will still pass because
`/usr/bin/true` makes every compose call succeed silently.

The `OPENPALM_TEST_MODE: '1'` line in `env.ts` should be removed as dead config.

---

## Task 2 — Fix the Docker E2E test

### Problem

`test/install-e2e/happy-path.docker.ts` references `COMPOSE_BASE` (the embedded
`packages/lib/src/embedded/state/docker-compose.yml`) which hardcodes:

```yaml
ports:
  - "127.0.0.1:8100:8100"
```

When the test runs while `openpalm-admin-1` is already running on port 8100, the compose
up call fails with a port conflict.

### Change

Remove the `-f COMPOSE_BASE` reference from the `compose()` helper (line 43). The
overlay already defines all needed services (admin built from source + busybox stubs for
all SetupCoreServices). The base compose file is not needed and causes the conflict.

The `const COMPOSE_BASE` constant on line 22 should also be removed.

The resulting `compose()` call becomes:

```typescript
function compose(...args: string[]) {
  return Bun.spawn(
    ["docker", "compose", "-p", PROJECT_NAME, "--env-file", envFilePath,
      "-f", composeTestFile, "--project-directory", REPO_ROOT, ...args],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
}
```

The overlay already sets:

```yaml
environment:
  COMPOSE_PROJECT_PATH: /compose
  OPENPALM_COMPOSE_FILE: packages/lib/src/embedded/state/docker-compose.yml
```

So inside the admin container, compose commands reference the embedded compose file
via the mounted repo root at `/compose` — that path is correct and does not conflict
with the host port binding.

---

## Task 3 — Verify /state/.env contains required interpolation vars

### Problem

The compose runner passes `--env-file $STATE/.env` so that compose can interpolate
`${OPENPALM_STATE_HOME}`, `${OPENPALM_DATA_HOME}`, `${OPENPALM_CONFIG_HOME}`, and
`${POSTGRES_PASSWORD}`. This file must exist and contain those vars.

### What to check

Confirm that the installer (`install.sh` / `install.ps1`) writes these vars to
`$STATE/.env`. If it does not, the fix is to either:

a. Add the missing vars to whatever writes `$STATE/.env`, or  
b. Add them to `$STATE/system.env` (which already exists) and update the compose runner
   to also pass `--env-file` for `system.env`, or  
c. Change the generator to use fixed container-internal paths (`/state`, `/data`,
   `/config`) instead of env-var references in the generated compose file — since inside
   the container those are always fixed mount points.

Option (c) is the cleanest: the generated compose file runs inside the admin container
where mounts are always at fixed paths. Using `${OPENPALM_STATE_HOME}` in the generated
compose YAML is wrong — those vars are only meaningful on the host.

### Files to review

- `install.sh` — look for where `$STATE/.env` is written
- `packages/lib/src/admin/core-services.ts` — uses `${OPENPALM_STATE_HOME}` etc in
  generated compose volume/bind mounts
- `packages/lib/src/admin/stack-generator.ts` — same, all path references use env vars

---

## Task 4 — Run bun test and confirm no regressions

After tasks 1–3 are complete:

```bash
bun test
```

All existing unit tests must pass. The Playwright tests (`bun run test:e2e`) must pass.
The docker E2E test is opt-in (`OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun run test:install:smoke`)
and is not part of the standard test run.

---

## Files Changed by This Work

| File | Change |
|---|---|
| `packages/ui/src/routes/command/+server.ts` | Remove `testMode` check at line 342 |
| `packages/ui/src/routes/setup/complete/+server.ts` | Remove `testMode` check at line 23 |
| `packages/ui/e2e/env.ts` | Remove `OPENPALM_TEST_MODE: '1'` at line 100 |
| `test/install-e2e/happy-path.docker.ts` | Remove `COMPOSE_BASE` constant and `-f COMPOSE_BASE` from `compose()` helper |
| `install.sh` (possibly) | Ensure `$STATE/.env` contains `OPENPALM_STATE_HOME`, `OPENPALM_DATA_HOME`, `OPENPALM_CONFIG_HOME`, `POSTGRES_PASSWORD` |
| `packages/lib/src/admin/core-services.ts` (possibly) | Replace env-var path refs with fixed container paths if option (c) above is chosen |

---

## Success Criteria

- `OPENPALM_TEST_MODE` does not appear in any `.ts` or `.svelte` source file
- `bun test` passes without `OPENPALM_TEST_MODE` set
- `OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun run test:install:smoke` passes end-to-end
  (admin container builds, wizard completes, `completed: true` returned)
