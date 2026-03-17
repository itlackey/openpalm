# OpenPalm Install & Setup Process — Critical Review and Recommendations

**Date:** 2026-03-17
**Scope:** End-to-end review from `curl | bash` through setup wizard completion and container startup.

---

## Executive Summary

The install pipeline is well-structured with good layering (shell bootstrap → CLI binary → setup wizard → Docker Compose). However, there are **22 issues** across 5 severity tiers that can cause silent failures, dangling state, or security gaps. The most critical gaps are: no integrity verification of the CLI binary download, no retry logic on asset fetches during bootstrap, a hard-coded setup wizard port with no collision detection, and several race conditions during container startup.

---

## 1. Shell Bootstrap Scripts (`scripts/setup.sh`, `scripts/setup.ps1`)

### 1.1 — CRITICAL: No checksum verification of CLI binary

**File:** `scripts/setup.sh:80`
```bash
curl -fsSL "https://github.com/…/${BINARY}" -o "${DEST}"
chmod +x "${DEST}"
```

The downloaded binary is executed immediately with no SHA-256 or GPG signature verification. A compromised CDN or MITM could deliver a malicious binary.

**Recommendation:** Publish a `checksums.txt` file alongside each release (already done for varlock). Verify after download:
```bash
EXPECTED_SHA256="$(curl -fsSL "${CHECKSUMS_URL}" | grep "${BINARY}" | awk '{print $1}')"
ACTUAL_SHA256="$(sha256sum "${DEST}" | awk '{print $1}')"
[ "$EXPECTED_SHA256" = "$ACTUAL_SHA256" ] || die "Checksum mismatch"
```

### 1.2 — HIGH: No retry logic on CLI binary download

**File:** `scripts/setup.sh:80`

A single `curl -fsSL` with no `--retry`. GitHub release CDN returns transient 502/503 errors regularly. The Dockerfiles already use `--retry 5 --retry-delay 10 --retry-all-errors` for varlock; the bootstrap script should do the same.

**Recommendation:**
```bash
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
  "https://github.com/…/${BINARY}" -o "${DEST}"
```

### 1.3 — MEDIUM: PowerShell script has no retry logic

**File:** `scripts/setup.ps1:67`

`Invoke-WebRequest` has no retry. Use `-MaximumRetryCount 5 -RetryIntervalSec 5` (PowerShell 7.1+) or wrap in a retry loop for older versions.

### 1.4 — MEDIUM: Windows script only supports x64

**File:** `scripts/setup.ps1:8`

`$Binary = 'openpalm-cli-windows-x64.exe'` is hardcoded. ARM64 Windows devices (Surface Pro X, Snapdragon laptops) are increasingly common. At minimum, detect architecture and warn; ideally provide an ARM64 build.

### 1.5 — LOW: `$PATH` modification is session-only (bash)

**File:** `scripts/setup.sh:97`

`export PATH=` only affects the current shell. After the install `exec`s the CLI, the user's next terminal session won't find `openpalm`. The warning message is good, but consider also appending to `~/.bashrc` / `~/.zshrc` with user confirmation (like `rustup` does).

### 1.6 — LOW: GitHub API rate limiting on latest version lookup

**File:** `scripts/setup.sh:69`

Unauthenticated GitHub API calls are limited to 60/hour per IP. CI/CD pipelines or shared build hosts could hit this. Consider falling back to scraping the redirect from `https://github.com/{repo}/releases/latest` (302 response header contains the tag).

---

## 2. CLI Bootstrap Install (`packages/cli/src/commands/install.ts`)

### 2.1 — CRITICAL: No retry logic on `fetchAsset()`

**File:** `packages/cli/src/lib/docker.ts:33-48`

`fetchAsset()` makes a single `fetch()` attempt per URL (release URL, then raw fallback). No retries. If GitHub returns a transient error on both URLs, the install fails with a cryptic message. The `docker-compose.yml` and `Caddyfile` downloads are **not** wrapped in try/catch — they throw and abort the entire install.

**Recommendation:** Add retry with exponential backoff:
```typescript
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.ok) return res;
    if (i < retries - 1) await Bun.sleep(1000 * 2 ** i);
  }
  throw new Error(`Failed after ${retries} attempts: ${url}`);
}
```

### 2.2 — HIGH: Critical assets vs. optional assets have inconsistent error handling

**Files:** `install.ts:112-117` vs `install.ts:137-146`

`docker-compose.yml` and `Caddyfile` throw on failure (correct — these are required). But schema files (`secrets.env.schema`, `stack.env.schema`) also throw on failure (lines 120-125) even though they're only needed for validation. Meanwhile, `ollama.yml`, `AGENTS.md`, etc. are wrapped in try/catch. This inconsistency means a schema download failure aborts the install unnecessarily.

**Recommendation:** Wrap schema downloads in try/catch with a warning, or explicitly document which assets are required vs. optional.

### 2.3 — HIGH: Setup wizard port (8100) hardcoded with no collision detection

**File:** `install.ts:18`, `install.ts:200`

Port 8100 is hardcoded. If another process (or a previous failed install) occupies 8100, `Bun.serve()` will throw a generic error. There is no detection, no fallback port, and no clear error message.

**Recommendation:**
```typescript
function findAvailablePort(preferred: number): number {
  // try preferred, then preferred+1, etc.
}
```
Or at minimum, catch the bind error and print: `"Port 8100 is in use. Stop the conflicting process or set OPENPALM_SETUP_PORT=<port>"`.

### 2.4 — HIGH: `docker compose pull` failure is silently swallowed

**File:** `install.ts:228-230`
```typescript
await runDockerCompose([...composeArgs, 'pull', ...allServices]).catch(() => {
  // Pull failure is non-fatal — images may already be cached
});
```

This is dangerous on first install. If pull fails and there are no cached images, the subsequent `docker compose up` will fail with an unhelpful "image not found" error. The catch should distinguish between "already cached" and "network failure on first install."

**Recommendation:** Check if images exist locally before silencing pull failures:
```typescript
const imagesExist = await checkLocalImages(allServices);
if (!imagesExist) {
  // Pull is required, don't silently catch
  await runDockerCompose([...composeArgs, 'pull', ...allServices]);
}
```

### 2.5 — MEDIUM: Race condition between wizard completion and deploy status polling

**File:** `install.ts:244-245`
```typescript
await new Promise(resolve => setTimeout(resolve, 3000));
```

A hardcoded 3-second delay for the browser to poll final deploy status is fragile. If the browser is slow or the tab is backgrounded, it misses the final status. The wizard server shuts down and the browser shows a stale "Starting..." state.

**Recommendation:** Use a proper shutdown signal: have the browser send an acknowledgment, or use Server-Sent Events / WebSocket for push-based status updates instead of polling + timed shutdown.

### 2.6 — MEDIUM: `ensureSecrets()` uses `USER` env var which may not exist

**File:** `env.ts:127`
```typescript
const userId = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'default_user';
```

In Docker, CI/CD, or WSL environments, none of these may be set, resulting in `MEMORY_USER_ID=default_user`. This is a poor default for a multi-user system. Consider using `os.userInfo().username` as the primary source.

### 2.7 — MEDIUM: No validation that Docker has sufficient resources

The install checks Docker is running but not whether it has enough memory/CPU allocated. Docker Desktop defaults to 2GB RAM, which may be insufficient for the full stack (caddy + memory + assistant + guardian + scheduler + admin + docker-socket-proxy). Users will get cryptic OOM kills.

**Recommendation:** Query `docker info --format '{{.MemTotal}}'` and warn if < 4GB.

### 2.8 — LOW: `openBrowser()` on Linux assumes `xdg-open` is installed

**File:** `docker.ts:103`

Headless Linux servers or minimal WSL installs don't have `xdg-open`. The error is silently caught, but the user gets no feedback about where the wizard URL is.

**Recommendation:** Always print the URL prominently to the terminal regardless of whether browser launch succeeds.

---

## 3. Setup Wizard (`packages/cli/src/setup-wizard/server.ts`)

### 3.1 — HIGH: No CSRF or origin validation on setup API

**File:** `server.ts:202-226`

The setup wizard serves on `127.0.0.1:8100` with no CSRF tokens, no `Origin` header validation, and no `SameSite` cookies. A malicious webpage opened in the same browser session could POST to `http://localhost:8100/api/setup/complete` with crafted JSON and configure the stack with attacker-chosen settings (e.g., pointing to a malicious LLM provider).

**Recommendation:** Validate `Origin` / `Referer` headers on all POST endpoints. Alternatively, generate a one-time CSRF token and require it in a custom header.

### 3.2 — MEDIUM: No timeout on wizard completion

**File:** `install.ts:209`
```typescript
const result = await wizard.waitForComplete();
```

If the user closes their browser or walks away, the install process blocks indefinitely. There's no timeout, no heartbeat, and no way to cancel.

**Recommendation:** Add a configurable timeout (e.g., 30 minutes) with a clear message:
```typescript
const result = await Promise.race([
  wizard.waitForComplete(),
  timeout(30 * 60 * 1000, 'Setup wizard timed out. Re-run: openpalm install'),
]);
```

### 3.3 — MEDIUM: `performSetup()` error is not validated before marking complete

**File:** `server.ts:216`
```typescript
const input = body as SetupInput;
```

The request body is cast directly to `SetupInput` with no schema validation. While `performSetup()` may validate internally, a malformed payload could cause unexpected errors deep in the setup logic rather than a clean 400 response at the API boundary.

**Recommendation:** Validate the input shape with a schema (Zod, etc.) before passing to `performSetup()`.

---

## 4. Docker Compose & Container Startup

### 4.1 — HIGH: Health check for assistant uses TCP probe, not application-level check

**File:** `docker-compose.yml:107`
```yaml
test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/4096' || exit 1"]
```

A TCP port being open doesn't mean the application is ready to serve requests. Services that depend on `assistant` (`guardian`, `scheduler`) via `condition: service_healthy` may start before the assistant's HTTP server is fully initialized.

**Recommendation:** Use an HTTP health endpoint like all other services:
```yaml
test: ["CMD-SHELL", "curl -sf http://localhost:4096/health || exit 1"]
```

### 4.2 — HIGH: Duplicate varlock fetch stage across Dockerfiles

**Files:** `core/admin/Dockerfile:39-59`, `core/assistant/Dockerfile:8-28`

The varlock download stage is copy-pasted across multiple Dockerfiles. If checksums or versions need updating, each file must be changed independently — a maintenance hazard that could lead to version drift.

**Recommendation:** Extract into a shared base image or use a build ARG from a single source of truth (e.g., a `varlock.env` file consumed by all Dockerfiles).

### 4.3 — HIGH: `curl | bash` pattern used in Dockerfiles for OpenCode and Bun

**Files:** `core/admin/Dockerfile:78,83`, `core/assistant/Dockerfile:51,72`
```dockerfile
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash
RUN curl -fsSL https://bun.sh/install | bash
```

This is a supply-chain risk. If `opencode.ai` or `bun.sh` is compromised, the build is compromised. The version is pinned but there's no checksum verification of the install script itself or the downloaded binary.

**Recommendation:**
1. Download install scripts as a separate `RUN` layer and verify their checksum.
2. Or better: download the binary directly from a known URL with checksum verification (like varlock does).
3. At minimum, use `--fail` to ensure curl fails loudly on HTTP errors.

### 4.4 — MEDIUM: No `start_period` on memory health check

**File:** `docker-compose.yml:58-60`

The memory service has no `start_period`, meaning health checks begin immediately on container start. If the service takes a few seconds to initialize, it may be marked unhealthy prematurely. Other services do have `start_period` defined.

**Recommendation:** Add `start_period: 10s` to the memory service healthcheck.

### 4.5 — MEDIUM: Admin container mounts host XDG paths bidirectionally

**File:** `docker-compose.yml:253-255`
```yaml
volumes:
  - ${OPENPALM_CONFIG_HOME}:${OPENPALM_CONFIG_HOME}
  - ${OPENPALM_STATE_HOME}:${OPENPALM_STATE_HOME}
  - ${OPENPALM_DATA_HOME}:${OPENPALM_DATA_HOME}
```

The admin container has full read-write access to the host's config, state, and data directories. Combined with the Docker socket proxy, a compromised admin container could modify host files. Consider making `CONFIG_HOME` read-only (`:ro`) since the admin should primarily read config, not write it directly.

### 4.6 — LOW: Guardian healthcheck doesn't verify response status

**File:** `docker-compose.yml:144`
```yaml
test: ["CMD-SHELL", "bun -e \"await fetch('http://localhost:8080/health')\" || exit 1"]
```

This only checks that `fetch()` doesn't throw (i.e., the TCP connection succeeds). A 500 response would still pass. Compare with memory's check which explicitly checks `r.ok`.

**Recommendation:**
```yaml
test: ["CMD-SHELL", "bun -e \"const r=await fetch('http://localhost:8080/health');if(!r.ok)process.exit(1)\" || exit 1"]
```

---

## 5. Entrypoint Scripts

### 5.1 — MEDIUM: Assistant entrypoint has no readiness signal

**File:** `core/assistant/entrypoint.sh`

The entrypoint runs `exec opencode web ...` but there's no mechanism to confirm the web server is actually listening before the health check `start_period` expires. If OpenCode takes longer than 30 seconds to start (e.g., downloading plugins on first run), the container will be killed and restarted.

**Recommendation:** Add a startup probe or increase `start_period` to 60s. Consider adding a readiness loop in the entrypoint that waits for the port before exec'ing.

### 5.2 — MEDIUM: Admin entrypoint runs OpenCode in background without health monitoring

**File:** `core/admin/entrypoint.sh:40`
```bash
opencode web ... &
OPENCODE_PID=$!
```

If the background OpenCode process crashes, the admin container continues running but the admin AI assistant is silently broken. The cleanup trap only fires on container exit.

**Recommendation:** Add a background health-check loop or use a process supervisor (supervisord, s6-overlay) to restart OpenCode if it crashes.

### 5.3 — LOW: `socat` proxy has no health check or error handling

**File:** `core/assistant/entrypoint.sh:157`
```bash
socat TCP-LISTEN:1234,reuseaddr,fork TCP:"${target_host}":"${target_port}" &
```

The socat process runs as a background job with no monitoring. If it crashes, LM Studio requests silently fail with connection refused.

---

## 6. Configuration & Environment

### 6.1 — MEDIUM: Docker socket detection is simplistic

**File:** `packages/cli/src/lib/paths.ts:21`
```typescript
return IS_WINDOWS ? '//./pipe/docker_engine' : '/var/run/docker.sock';
```

This misses OrbStack (`~/.orbstack/run/docker.sock`), Colima (`~/.colima/default/docker.sock`), Rancher Desktop (`~/.rd/docker.sock`), and Podman (`/run/user/$UID/podman/podman.sock`). The `ensureStackEnv` function in the CLI references socket detection, but `defaultDockerSock()` doesn't check for these alternatives.

**Recommendation:** Check known paths in priority order, or use `docker context inspect --format '{{.Endpoints.docker.Host}}'` to discover the active socket.

---

## Summary of Recommendations by Priority

### Must-Fix (Critical/High — blocks reliable installs)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.1 | CLI binary download has no checksum verification | Small — publish checksums file |
| 1.2 | No retry on CLI binary download | Trivial — add `--retry` flags |
| 2.1 | No retry on `fetchAsset()` | Small — wrap fetch in retry loop |
| 2.3 | Setup wizard port collision undetected | Small — port availability check |
| 2.4 | Silent pull failure on first install | Medium — check local image cache |
| 3.1 | No CSRF on setup wizard API | Medium — Origin header validation |
| 4.1 | Assistant health check is TCP-only | Trivial — switch to HTTP |
| 4.3 | `curl \| bash` in Dockerfiles without verification | Medium — pin + verify scripts |

### Should-Fix (Medium — degrades experience or security)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.3 | PowerShell has no retry | Trivial |
| 2.5 | Hardcoded 3s poll delay | Small |
| 2.6 | `MEMORY_USER_ID` defaults poorly | Trivial |
| 2.7 | No Docker resource validation | Small |
| 3.2 | No wizard timeout | Small |
| 3.3 | No input schema validation | Small |
| 4.2 | Varlock fetch duplicated across Dockerfiles | Medium |
| 4.4 | Memory healthcheck missing `start_period` | Trivial |
| 4.5 | Admin has write access to host config dirs | Trivial — add `:ro` |
| 5.1 | Assistant has no readiness signal | Small |
| 5.2 | Admin background OpenCode not monitored | Medium |
| 6.1 | Docker socket detection incomplete | Small |

### Nice-to-Fix (Low — polish)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.4 | Windows ARM64 unsupported | Medium |
| 1.5 | PATH not persisted | Small |
| 1.6 | GitHub API rate limiting | Trivial |
| 2.8 | `xdg-open` assumed on Linux | Trivial |
| 4.6 | Guardian healthcheck doesn't check status | Trivial |
| 5.3 | Socat proxy unmonitored | Small |

---

## Appendix: Recommended Install Flow (Target State)

```
User runs: curl -fsSL .../setup.sh | bash
  │
  ├─ Download CLI binary with retry (5x) + checksum verification
  ├─ Verify PATH, persist if user agrees
  └─ exec openpalm install
       │
       ├─ Check Docker: installed, running, compose v2, ≥4GB RAM
       ├─ Create XDG directory tree
       ├─ Download assets with retry (3x exponential backoff)
       │   ├─ Required: docker-compose.yml, Caddyfile (fail-fast)
       │   └─ Optional: schemas, agents, automations (warn + continue)
       ├─ Seed config files (secrets.env, stack.env)
       ├─ Validate config (non-fatal)
       │
       ├─ [First install] Start setup wizard
       │   ├─ Detect available port (8100 preferred)
       │   ├─ Validate Origin header on all POST requests
       │   ├─ Timeout after 30 minutes
       │   └─ On completion → stage artifacts
       │
       ├─ Pull images (required on first install, optional on update)
       ├─ docker compose up -d
       ├─ Wait for all health checks to pass (with timeout)
       └─ Print success + admin URL
```
