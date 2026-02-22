# Install / Uninstall Critical Review — v1 Readiness

**Date:** 2026-02-22
**Scope:** End-to-end review of `install.sh`, `install.ps1`, CLI `install` command, CLI `uninstall` command, `uninstall.sh`, `uninstall.ps1`, state generation, PATH management, and container orchestration.

---

## Executive Summary

The install flow is well-structured: a thin shell wrapper downloads a compiled Bun binary, which then handles XDG directory creation, secret generation, config seeding, minimal compose deployment, and health-check polling. The architecture is sound. However, there are **22 concrete issues** ranging from silent data loss risks to cross-platform gaps that should be addressed before v1. This document groups them by severity.

---

## Critical Issues (will break installs for some users)

### 1. `OPENPALM_IMAGE_NAMESPACE` is never written to `.env` during install

**File:** `packages/cli/src/commands/install.ts:117-129`

The install command writes `OPENPALM_IMAGE_TAG` to `.env` (line 127) but never writes `OPENPALM_IMAGE_NAMESPACE`. The minimal compose file references `${OPENPALM_IMAGE_NAMESPACE:-openpalm}` so the default works, but:

- The full production compose file (`assets/state/docker-compose.yml`) also uses it.
- If the admin wizard regenerates the compose file, it relies on `system.env` which is only a placeholder (`# Generated system env — populated on first stack apply`).
- The `system.env` template at `packages/lib/assets/templates/system.env` defines `OPENPALM_IMAGE_NAMESPACE=openpalm`, but `seedConfigFiles()` only seeds `openpalm.yaml` and `secrets.env` — not `system.env`.

**Risk:** On first stack apply, if the admin service writes a new `system.env` that doesn't include `OPENPALM_IMAGE_NAMESPACE`, image pulls will fail with an empty namespace.

**Fix:** Add `OPENPALM_IMAGE_NAMESPACE` to the `upsertEnvVars` call at line 117, or ensure `seedConfigFiles` also seeds `system.env` into the state directory.

### 2. Windows XDG paths use Unix separators (`~/.local/share/openpalm`)

**File:** `packages/lib/src/paths.ts:6-23`

On Windows, `homedir()` returns `C:\Users\<user>`. The fallback path becomes `C:\Users\<user>\.local\share\openpalm`. While `node:path.join` handles separators correctly, the resulting path:
- Uses a `.local` directory which doesn't exist on Windows and is unconventional.
- Docker Desktop for Windows expects Windows-style paths for bind mounts in Compose files, but the compose file templates use `${OPENPALM_DATA_HOME}` which will contain backslashes.

**Risk:** Docker Compose bind mounts silently fail or create wrong paths on Windows.

**Fix:** On Windows, default to `%LOCALAPPDATA%\OpenPalm\data`, `%LOCALAPPDATA%\OpenPalm\config`, `%LOCALAPPDATA%\OpenPalm\state` (matching the PowerShell installer's install location pattern). Also ensure compose-file variable interpolation handles Windows paths (or normalize to forward slashes before writing to `.env`).

### 3. `install.sh` doesn't work when piped with arguments

**File:** `assets/state/scripts/install.sh:10-11`

The documented usage is:
```bash
curl -fsSL ... | bash
```

But arguments like `--runtime docker` cannot be passed this way because stdin is consumed by curl. The common pattern is:
```bash
curl -fsSL ... | bash -s -- --runtime docker
```

The script uses `$#` and `$1` which are empty when piped without `-s --`.

**Risk:** Users who try to pass arguments via the documented pipe pattern will get no arguments passed through.

**Fix:** Document the `-s --` pattern for passing arguments, or implement a two-phase approach: download-then-execute.

### 4. The `composePull` timeout of 30 seconds is too short for first install

**File:** `packages/lib/src/compose.ts:13-48`

`composeExec` defaults to 30s timeout for piped output. `composePull` uses `stream: true` which sets timeout to 0 (no timeout) — so this is actually fine for the pull. However, the `composeUp` call also uses `stream: true`.

But the broader issue: if `composePull` is invoked from the admin service (not the CLI) via `compose-runner.ts`, the admin's compose runner (`packages/lib/admin/compose-runner.ts`) spawns processes differently and may have its own timeout behavior. Verify the admin-initiated pull (which downloads ALL images) has no timeout that would kill a slow first-time pull.

### 5. No `windows-arm64` build target in package.json

**File:** `packages/cli/package.json:29-37`

Build scripts include `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64` — but **no `windows-arm64`**. The README (`packages/cli/README.md:46`) references `build:windows-arm64` which doesn't exist.

The install.ps1 script correctly detects ARM64 architecture on Windows but will request a binary named `openpalm-windows-arm64.exe` which was never built.

**Risk:** Windows ARM64 users (Surface Pro X, Snapdragon laptops) will get a download failure with no clear explanation.

**Fix:** Add `build:windows-arm64` to package.json scripts. If Bun doesn't support cross-compiling to Windows ARM64 yet, remove ARM64 from the install.ps1 detection logic and document the limitation.

### 6. Socket path is always Unix on Windows

**File:** `packages/lib/src/runtime.ts:55-72`

`resolveSocketPath()` returns `/var/run/docker.sock` for Docker on all platforms including Windows. Docker Desktop for Windows uses a named pipe (`//./pipe/docker_engine`) or the WSL2 socket.

The compose file then tries to mount `/var/run/docker.sock` which doesn't exist on native Windows.

**Risk:** The admin container cannot communicate with Docker on Windows, breaking the admin wizard's ability to pull and start remaining services.

**Fix:** For Windows, detect the Docker socket type:
- Docker Desktop (Hyper-V): `//./pipe/docker_engine`
- Docker Desktop (WSL2): `/var/run/docker.sock` (only within WSL)
- If running in WSL2 natively, the current path works

Consider detecting WSL2 (`uname -r` contains `microsoft`) to differentiate.

---

## High-Severity Issues (degraded experience, potential data loss)

### 7. Uninstall does not remove the CLI binary itself

**Files:** `packages/cli/src/commands/uninstall.ts`, `assets/state/scripts/uninstall.sh`, `assets/state/scripts/uninstall.ps1`

All uninstall paths remove containers, data directories, and `.env` files, but none remove:
- The `openpalm` binary from `~/.local/bin/openpalm` (Linux/macOS)
- The `openpalm.exe` from `%LOCALAPPDATA%\OpenPalm` (Windows)
- The `~/openpalm` working directory

Additionally, the Windows uninstaller doesn't clean up the PATH entry it added during install.

**Fix:** Add `--remove-binary` flag (or include it in `--remove-all`) that:
1. Removes the binary from the install location
2. On Windows, removes the install dir from the user PATH
3. Optionally removes `~/openpalm` working directory (with explicit confirmation since it may contain user data)

### 8. `uninstall.sh` script assumes it runs from the repo root

**File:** `assets/state/scripts/uninstall.sh:4-8`

```bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ ! -d "$ROOT_DIR/assets" ]; then
  ROOT_DIR="$(pwd)"
fi
cd "$ROOT_DIR"
```

The script resolves `ROOT_DIR` relative to the script's parent directory and falls back to `$(pwd)`. This is fragile:
- After install, the script is copied to `$OPENPALM_STATE_HOME/uninstall.sh` — its parent directory is the state home, not the repo.
- The fallback `$(pwd)` may be anywhere.
- The `.env` file is then read from `$ROOT_DIR/.env`, which may not exist.

The CLI `uninstall` command (`packages/cli/src/commands/uninstall.ts`) handles this better by reading from `$OPENPALM_STATE_HOME/.env` first.

**Fix:** The shell uninstall script should either:
1. Read `.env` from the XDG state path directly (like the CLI does), or
2. Simply delegate to `openpalm uninstall` (like the installed script already does at line 149-151 of install.ts)

Consider removing the standalone `uninstall.sh` from the public scripts since it duplicates logic, and the installed version at `$OPENPALM_STATE_HOME/uninstall.sh` already just calls `openpalm uninstall`.

### 9. `.env` is written to `process.cwd()`, creating location-dependent state

**File:** `packages/cli/src/commands/install.ts:83`

```typescript
const envPath = join(process.cwd(), ".env");
```

The `.env` is created in whatever directory the user happens to be in when they run `openpalm install`. If they later run `openpalm start` from a different directory, the management commands use `loadComposeConfig()` which reads from `$OPENPALM_STATE_HOME/.env` (correct), but:

- The CWD `.env` and the state `.env` can drift apart (the state copy is written once at install line 138 and never updated after that).
- The uninstall command reads from `$OPENPALM_STATE_HOME/.env` first, then falls back to CWD `.env` — but CWD `.env` may be stale.
- If the user re-runs `openpalm install` from a different directory, a new `.env` is created there while the old one remains.

**Fix:** The canonical `.env` should be `$OPENPALM_STATE_HOME/.env`. Write it there and symlink or copy to CWD only for user convenience. After install, all management commands should exclusively use the state-home copy. Remove the CWD fallback from the uninstall command.

### 10. Admin token displayed but not reliably persisted

**File:** `packages/cli/src/commands/install.ts:86-113`

The generated admin token is:
1. Written to the CWD `.env` file (line 99)
2. Displayed on screen (line 106)
3. Copied to `$OPENPALM_STATE_HOME/.env` (line 138)

But if the user already has a `.env` file (line 84 check), no admin token is generated or shown. The existing `.env` might have `ADMIN_TOKEN=change-me-admin-token` (the compose default) if the user created the file manually.

**Risk:** Users who created a `.env` file before running install get the default insecure admin token.

**Fix:** After detecting an existing `.env`, check if `ADMIN_TOKEN` is set to the insecure default. If so, generate a new one and update it.

### 11. Race condition between `.env` write and compose copy

**File:** `packages/cli/src/commands/install.ts:97-138`

The `.env` file is:
1. Created at line 99 with secrets only
2. Updated at line 117-129 with runtime vars
3. Copied to state home at line 138

If the install crashes between steps 1 and 3, the state home has no `.env`. On re-run, the CWD `.env` exists so secrets aren't regenerated, but the copy to state home may still not happen if the crash point repeats.

**Fix:** Use atomic file operations: write to a temp file, then rename. Or better, write to state home first and symlink to CWD.

---

## Medium-Severity Issues (correctness, edge cases)

### 12. `df -k` parsing fails on some Linux distributions

**File:** `packages/lib/src/preflight.ts:15-38`

The disk space check parses `df -k` output assuming the "Available" column is at index 3. On some systems (e.g., when the filesystem name is long), `df` wraps output to two lines, making the parse fail silently.

**Fix:** Use `df -Pk` (POSIX mode) which guarantees single-line output per filesystem.

### 13. Port 80 check doesn't work on systems requiring elevated privileges

**File:** `packages/lib/src/preflight.ts:45-81`

`lsof` requires root on many Linux systems to see other users' ports. `ss -tlnp` also needs root to show process names. If the user runs the installer as a non-root user:
- `lsof` may return exit code 1 (no results due to permissions, not because port is free)
- `ss` output may not include `:80` even if something is listening

The catch logic falls through and reports port 80 as available even when it's not.

**Fix:** Try `ss -tln` (without `-p`) which doesn't require root and still shows listening ports. Or bind a test socket to port 80 briefly to detect conflicts.

### 14. `$HOME/openpalm` working directory is hardcoded in compose files

**Files:** `packages/lib/src/paths.ts:51`, `packages/lib/admin/stack-generator.ts:506,566`, `packages/cli/src/commands/install.ts:254`

The compose files mount `${HOME}/openpalm:/work`. This:
- Doesn't respect XDG conventions (data directories are under `$OPENPALM_DATA_HOME`)
- Creates a directory in the user's home root which is unconventional on macOS/Linux
- On multi-user systems, `$HOME` inside Docker may resolve differently

**Fix:** Make the working directory configurable via an env var (`OPENPALM_WORK_HOME`) with `${HOME}/openpalm` as the default. This allows users to point it elsewhere.

### 15. Podman compose support is untested / incomplete

**File:** `packages/lib/src/runtime.ts:74-81`

The code assumes `podman compose` works identically to `docker compose`. However:
- Podman Compose has compatibility differences (rootless networking, volume permissions, healthcheck syntax).
- The compose file uses Docker-specific features like `healthcheck` with `CMD` format, which some podman-compose versions interpret differently.
- The admin container mounts the Docker socket; for Podman this needs to be the Podman socket with potentially different in-container paths.
- `OPENPALM_CONTAINER_SOCKET_IN_CONTAINER` is hardcoded to `/var/run/docker.sock` even for Podman.

**Fix:** If Podman is a v1 target, add integration tests. If not, clearly document it as "experimental" in the installer output and in docs. At minimum, set `OPENPALM_CONTAINER_SOCKET_IN_CONTAINER` to the appropriate path for Podman.

### 16. No idempotency guard on `openpalm install`

**File:** `packages/cli/src/commands/install.ts:14-380`

Running `openpalm install` twice:
1. Skips `.env` generation (`.env` already exists) — good
2. Rewrites XDG env vars into `.env` — fine
3. Recreates directory tree — fine (recursive mkdir)
4. Overwrites `$OPENPALM_STATE_HOME/.env` with the CWD `.env` — potentially bad if state `.env` has been modified
5. Seeds config files — only if they don't exist — good
6. Deletes `setup-state.json` — resets the wizard — **bad for a running system**
7. Overwrites `docker-compose.yml` in state home with the minimal compose — **very bad for a running system that has the full compose**
8. Pulls and starts caddy + admin — may conflict with already-running services

**Risk:** Running `openpalm install` on an already-installed system destroys the full compose file and resets the setup wizard.

**Fix:** Add an installation state check. If OpenPalm is already installed (compose file exists and contains more than just caddy+admin), warn the user and suggest `openpalm update` instead. Add a `--force` flag to override.

### 17. `compose pull` error is unhandled gracefully

**File:** `packages/cli/src/commands/install.ts:279-281`

If `composePull` fails (network error, invalid image tag, Docker Hub rate limit), it throws and the top-level catch in `main.ts` prints the error and exits. But:
- The minimal compose file and `.env` have already been written
- Docker may be in a partially-pulled state
- The user gets no guidance on how to resume

**Fix:** Catch the pull failure explicitly, print actionable guidance ("Retry with `openpalm install` or manually run `docker compose pull`"), and ensure the state files are left in a consistent resumable state.

---

## Low-Severity Issues (polish, robustness)

### 18. `install.sh` hardcodes GitHub release URL format

**File:** `assets/state/scripts/install.sh:125`

```bash
DOWNLOAD_URL="https://github.com/${OPENPALM_REPO_OWNER}/${OPENPALM_REPO_NAME}/releases/latest/download/${BINARY_NAME}"
```

This follows the "latest release" redirect. If you publish a pre-release tag, GitHub's `/releases/latest/` won't point to it. The `--ref` flag is parsed but never used in the download URL — it's only passed through to `openpalm install`.

**Fix:** If `--ref` is provided, use the GitHub API to resolve the correct release URL, or at minimum use `/releases/tags/<ref>/download/` instead of `/releases/latest/`.

### 19. Env file parsing doesn't handle quoted values

**File:** `packages/lib/src/env.ts:24-28`

```typescript
const value = trimmed.substring(eqIndex + 1).trim();
```

If a user writes `ADMIN_TOKEN="my-token"` or `ADMIN_TOKEN='my-token'` (common in `.env` files), the quotes become part of the value. Docker Compose strips quotes, but the TypeScript env parser does not.

**Fix:** Strip matching leading/trailing single or double quotes from values during parsing.

### 20. Health check polling has no exponential backoff

**File:** `packages/cli/src/commands/install.ts:293-304`

The health check loop polls every 2 seconds for up to 90 iterations (3 minutes). This is fine functionally but creates noisy logs in environments where each failed fetch generates a connection-refused error.

**Fix:** Use exponential backoff starting at 1s and capping at 5s, or at minimum suppress connection-refused errors in the output.

### 21. `uninstall.ps1` uses `$args` (reserved variable) for compose arguments

**File:** `assets/state/scripts/uninstall.ps1:96`

```powershell
$args = @($OpenPalmComposeSubcommand, "--env-file", ...)
```

`$args` is a reserved automatic variable in PowerShell. Assigning to it shadows the built-in `$args` and may cause unexpected behavior in some PowerShell versions.

**Fix:** Rename to `$composeArgs` or similar.

### 22. The `~/openpalm` work directory is not cleaned up on uninstall

**Files:** `packages/cli/src/commands/uninstall.ts`, `assets/state/scripts/uninstall.sh`

The install creates `~/openpalm` (the assistant's working directory). Neither uninstall path removes it, even with `--remove-all`. This directory may accumulate user data, so removing it needs care, but it should at least be mentioned in the uninstall summary.

**Fix:** In the `--remove-all` path, prompt about `~/openpalm` separately (since it may contain user work files). At minimum, print a notice: "Note: ~/openpalm was not removed. Delete it manually if you no longer need it."

---

## Summary Table

| # | Severity | Area | Issue |
|---|----------|------|-------|
| 1 | Critical | Install | `OPENPALM_IMAGE_NAMESPACE` not written to `.env` |
| 2 | Critical | Install | Windows XDG paths use Unix conventions |
| 3 | Critical | Install | Piped `install.sh` can't receive arguments |
| 4 | Critical | Install | Verify admin-initiated pull has no timeout |
| 5 | Critical | Build | No `windows-arm64` build target |
| 6 | Critical | Install | Docker socket path wrong on native Windows |
| 7 | High | Uninstall | CLI binary not removed |
| 8 | High | Uninstall | Shell uninstall script path resolution is fragile |
| 9 | High | Install | `.env` written to CWD creates location-dependent state |
| 10 | High | Install | Admin token may remain at insecure default |
| 11 | High | Install | Race between `.env` write and state copy |
| 12 | Medium | Preflight | `df -k` parsing fails on wrapped output |
| 13 | Medium | Preflight | Port 80 check fails without root |
| 14 | Medium | Install | `~/openpalm` work dir is hardcoded |
| 15 | Medium | Install | Podman compose support gaps |
| 16 | Medium | Install | No idempotency guard on re-install |
| 17 | Medium | Install | `compose pull` failure not handled gracefully |
| 18 | Low | Install | `--ref` flag doesn't affect download URL |
| 19 | Low | Env | Quoted `.env` values not stripped |
| 20 | Low | Install | Health check has no exponential backoff |
| 21 | Low | Uninstall | PowerShell `$args` variable shadowed |
| 22 | Low | Uninstall | `~/openpalm` not mentioned in uninstall |

---

## Recommended Priority for v1

**Must fix before v1:**
- Issues 1, 3, 5, 9, 10, 16 (these will cause the most user-facing failures or confusion)

**Should fix before v1:**
- Issues 2, 6, 7, 8, 12, 15, 17, 19, 21 (significant quality-of-life and correctness)

**Can ship v1 without (but fix soon after):**
- Issues 4, 11, 13, 14, 18, 20, 22 (edge cases and polish)

---

## Architectural Recommendations

### 1. Canonical state location
The `.env` should have one canonical location: `$OPENPALM_STATE_HOME/.env`. The CWD copy should be treated as a convenience symlink or not created at all. All management commands already read from state home — make install do the same.

### 2. Install state tracking
Add an `install-state.json` file to `$OPENPALM_STATE_HOME` that tracks:
- Install timestamp
- CLI version used
- Platform detected
- Phase completed (secrets, dirs, config, compose, pull, up)

This enables resumable installs and prevents destructive re-installs.

### 3. Unified env var handling
Consider generating a single `.env` file during install that includes all needed variables (XDG paths, runtime config, secrets, image namespace/tag). Currently, variables are split across:
- CWD `.env` (some vars)
- `$OPENPALM_STATE_HOME/.env` (copy of CWD)
- `$OPENPALM_STATE_HOME/system.env` (populated later by admin)
- `$OPENPALM_CONFIG_HOME/secrets.env` (user secrets)

This fragmentation makes debugging difficult. A single canonical `.env` with clear sections would be more maintainable.

### 4. Windows support decision
Decide whether Windows is a v1 target. If yes, fix issues 2, 5, 6 and add Windows CI. If no, remove Windows detection from the CLI (the PowerShell scripts can remain as "experimental") and document that Windows users should use WSL2.
