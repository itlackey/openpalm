# Manual Install & Setup Review (Pre-v1)

## Scope and environment

This review covers a manual, user-like first-run flow from shell installer to setup entrypoint, executed in a clean temp HOME where possible.

- Repository: local checkout of OpenPalm
- Host runtime available in this environment: **no Docker/Podman installed**
- Goal: mimic real user behavior as closely as possible, including installer arguments, release download, and initial setup handoff

## Manual test flow executed

1. Reviewed public quick-start instructions in root `README.md`.
2. Ran installer help flow (`./install.sh --help`).
3. Ran installer argument validation flow (`./install.sh --runtime`).
4. Ran installer with invalid release ref (`./install.sh --ref definitely-not-a-release`).
5. Ran installer with default latest release and isolated HOME (`HOME=/tmp/openpalm-manual-2 ./install.sh --no-open`).
6. Ran installed CLI directly with forced runtimes:
   - `openpalm install --runtime docker --no-open`
   - `openpalm install --runtime podman --no-open`
7. Ran install/setup-adjacent tests:
   - `bun test packages/cli/test/install.test.ts packages/lib/src/admin/setup-manager.test.ts`

## What worked well

- **Installer UX is simple and discoverable.** `install.sh --help` is concise and mirrors the README onboarding model.
- **Argument validation is clear.** Missing `--runtime` value yields a precise immediate error.
- **Invalid release feedback is actionable.** The download failure message includes likely causes and fallback install methods.
- **No-runtime path is user-friendly.** Auto-detection failure gives practical Docker installation guidance and a pre-filled GitHub issue link.
- **Podman guidance is concrete.** Missing compose support points users directly to `podman-compose` installation.
- **Automated guardrails are strong.** Install command source tests and setup-manager tests passed and align with staged setup assumptions.

## Critical issues to fix before v1

### 1) Forced Docker runtime error is too vague (High)

When a user explicitly selects Docker (`--runtime docker`) but the daemon is unavailable, output was:

> "Could not verify that the docker daemon is running."

This message is likely insufficient for first-time users because it omits next-step remediation (start daemon, validate socket permissions, run a diagnostic command). Auto-detect mode already provides much stronger guidance, so forced-runtime mode currently regresses UX quality.

**Recommendation:**
- Reuse the richer remediation block from the no-runtime path, but tailor it to "Docker selected but unavailable".
- Include a one-command diagnostic (`docker info` or `docker version`) and likely fixes by OS.

### 2) Binary checksum path appears unreliable in normal flow (Medium)

The latest-release install path printed:

> "WARNING: Could not download checksum file. Skipping verification."

For security-sensitive tooling, warning-only checksum behavior reduces trust and may confuse users during first-run. If checksum artifacts are intentionally optional, this should be reflected in release policy docs and messaging; if not intentional, publishing pipeline should enforce checksum availability.

**Recommendation:**
- Make checksum artifact publication mandatory for release binaries, or
- downgrade warning verbosity with a clearer "pre-release/missing artifact" explanation.

### 3) PATH guidance is correct but adds friction (Medium)

Installing to `~/.local/bin` then immediately invoking via absolute path works, but users who later run `openpalm` from a new shell may hit command-not-found unless they apply PATH changes.

**Recommendation:**
- Add an optional post-install shell profile helper (opt-in) for bash/zsh.
- At minimum, print a one-line copy/paste command and verify command availability before exiting.

## Important improvements before release

### 4) Setup wizard readiness should be validated in a real Docker smoke run (High)

In this environment, full setup wizard validation was blocked by missing container runtime. Given README promises "ready in minutes" and browser-based setup, release readiness should include an automated/manual smoke pass that proves:

- install command starts core services,
- admin URL becomes reachable,
- setup wizard step progression succeeds,
- first apply brings up full stack successfully.

**Recommendation:**
- Run and gate a deterministic install/setup smoke scenario on Docker-capable CI and one clean local machine per release candidate.
- Reuse the implementation plan already documented in `dev/docs/install-setup-reliability-implementation-guide.md`.

### 5) Error style consistency across install branches (Medium)

Observed install branches vary in depth and helpfulness (excellent no-runtime branch, terse forced-runtime Docker branch). This inconsistency can increase support load.

**Recommendation:**
- Standardize installer error templates: problem, cause, immediate fix, verification command, docs link.

## Release recommendation

**Recommendation: do not cut v1 until at least items 1 and 4 are addressed.**

Reason:
- Item 1 is a high-probability first-run support issue (daemon not running is common).
- Item 4 is a release-confidence gap against the primary product promise (fast setup through admin wizard).

Items 2, 3, and 5 can ship in the same patch if schedule allows, but they are secondary to first-run success and supportability.
