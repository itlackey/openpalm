# Manual Setup Readiness Review (Pre-v1)

Date: 2026-02-25  
Tester: Codex (manual CLI-first simulation in clean container)

## Scope

This review focused on mimicking a new user install and first setup flow as closely as possible from the command line:

1. Run installer entrypoint (`install.sh`) the same way public docs advertise.
2. Run CLI install directly (`openpalm install`) with and without runtime override.
3. Run development setup path (`dev:setup`, `dev:build`) to compare UX and preflight behavior.
4. Capture release-readiness gaps, with a critical bias toward first-run success.

## Environment

- Linux container
- Bun 1.2.14
- No Docker, Podman, or OrbStack installed

## Manual test steps and outcomes

| Step | Command | Result | Notes |
|---|---|---|---|
| 1 | `bun install` | Pass | Dependencies installed cleanly. |
| 2 | `bash ./install.sh --no-open` | Partial | Wrapper downloaded CLI and delegated to installer. Install failed correctly due to missing runtime. |
| 3 | `~/.local/bin/openpalm --help` | Pass | Help output is clear and complete for top-level command list. |
| 4 | `bun run packages/cli/src/main.ts install --help` | Pass (after fix) | Previously executed install flow instead of help. Now prints help and exits 0. |
| 5 | `bun run packages/cli/src/main.ts install --no-open` | Pass (expected fail mode) | Correct hard-fail when no runtime is detected; actionable guidance printed. |
| 6 | `bun run packages/cli/src/main.ts install --runtime docker --no-open` | Improved fail mode | Now includes explicit daemon-unavailable error and issue-report link context. |
| 7 | `bun run dev:setup` | Pass with warning | Setup script works, but emits non-portable `cp -n` warnings. |
| 8 | `bun run preflight` | Pass | Dev preflight passed in this environment. |
| 9 | `bun run dev:build` | Fail | Fails immediately because `docker` is missing despite preflight pass. |

## Critical findings before v1 release

### 1) `openpalm install --help` behavior was wrong (fixed in this patch)

**Impact:** Users trying to discover install options could trigger runtime checks/errors instead of seeing help text. This creates distrust and a poor first impression.

**Status:** Fixed. `install --help` and `install -h` now short-circuit to CLI help output.

### 2) Forced runtime (`--runtime docker`) daemon failure lacked explicit error framing (improved in this patch)

**Impact:** Previously the command exited after a warning, which looked abrupt and did not clearly communicate that this is a hard stop.

**Status:** Improved. Installer now emits an explicit fatal error and includes a prefilled issue link with environment context.

### 3) Installer checksum behavior is too weak for v1 security posture

`install.sh` currently proceeds when the checksum file is unavailable and only prints a warning.

**Impact:** First-install path can succeed without integrity verification. For a security-sensitive gateway product, this is weak default behavior.

**Recommendation (v1 target):**
- Prefer fail-closed integrity verification for release artifacts.
- If checksum is intentionally optional, clearly document threat tradeoffs and provide a signature-based verification path.

### 4) Dev preflight result is misleading relative to `dev:build`

`bun run preflight` passed, but `bun run dev:build` immediately failed on missing Docker.

**Impact:** Contributors and testers get a false “all clear” before hitting a guaranteed failure in next step.

**Recommendation (v1 target):**
- Align `dev preflight` checks with `dev:build` requirements (or rename output to clarify limited coverage).
- Include explicit runtime binary and compose command existence checks in the dev preflight path.

### 5) `dev:setup` portability warnings should be cleaned up

The script emits `cp: warning: behavior of -n is non-portable...`.

**Impact:** No functional breakage observed, but noisy warnings reduce trust and suggest shell portability debt.

**Recommendation (v1 target):**
- Replace `cp -n` usage with a POSIX-safe pattern or use the suggested `--update=none` where supported with fallback.

## Recommended release gate before first public v1

1. **Hard gate:** Ensure install help and installer failure messaging UX tests exist and run in CI.
2. **Security gate:** Decide and implement release-artifact integrity policy (fail-open vs fail-closed) before broad launch.
3. **DX gate:** Make dev preflight truthful about whether `dev:build` can run.
4. **Polish gate:** Remove shell portability warnings from setup scripts.

## Overall release readiness verdict

**Not ready for a polished v1 release yet.**

Core behavior is close, and the installer failure paths are mostly actionable. However, checksum policy, dev preflight consistency, and shell warning polish should be addressed before marketing this as a first stable release.
