# OpenPalm Install & Setup Process — Critical Review and Recommendations

**Date:** 2026-03-17
**Scope:** End-to-end review from `curl | bash` through setup wizard completion and container startup.
**Related:** `setup-wizard-audit-2026-03-17.md` (wizard-specific bugs), `admin-audit-2026-03-17.md` (admin-specific bugs)

---

## 1. Shell Bootstrap Scripts (`scripts/setup.sh`, `scripts/setup.ps1`)

### 1.1 — HIGH: No retry logic on CLI binary download

**File:** `scripts/setup.sh:80`

A single `curl -fsSL` with no `--retry`. GitHub release CDN returns transient 502/503 errors regularly. The Dockerfiles already use `--retry 5 --retry-delay 10 --retry-all-errors` for varlock; the bootstrap script should do the same.

**Recommendation:**
```bash
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
  "https://github.com/…/${BINARY}" -o "${DEST}"
```

### 1.2 — MEDIUM: PowerShell script has no retry logic

**File:** `scripts/setup.ps1:67`

`Invoke-WebRequest` has no retry. Use `-MaximumRetryCount 5 -RetryIntervalSec 5` (PowerShell 7.1+) or wrap in a retry loop for older versions.

### 1.3 — LOW: `$PATH` modification is session-only (bash)

**File:** `scripts/setup.sh:97`

`export PATH=` only affects the current shell. After the install `exec`s the CLI, the user's next terminal session won't find `openpalm`. The warning message is good, but consider also appending to `~/.bashrc` / `~/.zshrc` with user confirmation (like `rustup` does).

### 1.4 — LOW: GitHub API rate limiting on latest version lookup

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

**Recommendation:** Catch the bind error and print: `"Port 8100 is in use. Stop the conflicting process or set OPENPALM_SETUP_PORT=<port>"`.

### 2.4 — HIGH: `docker compose pull` failure is silently swallowed

**File:** `install.ts:228-230`
```typescript
await runDockerCompose([...composeArgs, 'pull', ...allServices]).catch(() => {
  // Pull failure is non-fatal — images may already be cached
});
```

This is dangerous on first install. If pull fails and there are no cached images, the subsequent `docker compose up` will fail with an unhelpful "image not found" error. The catch should distinguish between "already cached" and "network failure on first install."

### 2.5 — LOW: `openBrowser()` on Linux assumes `xdg-open` is installed

**File:** `docker.ts:103`

Headless Linux servers or minimal WSL installs don't have `xdg-open`. The error is silently caught, but the user gets no feedback about where the wizard URL is.

**Recommendation:** Always print the URL prominently to the terminal regardless of whether browser launch succeeds.

---

## 3. Docker Compose & Container Startup

### 3.1 — HIGH: Health check for assistant uses TCP probe, not application-level check

**File:** `docker-compose.yml:107`
```yaml
test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/4096' || exit 1"]
```

A TCP port being open doesn't mean the application is ready to serve requests. Services that depend on `assistant` via `condition: service_healthy` may start before the assistant's HTTP server is fully initialized.

**Recommendation:** Use an HTTP health endpoint:
```yaml
test: ["CMD-SHELL", "curl -sf http://localhost:4096/health || exit 1"]
```

### 3.2 — MEDIUM: No `start_period` on memory health check

**File:** `docker-compose.yml:58-60`

The memory service has no `start_period`, meaning health checks begin immediately on container start. If the service takes a few seconds to initialize, it may be marked unhealthy prematurely. Other services do have `start_period` defined.

**Recommendation:** Add `start_period: 10s` to the memory service healthcheck.

### 3.3 — LOW: Guardian healthcheck doesn't verify response status

**File:** `docker-compose.yml:144`
```yaml
test: ["CMD-SHELL", "bun -e \"await fetch('http://localhost:8080/health')\" || exit 1"]
```

This only checks that `fetch()` doesn't throw. A 500 response would still pass.

**Recommendation:**
```yaml
test: ["CMD-SHELL", "bun -e \"const r=await fetch('http://localhost:8080/health');if(!r.ok)process.exit(1)\" || exit 1"]
```

---

## 4. Entrypoint Scripts

### 4.1 — LOW: Admin background OpenCode not monitored

**File:** `core/admin/entrypoint.sh:40`
```bash
opencode web ... &
OPENCODE_PID=$!
```

If the background OpenCode process crashes, the admin container continues running without its AI assistant. Consider adding a simple `wait $PID || exit 1` rather than a full process supervisor.

### 4.2 — LOW: `socat` proxy has no health check or error handling

**File:** `core/assistant/entrypoint.sh:157`
```bash
socat TCP-LISTEN:1234,reuseaddr,fork TCP:"${target_host}":"${target_port}" &
```

The socat process runs as a background job with no monitoring. If it crashes, LM Studio requests silently fail with connection refused.

---

## 5. Configuration & Environment

### 5.1 — MEDIUM: Docker socket detection is simplistic

**File:** `packages/cli/src/lib/paths.ts:21`
```typescript
return IS_WINDOWS ? '//./pipe/docker_engine' : '/var/run/docker.sock';
```

This misses OrbStack (`~/.orbstack/run/docker.sock`), Colima (`~/.colima/default/docker.sock`), Rancher Desktop (`~/.rd/docker.sock`), and Podman. The `ensureStackEnv` function references socket detection, but `defaultDockerSock()` doesn't check for these alternatives.

**Recommendation:** Check known paths in priority order, or use `docker context inspect --format '{{.Endpoints.docker.Host}}'` to discover the active socket.

---

## 6. Library Functions (`packages/lib/src/control-plane/`)

### 6.1 — HIGH: `performSetup()` duplicates Ollama URL resolution with `buildSecretsFromSetup()`

**Files:** `setup.ts:249-254` and `setup.ts:350-355`

`buildSecretsFromSetup()` creates its own `effectiveConnections` array with the Ollama in-stack URL override. Then `performSetup()` creates a *second* `effectiveConnections` array with the same logic. The secrets are built from one copy, and the memory config / connection profiles are built from the other. A change to one will silently diverge from the other.

**Recommendation:** Extract the Ollama override into a shared helper called once, or pass `effectiveConnections` to `buildSecretsFromSetup()`.

### 6.2 — HIGH: `performSetup()` uses non-null assertions on `.find()` results

**File:** `setup.ts:387,392,395`
```typescript
const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId)!;
const llmEnvVar = connEnvVarMap.get(llmConnection.id)!;
const embEnvVar = connEnvVarMap.get(embConnection.id)!;
```

If `.find()` returns `undefined`, the `!` assertion causes a cryptic `TypeError: Cannot read properties of undefined` deep in the setup flow instead of a clean error.

**Recommendation:** Replace with explicit checks:
```typescript
const llmConnection = effectiveConnections.find((c) => c.id === llmConnectionId);
if (!llmConnection) return { ok: false, error: `LLM connection "${llmConnectionId}" not found` };
```

### 6.3 — MEDIUM: `buildMem0Mapping()` hardcodes vector store to `qdrant` while `getDefaultConfig()` uses `sqlite-vec`

**Files:** `connection-mapping.ts:146` vs `memory-config.ts:209`

`buildMem0Mapping()` (called during setup) always writes `provider: 'qdrant'` with `path: '/data/qdrant'`. But `getDefaultConfig()` (used as fallback) returns `provider: 'sqlite-vec'` with `db_path: '/data/memory.db'`. If a user's existing install used the default sqlite-vec config, running setup again switches them to qdrant without migrating data, silently losing their memory store.

**Recommendation:** Either always use one provider, or detect the existing provider and preserve it during re-setup.

### 6.4 — LOW: `quoteEnvValue()` doesn't escape `$` in double-quoted strings

**File:** `env.ts:24`
```typescript
const escaped = value.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
return `"${escaped}"`;
```

If a value contains `$`, it will be interpreted as variable expansion when the env file is sourced by bash. API keys from some providers contain `$` characters.

**Recommendation:** Also escape `$` → `\$` in double-quoted values, or always prefer single quotes.

---

## Summary by Priority

### Must-Fix (High)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.1 | No retry on CLI binary download | Trivial — add `--retry` flags |
| 2.1 | No retry on `fetchAsset()` | Small — wrap fetch in retry loop |
| 2.2 | Inconsistent error handling for required vs optional assets | Small — wrap schema downloads in try/catch |
| 2.3 | Setup wizard port collision undetected | Small — port availability check |
| 2.4 | Silent pull failure on first install | Medium — check local image cache |
| 3.1 | Assistant health check is TCP-only | Trivial — switch to HTTP |
| 6.1 | Duplicated Ollama URL resolution in `performSetup()` | Small — extract shared helper |
| 6.2 | Non-null assertions on `.find()` in `performSetup()` | Trivial — add null checks |

### Should-Fix (Medium)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.2 | PowerShell has no retry | Trivial |
| 3.2 | Memory healthcheck missing `start_period` | Trivial |
| 5.1 | Docker socket detection incomplete | Small |
| 6.3 | Vector store provider mismatch (qdrant vs sqlite-vec) | Medium |

### Nice-to-Fix (Low)

| # | Issue | Fix Effort |
|---|-------|-----------|
| 1.3 | PATH not persisted | Small |
| 1.4 | GitHub API rate limiting | Trivial |
| 2.5 | `xdg-open` assumed on Linux | Trivial |
| 3.3 | Guardian healthcheck doesn't check response status | Trivial |
| 4.1 | Admin background OpenCode not monitored | Small |
| 4.2 | Socat proxy unmonitored | Small |
| 6.4 | `$` not escaped in double-quoted env values | Trivial |
