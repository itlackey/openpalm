# OpenPalm Install & Setup Process — Critical Review and Recommendations

**Date:** 2026-03-17
**Scope:** End-to-end review from `curl | bash` through setup wizard completion and container startup.

---

## Executive Summary

The install pipeline is well-structured with good layering (shell bootstrap → CLI binary → setup wizard → Docker Compose). After filtering out over-engineered recommendations that add unnecessary complexity for a local dev tool, there are **24 issues** across 3 severity tiers. The most impactful gaps are: no retry logic on asset fetches during bootstrap, a hard-coded setup wizard port with no collision detection, duplicated Ollama URL resolution logic in `performSetup()`, and non-null assertions that produce cryptic errors on edge cases.

This document includes two parts:
1. **Issues & Recommendations** (sections 1–6) — grouped by pipeline stage
2. **Appendix B: Function-by-Function Trace** — detailed walkthrough of every function in the install/setup path with line references

---

## 1. Shell Bootstrap Scripts (`scripts/setup.sh`, `scripts/setup.ps1`)

### 1.1 — LOW: No checksum verification of CLI binary

**File:** `scripts/setup.sh:80`
```bash
curl -fsSL "https://github.com/…/${BINARY}" -o "${DEST}"
chmod +x "${DEST}"
```

The downloaded binary is executed immediately with no SHA-256 or GPG signature verification. However, the entire install is a `curl | bash` pattern — inherently trust-based. Checksums fetched from the same GitHub release don't meaningfully protect against a compromised CDN (an attacker could serve matching checksums). GPG signing would provide real verification but is heavyweight for a local dev tool installer.

**Recommendation:** Accept this as an inherent limitation of `curl | bash`. If security posture needs strengthening, consider distributing via a package manager (Homebrew, apt) instead, which has its own signing infrastructure.

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

### 2.5 — LOW: Hardcoded 3s poll delay before wizard shutdown

**File:** `install.ts:244-245`
```typescript
await new Promise(resolve => setTimeout(resolve, 3000));
```

A hardcoded 3-second delay for the browser to poll final deploy status. If the browser is slow or backgrounded, it may miss the final status. However, this is a one-time setup wizard — the install succeeds regardless of whether the browser renders the final state. Replacing this with SSE/WebSocket would be significant over-engineering for a UI that runs once.

**Recommendation:** Acceptable as-is. If polish is desired, bump to 5s — but don't add real-time push infrastructure for a one-shot wizard.

### 2.6 — LOW: `ensureSecrets()` uses `USER` env var which may not exist

**File:** `env.ts:127`
```typescript
const userId = process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'default_user';
```

In Docker or CI/CD environments, none of these may be set, resulting in `MEMORY_USER_ID=default_user`. However, this is a single-user local dev tool — `default_user` is a reasonable fallback that works fine. The setup wizard lets users set this explicitly anyway.

### 2.7 — LOW: `openBrowser()` on Linux assumes `xdg-open` is installed

**File:** `docker.ts:103`

Headless Linux servers or minimal WSL installs don't have `xdg-open`. The error is silently caught, but the user gets no feedback about where the wizard URL is.

**Recommendation:** Always print the URL prominently to the terminal regardless of whether browser launch succeeds.

---

## 3. Setup Wizard (`packages/cli/src/setup-wizard/server.ts`)

### 3.1 — LOW: No CSRF or origin validation on setup API

**File:** `server.ts:202-226`

The setup wizard serves on `127.0.0.1:8100` with no CSRF tokens or `Origin` header validation. In theory a malicious webpage could POST to `http://localhost:8100/api/setup/complete`. However, the wizard is short-lived (exits after one completion), bound to localhost only, and protected by the setup token — making this a very low practical risk.

**Recommendation:** No immediate action needed. If the wizard ever becomes long-lived or network-accessible, revisit with Origin header validation.

### 3.2 — LOW: No timeout on wizard completion

**File:** `install.ts:209`
```typescript
const result = await wizard.waitForComplete();
```

If the user closes their browser or walks away, the install process blocks indefinitely. However, the user is sitting at their terminal running an interactive install — they'll Ctrl-C if they walk away. Adding `Promise.race` with a timeout adds code for a non-problem.

**Recommendation:** Acceptable as-is. The user has full control via Ctrl-C.

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

### 4.2 — LOW: Duplicate varlock fetch stage across Dockerfiles

**Files:** `core/admin/Dockerfile:39-59`, `core/assistant/Dockerfile:8-28`

The varlock download stage is copy-pasted across multiple Dockerfiles. However, Dockerfiles are intended to be self-contained and reproducible. Extracting to a shared base image adds multi-stage build dependencies and makes individual Dockerfiles harder to reason about. The version/checksum is pinned and rarely changes — a simple find-and-replace suffices when it does.

**Recommendation:** Accept the duplication. If it becomes a frequent maintenance issue, consider a shared `.env` file with build ARGs, but don't add shared base images for this.

### 4.3 — LOW: `curl | bash` pattern used in Dockerfiles for OpenCode and Bun

**Files:** `core/admin/Dockerfile:78,83`, `core/assistant/Dockerfile:51,72`
```dockerfile
RUN HOME=/usr/local curl -fsSL https://opencode.ai/install | HOME=/usr/local bash
RUN curl -fsSL https://bun.sh/install | bash
```

These are standard install methods for Bun and OpenCode, used across the ecosystem. Versions are pinned. Checksum-verifying install scripts adds build complexity and maintenance burden (checksums change with every release). Docker layer caching provides reproducibility — once built, the layer is fixed.

**Recommendation:** Accept as standard practice. The `-fsSL` flags already ensure curl fails on HTTP errors. If security posture needs strengthening, switch to direct binary downloads, but this is low priority for a local dev tool.

### 4.4 — MEDIUM: No `start_period` on memory health check

**File:** `docker-compose.yml:58-60`

The memory service has no `start_period`, meaning health checks begin immediately on container start. If the service takes a few seconds to initialize, it may be marked unhealthy prematurely. Other services do have `start_period` defined.

**Recommendation:** Add `start_period: 10s` to the memory service healthcheck.

### 4.5 — LOW: Guardian healthcheck doesn't verify response status

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

### 5.1 — LOW: Assistant entrypoint has no readiness signal

**File:** `core/assistant/entrypoint.sh`

The entrypoint runs `exec opencode web ...` but there's no explicit readiness signal before health checks begin. However, `start_period` in the Docker health check already handles this — the container isn't marked unhealthy during the startup grace period. Adding a readiness loop in the entrypoint adds complexity that Docker's health check model already solves.

**Recommendation:** If startup takes longer than the current `start_period`, increase it. Don't add entrypoint-level readiness loops.

### 5.2 — LOW: Admin entrypoint runs OpenCode in background without health monitoring

**File:** `core/admin/entrypoint.sh:40`
```bash
opencode web ... &
OPENCODE_PID=$!
```

If the background OpenCode process crashes, the admin container continues running. However, Docker's restart policy handles container-level crashes, and adding supervisord or s6-overlay inside a container is heavyweight for a local dev tool. The admin AI assistant is a convenience feature, not a critical path.

**Recommendation:** Accept as-is. If this becomes a real problem, add a simple `wait $PID || exit 1` rather than a full process supervisor.

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

## 7. Library Functions (`packages/lib/src/control-plane/`)

### 7.1 — HIGH: `performSetup()` duplicates Ollama URL resolution with `buildSecretsFromSetup()`

**Files:** `setup.ts:249-254` and `setup.ts:350-355`

`buildSecretsFromSetup()` creates its own `effectiveConnections` array with the Ollama in-stack URL override. Then `performSetup()` creates a *second* `effectiveConnections` array with the same logic. The secrets are built from one copy, and the memory config / connection profiles are built from the other. While they produce identical results today, this is a maintenance hazard — a change to one will silently diverge from the other.

**Recommendation:** Call `buildSecretsFromSetup()` from within `performSetup()` using the already-resolved `effectiveConnections`, or extract the Ollama override into a shared helper called once.

### 7.2 — HIGH: `performSetup()` uses non-null assertions on `.find()` results

**File:** `setup.ts:387,392,395`
```typescript
const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId)!;
const llmEnvVar = connEnvVarMap.get(llmConnection.id)!;
const embEnvVar = connEnvVarMap.get(embConnection.id)!;
```

If `validateSetupInput()` passes but the connection ID is subtly wrong (e.g., whitespace difference), `.find()` returns `undefined` and the `!` assertion causes a cryptic `TypeError: Cannot read properties of undefined` deep in the setup flow instead of a clean error.

**Recommendation:** Replace with explicit checks:
```typescript
const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId);
if (!llmConnection) return { ok: false, error: `LLM connection "${llmConnectionId}" not found` };
```

### 7.3 — LOW: `createState()` writes then immediately deletes setup token on every restart

**File:** `lifecycle.ts:79`

`createState()` always calls `writeSetupTokenFile()`, which writes `setup-token.txt` then checks `isSetupComplete()`. If setup is complete, it immediately `unlinkSync`s the file it just wrote. This is a single extra file write on startup — negligible performance impact.

**Recommendation:** Technically fixable with a guard check, but not worth the code churn. The current behavior is correct, just slightly wasteful.

### 7.4 — LOW: `isOllamaEnabled()` re-reads and re-parses `stack.env` on every call

**File:** `staging.ts:48-54`

Called 3 times per lifecycle operation. Each call does `existsSync` + `readFileSync` + regex parse on a small file. This is negligible — reading a few-KB file 3 times is not a performance bottleneck. Caching adds state management complexity for no measurable gain.

**Recommendation:** Accept as-is. This is premature optimization.

### 7.5 — MEDIUM: `resolveHome()` falls back to `/tmp` which is world-writable

**File:** `paths.ts:13`
```typescript
return process.env.HOME ?? "/tmp";
```

If `$HOME` is unset (common in some Docker containers, cron jobs, or systemd services), all XDG paths resolve under `/tmp` (e.g., `/tmp/.config/openpalm`). This is a security issue — other users on the system can read secrets.env. It's also fragile since `/tmp` is often cleared on reboot.

**Recommendation:** Throw an error if `HOME` is unset rather than silently using `/tmp`.

### 7.6 — MEDIUM: `buildMem0Mapping()` hardcodes vector store to `qdrant` while `getDefaultConfig()` uses `sqlite-vec`

**Files:** `connection-mapping.ts:146` vs `memory-config.ts:209`

`buildMem0Mapping()` (called during setup) always writes `provider: 'qdrant'` with `path: '/data/qdrant'`. But `getDefaultConfig()` (used as fallback) returns `provider: 'sqlite-vec'` with `db_path: '/data/memory.db'`. If a user's existing install used the default sqlite-vec config, running setup again switches them to qdrant without migrating data, silently losing their memory store.

**Recommendation:** Either always use one provider, or detect the existing provider and preserve it during re-setup.

### 7.7 — LOW: `quoteEnvValue()` doesn't escape `$` in double-quoted strings

**File:** `env.ts:24`
```typescript
const escaped = value.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
return `"${escaped}"`;
```

If a value contains `$`, it will be interpreted as variable expansion when the env file is sourced by bash. API keys from some providers contain `$` characters. The `dotenv` parser handles this correctly, but `ensureSecrets()` generates lines with `export` prefix, suggesting the file may also be sourced directly.

**Recommendation:** Also escape `$` → `\$` in double-quoted values, or always prefer single quotes.

---

## Summary of Recommendations by Priority

### Must-Fix (High — blocks reliable installs)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.2 | No retry on CLI binary download | Trivial — add `--retry` flags |
| 2.1 | No retry on `fetchAsset()` | Small — wrap fetch in retry loop |
| 2.2 | Inconsistent error handling for required vs optional assets | Small — wrap schema downloads in try/catch |
| 2.3 | Setup wizard port collision undetected | Small — port availability check |
| 2.4 | Silent pull failure on first install | Medium — check local image cache |
| 4.1 | Assistant health check is TCP-only | Trivial — switch to HTTP |
| 7.1 | Duplicated Ollama URL resolution in `performSetup()` | Small — extract shared helper |
| 7.2 | Non-null assertions on `.find()` in `performSetup()` | Trivial — add null checks |

### Should-Fix (Medium — degrades experience or security)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.3 | PowerShell has no retry | Trivial |
| 4.4 | Memory healthcheck missing `start_period` | Trivial |
| 6.1 | Docker socket detection incomplete | Small |
| 7.5 | `resolveHome()` falls back to `/tmp` | Trivial — throw instead |
| 7.6 | Vector store provider mismatch (qdrant vs sqlite-vec) | Medium |

### Nice-to-Fix (Low — polish or acceptable as-is)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.1 | CLI binary has no checksum verification (inherent to `curl \| bash`) | — Accept |
| 1.4 | Windows ARM64 unsupported | Medium |
| 1.5 | PATH not persisted | Small |
| 1.6 | GitHub API rate limiting | Trivial |
| 2.5 | Hardcoded 3s poll delay | — Accept |
| 2.6 | `MEMORY_USER_ID` defaults to `default_user` | — Accept |
| 2.7 | `xdg-open` assumed on Linux | Trivial |
| 3.2 | No wizard timeout (user has Ctrl-C) | — Accept |
| 4.2 | Varlock fetch duplicated across Dockerfiles | — Accept |
| 4.3 | `curl \| bash` in Dockerfiles (standard practice) | — Accept |
| 4.5 | Guardian healthcheck doesn't check response status | Trivial |
| 5.1 | Assistant has no readiness signal (`start_period` suffices) | — Accept |
| 5.2 | Admin background OpenCode not monitored | Small |
| 5.3 | Socat proxy unmonitored | Small |
| 7.3 | Unnecessary setup token write/delete cycle | — Accept |
| 7.4 | `isOllamaEnabled()` re-reads file on every call | — Accept |
| 7.7 | `$` not escaped in double-quoted env values | Trivial |
| 3.1 | No CSRF on setup wizard API (localhost-only, short-lived) | — Accept |

---

## Appendix A: Recommended Install Flow (Target State)

```
User runs: curl -fsSL .../setup.sh | bash
  │
  ├─ Download CLI binary with retry (5x)
  ├─ Warn about PATH if not persistent
  └─ exec openpalm install
       │
       ├─ Check Docker: installed, running, compose v2
       ├─ Create XDG directory tree
       ├─ Download assets with retry (3x exponential backoff)
       │   ├─ Required: docker-compose.yml, Caddyfile (fail-fast)
       │   └─ Optional: schemas, agents, automations (warn + continue)
       ├─ Seed config files (secrets.env, stack.env)
       │
       ├─ [First install] Start setup wizard
       │   ├─ Detect available port (8100 preferred)
       │   └─ On completion → stage artifacts
       │
       ├─ Pull images (required on first install, optional on update)
       ├─ docker compose up -d
       ├─ Wait for all health checks to pass (with timeout)
       └─ Print success + admin URL
```

---

## Appendix B: Function-by-Function Trace

This appendix traces every function in the install/setup path, in call order, with file locations and observations.

### B.1 — Shell Bootstrap (`scripts/setup.sh`)

```
setup.sh
  ├─ detect_os()          → uname -s mapping
  ├─ detect_arch()        → uname -m mapping (amd64/arm64)
  ├─ get_latest_version() → GitHub API /repos/.../releases/latest
  ├─ curl binary          → single attempt, no retry ⚠️
  ├─ chmod +x
  ├─ export PATH          → session-only ⚠️
  └─ exec openpalm install "$@"
```

### B.2 — CLI Install Command (`packages/cli/src/commands/install.ts`)

```
install command
  ├─ ensureDocker()           → checks `docker compose version`
  ├─ ensureXdgDirs()          → creates ~30 directories under CONFIG/DATA/STATE
  ├─ fetchAsset() × N         → downloads compose, caddyfile, schemas, etc. ⚠️ no retry
  ├─ ensureSecrets()          → seeds secrets.env if missing
  ├─ ensureStackEnv()         → seeds stack.env with UID/GID/paths
  ├─ [first install] startSetupWizard()
  │     ├─ Bun.serve() on port 8100 ⚠️ hardcoded
  │     ├─ waitForComplete() → blocks indefinitely ⚠️ no timeout
  │     └─ POST /api/setup/complete → performSetup()
  ├─ applyInstall()           → stages artifacts
  ├─ docker compose pull      → swallowed on error ⚠️
  ├─ docker compose up -d
  └─ sleep(3000)              → hardcoded wait ⚠️
```

### B.3 — `ensureXdgDirs()` — `packages/lib/src/control-plane/paths.ts:41-77`

Creates the full directory tree. Called early in install and again in `performSetup()`.

| Directory | Purpose |
|-----------|---------|
| `CONFIG_HOME/` | User-editable root |
| `CONFIG_HOME/channels/` | Channel definitions |
| `CONFIG_HOME/connections/` | Connection profiles JSON |
| `CONFIG_HOME/assistant/` | OpenCode user config |
| `CONFIG_HOME/automations/` | User automation YAML |
| `CONFIG_HOME/stash/` | Stashed config backups |
| `DATA_HOME/` | Opaque service data root |
| `DATA_HOME/admin/` | Admin OpenCode config |
| `DATA_HOME/memory/` | Memory vector store + config |
| `DATA_HOME/assistant/` | System OpenCode config |
| `DATA_HOME/guardian/` | Guardian service data |
| `DATA_HOME/caddy/{data,config}/` | Caddy TLS + config |
| `DATA_HOME/automations/` | System automation YAML |
| `DATA_HOME/opencode/` | OpenCode runtime data |
| `STATE_HOME/artifacts/` | Staged compose/caddyfile |
| `STATE_HOME/artifacts/channels/` | Staged channel overlays |
| `STATE_HOME/audit/` | Audit log entries |
| `STATE_HOME/automations/` | Staged automation YAML |
| `STATE_HOME/opencode/` | OpenCode state |

**Note:** `resolveHome()` (line 12) falls back to `/tmp` if `$HOME` is unset → all dirs under `/tmp/.config/openpalm` ⚠️

### B.4 — `ensureSecrets()` — `packages/lib/src/control-plane/secrets.ts:55-88`

Seeds `CONFIG_HOME/secrets.env` on first run. Idempotent — skips if file exists.

Generated file contains:
- `OPENPALM_ADMIN_TOKEN=` (empty, filled by setup wizard)
- `ADMIN_TOKEN=` (empty, filled by setup wizard)
- All LLM provider API key placeholders (empty)
- `MEMORY_USER_ID` from env or `"default_user"` ⚠️ poor default
- `MEMORY_AUTH_TOKEN` auto-generated (32 random bytes, hex)
- `OWNER_NAME` / `OWNER_EMAIL` from env

**Observation:** Uses `export` prefix on all lines. This means the file can be `source`d by bash, but `quoteEnvValue()` doesn't escape `$` in double-quoted strings ⚠️

### B.5 — `createState()` — `packages/lib/src/control-plane/lifecycle.ts:46-82`

State factory. Called by `performSetup()` if no state is passed, and by the admin server on startup.

```
createState(adminToken?)
  ├─ resolveStateHome()   → STATE_HOME path
  ├─ resolveConfigHome()  → CONFIG_HOME path
  ├─ loadSecretsEnvFile() → parse secrets.env, filter to ^[A-Z0-9_]+$ keys
  ├─ Resolve admin token: arg > secrets.OPENPALM_ADMIN_TOKEN > secrets.ADMIN_TOKEN > env > ""
  ├─ Initialize services: all CORE_SERVICES → "stopped"
  ├─ resolveDataHome()    → DATA_HOME path
  ├─ loadPersistedChannelSecrets() → parse CHANNEL_*_SECRET from stack.env
  ├─ randomHex(16)        → generate setup token
  └─ writeSetupTokenFile() → writes or deletes setup-token.txt ⚠️ always writes first
```

**Observation:** `writeSetupTokenFile()` is called unconditionally. If setup is complete, it writes the file then immediately deletes it — a pointless filesystem operation on every state creation.

### B.6 — `performSetup()` — `packages/lib/src/control-plane/setup.ts:330-459`

Core setup orchestration. Called by CLI setup wizard and admin UI.

```
performSetup(input, assetProvider, opts?)
  ├─ validateSetupInput(input)         → field-level validation
  ├─ createState(adminToken)           → if no state passed
  ├─ Map connections with Ollama override ⚠️ duplicated from buildSecretsFromSetup
  ├─ buildConnectionEnvVarMap()        → connectionId → env var name
  ├─ buildSecretsFromSetup(input)      → ⚠️ also does Ollama override internally
  ├─ ensureXdgDirs()                   → create directory tree
  ├─ ensureSecrets(state)              → seed secrets.env
  ├─ ensureConnectionProfilesStore()   → create connections/ dir
  ├─ updateSecretsEnv(state, updates)  → merge updates into secrets.env
  ├─ writeSetupTokenFile(state)        → update admin token in file
  ├─ Build memory config:
  │   ├─ Find LLM/embedding connections ⚠️ non-null assertions on .find()
  │   ├─ Resolve env var references
  │   ├─ Look up embedding dimensions (fallback: 1536)
  │   ├─ buildMem0Mapping()            → ⚠️ always uses qdrant, not sqlite-vec
  │   └─ writeMemoryConfig()           → DATA_HOME/memory/default_config.json
  ├─ writeConnectionsDocument()        → CONFIG_HOME/connections/profiles.json
  ├─ ensureOpenCodeConfig()            → CONFIG_HOME/assistant/opencode.json
  ├─ ensureOpenCodeSystemConfig()      → DATA_HOME/assistant/opencode.jsonc + AGENTS.md
  ├─ ensureAdminOpenCodeConfig()       → DATA_HOME/admin/opencode.jsonc + AGENTS.md
  ├─ ensureMemoryDir()                 → DATA_HOME/memory/ (migrates legacy openmemory/)
  └─ applyInstall(state, assetProvider)→ stages + persists artifacts
```

### B.7 — `applyInstall()` → `reconcileCore()` — `lifecycle.ts:113-141`

```
applyInstall(state, assets)
  └─ reconcileCore(state, assets, { activateServices: true, seedMemoryConfig: true })
       ├─ Set all CORE_SERVICES → "running"
       ├─ ensureMemoryDir()
       ├─ ensureCoreAutomations(assets) → write cleanup-logs.yml, cleanup-data.yml, validate-config.yml
       ├─ ensureMemoryConfig(dataDir)   → write default_config.json if missing
       ├─ stageArtifacts(state, assets) → returns { compose, caddyfile } strings
       ├─ persistArtifacts(state, assets) → writes everything to STATE_HOME/artifacts/
       └─ Return list of active services
```

### B.8 — `stageArtifacts()` — `staging.ts:312-323`

```
stageArtifacts(state, assets)
  ├─ stageCompose()   → readCoreCompose(assets) → ensure + read DATA_HOME/docker-compose.yml
  └─ stageCaddyfile() → readCoreCaddyfile(assets) → ensure + read DATA_HOME/caddy/Caddyfile
```

Both `readCoreCompose()` and `readCoreCaddyfile()` call their respective `ensure*()` functions, which seed the file from the asset provider if it doesn't exist, or back up + overwrite if the content has changed (compose only).

### B.9 — `persistArtifacts()` — `staging.ts:342-376`

```
persistArtifacts(state, assets)
  ├─ mkdirSync artifacts/ and channels/
  ├─ Write docker-compose.yml to artifacts/
  ├─ Write Caddyfile to artifacts/
  ├─ [if Ollama enabled] Write ollama.yml to artifacts/
  ├─ Generate channel HMAC secrets for new channels (randomHex(16))
  ├─ stageStackEnv()          → merge admin-managed vars into stack.env, copy to artifacts/
  ├─ stageSecretsEnv()        → copy secrets.env to artifacts/
  ├─ stageChannelYmlFiles()   → copy channel YMLs to artifacts/channels/
  ├─ stageChannelCaddyfiles() → scope caddyfiles (public vs LAN), write to artifacts/channels/{public,lan}/
  ├─ stageAutomationFiles()   → validate + copy automation YAMLs to STATE_HOME/automations/
  ├─ stageEnvSchemas()        → copy env schemas to DATA_HOME/assistant/env-schema/
  └─ Write manifest.json with SHA-256 hashes
```

### B.10 — `buildComposeFileList()` + `buildManagedServices()` — `lifecycle.ts:222-254`

Called by the CLI to build `docker compose` arguments.

```
buildComposeFileList(state) → string[]
  ├─ artifacts/docker-compose.yml (always)
  ├─ artifacts/ollama.yml (if Ollama enabled) ⚠️ re-reads stack.env
  └─ artifacts/channels/*.yml (discovered)

buildManagedServices(state) → string[]
  ├─ CORE_SERVICES (caddy, memory, assistant, guardian, scheduler, docker-socket-proxy)
  ├─ "ollama" (if enabled) ⚠️ re-reads stack.env again
  └─ "channel-{name}" for each channel YML
```

### B.11 — `buildEnvFiles()` — `staging.ts:152-154`

```
buildEnvFiles(state) → string[]
  └─ [stack.env, secrets.env].filter(existsSync)
```

Returns paths to staged env files for `--env-file` docker compose args. Load order matters: stack.env first, secrets.env second (secrets override stack).

### B.12 — `validateSetupInput()` — `setup.ts:87-225`

Validates the setup wizard payload. Key checks:
- `adminToken`: required, ≥8 chars
- `connections[]`: non-empty, valid IDs (alphanumeric + `_-`), no duplicates, provider must be in `WIZARD_PROVIDERS` set
- `assignments.llm` and `assignments.embeddings`: required with connectionId + model
- Cross-validates: assignment connectionIds must reference an actual connection

**Observation:** Good validation, but the `WIZARD_PROVIDERS` set is hardcoded. Adding a new provider requires a code change, not config.

### B.13 — `buildSecretsFromSetup()` — `setup.ts:235-282`

Builds the env var map for secrets.env updates. Key behaviors:
- Duplicates `OPENPALM_ADMIN_TOKEN` as `ADMIN_TOKEN` for backward compat
- Sanitizes owner name/email: strips `\r\n\0`, truncates to 200 chars (prevents env-file injection)
- Resolves Ollama in-stack URL override ⚠️ duplicated in `performSetup()`
- Maps connection API keys to env vars via `buildConnectionEnvVarMap()`
- Sets `SYSTEM_LLM_PROVIDER`, `SYSTEM_LLM_MODEL`, `SYSTEM_LLM_BASE_URL`, `OPENAI_BASE_URL`
- Normalizes `OPENAI_BASE_URL` to end with `/v1`

### B.14 — `buildConnectionEnvVarMap()` — `setup.ts:290-311`

Maps `connectionId` → env var name using `PROVIDER_KEY_MAP`. For duplicate providers, appends `_{connectionId}` suffix. Validates against `SAFE_ENV_KEY_RE` (`^[A-Z][A-Z0-9_]*$`).

**Observation:** The duplicate handling (`OPENAI_API_KEY_myconn2`) produces valid but non-standard env var names that may confuse users.

### B.15 — `mergeEnvContent()` — `env.ts:28-70`

Core env file merger. Parses existing content line-by-line, matches keys (with optional `export` prefix), and replaces values in-place. New keys are appended at the end with an optional section header.

Key behaviors:
- `uncomment: true` → unmatches `# KEY=value` lines and activates them
- Preserves `export` prefix if the original line had one
- New keys added without `export` prefix (inconsistency with `ensureSecrets()` which uses `export`)
- `quoteEnvValue()` handles empty values, single quotes, double quotes with `\n`/`\r` escaping
- ⚠️ Does not escape `$` in double-quoted values

### B.16 — Key Asset Files Written During Install

| File | Written By | Purpose |
|------|-----------|---------|
| `CONFIG_HOME/secrets.env` | `ensureSecrets()` → `updateSecretsEnv()` | API keys, admin token |
| `DATA_HOME/stack.env` | `stageStackEnv()` | XDG paths, UID/GID, image tag, channel secrets |
| `DATA_HOME/docker-compose.yml` | `ensureCoreCompose()` | Source-of-truth compose |
| `DATA_HOME/caddy/Caddyfile` | `ensureCoreCaddyfile()` | Source-of-truth Caddyfile |
| `DATA_HOME/memory/default_config.json` | `writeMemoryConfig()` | Mem0 LLM/embedder/vector config |
| `CONFIG_HOME/connections/profiles.json` | `writeConnectionsDocument()` | Connection profiles + assignments |
| `STATE_HOME/artifacts/docker-compose.yml` | `persistArtifacts()` | Staged copy for `docker compose` |
| `STATE_HOME/artifacts/Caddyfile` | `persistArtifacts()` | Staged copy for Caddy |
| `STATE_HOME/artifacts/stack.env` | `stageStackEnv()` | Staged copy with admin-managed vars |
| `STATE_HOME/artifacts/secrets.env` | `stageSecretsEnv()` | Staged copy for `--env-file` |
| `STATE_HOME/artifacts/manifest.json` | `persistArtifacts()` | SHA-256 hashes + metadata |
| `STATE_HOME/setup-token.txt` | `writeSetupTokenFile()` | One-time setup token (deleted after setup) |