# Release Quality Gates

How to ensure test failures are caught **before** a release tag is pushed, not after.

## Problem statement

The v0.4.0 release failed at the `publish-cli` stage because a test that passed
locally failed in CI. The root cause was a test that depended on local-only state
(OpenPalm's compose file and `.env` in the XDG state directory). The test used
`skipIf(!dockerAvailable)` but Docker **is** available on GitHub Actions runners --
only the OpenPalm installation artifacts are missing. The test was pushed directly
to `main` without a PR, bypassing the `test.yml` workflow.

Three gaps allowed this to reach a release tag:

1. **Direct push to main** -- the commit bypassed PR-based CI checks.
2. **Release workflow lacked unit tests** -- the validation gates ran integration,
   contract, security, and UI tests, but not the standard unit test suite (which
   includes CLI tests).
3. **Environment-dependent tests without proper guards** -- the test assumed that
   `docker info` succeeding meant `docker compose ps` would also succeed, but
   compose requires files on disk that don't exist on a fresh CI runner.

## Fixes applied

### 1. Test fix (`packages/cli/test/main.test.ts`)

Changed the `ps` alias test to use `openpalmInstalled` instead of `dockerAvailable`.
The new guard checks for Docker **and** the existence of the compose file and env
file at the XDG state path. On CI (or any machine without OpenPalm installed), the
test is skipped.

### 2. Release workflow gate (`release.yml`)

Added a `unit-tests` job to the release workflow that runs `bun run typecheck` and
`bun test` (the full unit test suite). The release job now depends on this gate:

```yaml
needs: [unit-tests, integration, contracts, security, ui, docker-build]
```

This ensures the exact same tests that run on PRs also run before any release tag
is created.

## Rules for writing CI-safe tests

### Environment guards

Tests that depend on external state must use appropriate skip guards:

| Dependency | Guard | Example |
|---|---|---|
| Docker daemon | `skipIf(!dockerAvailable)` | Building images |
| OpenPalm installed | `skipIf(!openpalmInstalled)` | `docker compose ps`, any compose command |
| Network access | `skipIf(!networkAvailable)` | HTTP fetch tests |
| Specific env vars | `skipIf(!process.env.FOO)` | API key-dependent tests |

**The rule:** if a test spawns `docker compose` with file arguments (`-f`, `--env-file`)
that reference the OpenPalm state directory, it must be guarded by `openpalmInstalled`,
not just `dockerAvailable`. Docker being present is necessary but not sufficient.

### Test tiers and what runs where

| Tier | Where it runs | What it checks |
|---|---|---|
| Unit (`bun test`) | PR CI, Release gates, publish-cli | All unit tests across all packages |
| Integration (`--filter integration`) | Release gates | Cross-service integration |
| Contract (`--filter contract`) | Release gates | API contract stability |
| Security (`--filter security`) | Release gates | Security invariants |
| UI (`test-ui.yml`) | PR CI, Release gates | SvelteKit + Playwright e2e |
| Docker (`test:docker`) | Manual / opt-in | Full stack health checks |

### Writing tests that work everywhere

1. **Never assume local installation state.** CI runners are fresh machines.
   Compose files, env files, and XDG directories do not exist.
2. **Use `skipIf` with a descriptive guard variable**, not inline boolean
   expressions. This makes it obvious why a test is skipped in CI output.
3. **Test the command routing separately from the compose execution.** To verify
   that `ps` is recognized as a valid alias, check that the CLI doesn't print
   "Unknown command" -- don't rely on compose succeeding.
4. **If a test must write temp files, clean them up.** Use `afterAll` or
   `afterEach` to remove temp directories.

## Pre-release checklist (for humans and agents)

Before triggering the Release workflow:

1. **All changes are merged via PR.** No direct pushes to `main` for code changes.
2. **PR CI passed.** The `test` and `test-ui` workflows must have succeeded on the
   merge commit.
3. **Run locally if in doubt:**
   ```bash
   bun run typecheck && bun test
   ```
4. **Check for skipped tests.** If CI reports skipped tests, verify the skips are
   intentional (environment guards) and not hiding real failures.

## Recommended repository settings

To prevent direct pushes from bypassing CI:

- Enable branch protection on `main` requiring status checks to pass
- Require the `test` and `test-ui` workflows as required status checks
- Disallow direct pushes (require PRs) for all contributors including admins
