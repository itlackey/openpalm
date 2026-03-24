# Architecture & Design Review -- OpenPalm

**Date:** 2026-03-24
**Branch:** release/0.10.0
**Reviewer:** Architecture & Design Review Agent

---

## Executive Summary

OpenPalm is a self-hosted AI assistant platform with a well-designed security
perimeter and sensible separation of concerns. The architecture is largely
consistent with its stated principles. However, several areas show
over-engineering for the project's maturity level, a few security boundaries
are weaker than they appear, and the shared library approach introduces
coupling that will slow evolution. Below I dissect each architectural claim
against the code.

Overall severity breakdown:
- **Critical:** 1
- **High:** 4
- **Medium:** 7
- **Low:** 5
- **Informational:** 3

---

## 1. Core Principles vs Reality

### 1.1 "File assembly, not rendering" -- MOSTLY FOLLOWED

**Claim:** Write whole files; no string interpolation or template generation.

**Reality:** The principle is followed for compose files -- `readCoreCompose()`
returns a pre-built YAML file verbatim, and addon overlays are static compose
YAML files under `.openpalm/stack/addons/`. No Jinja, no Handlebars, no
mustache.

However, the principle is violated in spirit by `config-persistence.ts`:

```typescript
// config-persistence.ts:117-152 -- generateFallbackSystemEnv()
function generateFallbackSystemEnv(state: ControlPlaneState): string {
  return [
    "# OpenPalm -- System Configuration (managed by CLI/admin)",
    "",
    `OP_HOME=${state.homeDir}`,
    `OP_UID=${uid}`,
    `OP_GID=${gid}`,
    `OP_DOCKER_SOCK=${process.env.OP_DOCKER_SOCK ?? "/var/run/docker.sock"}`,
    ...
  ].join("\n");
}
```

This *is* template rendering -- it interpolates runtime values into a string
that becomes a file. The `mergeEnvContent()` function also does key-value
patching of env files in place.

**Verdict:** The compose files genuinely avoid rendering. The env file
generation is necessarily dynamic (you cannot pre-bake UUIDs and paths), so
the rule is pragmatically bent in the right place. The stated principle is
slightly misleading -- it should say "no compose template rendering" rather
than implying all files are static.

**Severity:** Informational

---

### 1.2 "Guardian-only ingress" -- VERIFIED WITH CAVEATS

**Claim:** All channel traffic must enter through the guardian (HMAC, replay
protection, rate limiting).

**Verification:**

1. All channel addon compose files (`chat`, `api`, `discord`, `slack`,
   `voice`) join `channel_lan` and depend on `guardian: service_healthy`.
   None are on `assistant_net` directly.
2. The guardian is the only service on all three networks
   (`channel_lan`, `channel_public`, `assistant_net`), acting as the bridge.
3. Channel adapters POST to `guardian:8080` -- the only path to the assistant.

**Caveats found:**

**A) Assistant is directly exposed to host:**
```yaml
# core.compose.yml:93-94
ports:
  - "${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}:4096"
  - "${OP_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_SSH_PORT:-2222}:22"
```
The assistant (OpenCode web UI) is directly reachable on port 3800 from the
host, bypassing the guardian entirely. The SSH port is also exposed. Both
default to `127.0.0.1`, which is correct for LAN-first, but there is nothing
preventing a user from changing the bind address to `0.0.0.0` and creating an
unauthenticated entry point to the assistant. The compose file even has
`OPENCODE_AUTH: "false"`.

This is not a *channel* ingress, so the principle technically holds, but it is
the most significant hole in the security model.

**B) Memory is directly exposed to host:**
```yaml
# core.compose.yml:43
ports:
  - "${OP_MEMORY_BIND_ADDRESS:-127.0.0.1}:${OP_MEMORY_PORT:-3898}:8765"
```
Memory service is directly accessible without any authentication if the user
changes the bind address.

**C) Admin is directly exposed to host:**
```yaml
# addons/admin/compose.yml:33-34
ports:
  - "${OP_ADMIN_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_PORT:-3880}:8100"
```

**Severity:** Medium (assistant direct exposure), Low (memory/admin are
expected to be host-accessible)

**Recommendation:** Document explicitly that the guardian-only ingress applies
to *channel traffic only*. The assistant, memory, and admin ports are
management interfaces that rely on the LAN-first bind address for security.
Consider adding auth to OpenCode (`OPENCODE_AUTH: "true"`) or at least making
it opt-out rather than opt-in.

---

### 1.3 "Assistant isolation" -- VERIFIED

**Claim:** Assistant has no Docker socket access.

**Verification:**
- `core.compose.yml` assistant service: no Docker socket mount, no
  `docker-socket-proxy` dependency, only on `assistant_net`.
- `core/assistant/Dockerfile`: no Docker CLI installed, no Docker socket
  reference.
- `core/assistant/entrypoint.sh`: no Docker operations.
- The assistant can reach admin API via `OP_ADMIN_API_URL` for stack
  operations when admin is present, which is the intended delegation pattern.

**Confirmed:** Assistant isolation is genuine and well-enforced.

**Severity:** N/A (pass)

---

### 1.4 "LAN-first" -- VERIFIED WITH ONE CONCERN

**Claim:** Nothing is publicly exposed without explicit user opt-in.

**Verification:** All port bindings default to `127.0.0.1`:
- `OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1`
- `OP_ADMIN_BIND_ADDRESS:-127.0.0.1`
- `OP_MEMORY_BIND_ADDRESS:-127.0.0.1`
- `OP_GUARDIAN_BIND_ADDRESS:-127.0.0.1`
- `OP_CHAT_BIND_ADDRESS:-127.0.0.1`
- `OP_OLLAMA_BIND_ADDRESS:-127.0.0.1`
- etc.

The Docker networks `channel_lan` and `channel_public` exist but do not map
to any host ports by default (only internal Docker networking).

**Concern:** `compose.dev.yaml` exposes the channel-voice port directly:
```yaml
# compose.dev.yaml:80
ports:
  - "8186:8186"
```
This binds to `0.0.0.0:8186` (all interfaces) in dev mode. While this is a
dev override, it is a template that users might copy.

**Severity:** Low (dev-only)

---

### 1.5 Config/Vault Filesystem Contract -- MOSTLY CLEAN

**Claim:** `config/` is user-owned non-secret; `vault/` is the secrets
boundary.

**Verification:**

The boundary is clean in core services:
- `config/` mounts are `ro` for scheduler, full access for assistant
  (assistant config lives in `config/assistant/`).
- `vault/user/` is mounted to assistant at `/etc/vault`.
- `vault/stack/` is only mounted to admin (via the full `OP_HOME` mount) and
  guardian (specific `guardian.env` file).
- Vault files get `0o600` permissions, vault dirs get `0o700`.

**Leak found -- Admin mounts ALL of OP_HOME:**
```yaml
# addons/admin/compose.yml:62
volumes:
  - ${OP_HOME}:/openpalm
```
The admin container has read-write access to the *entire* OpenPalm home
directory. This means the admin container (which has the Docker socket proxy)
can read and modify everything: config, vault, data, logs, stack files. While
admin is a trusted service, this violates the stated boundary model. The vault
boundary is meaningless if admin has full access to everything.

**Severity:** Medium

**Recommendation:** The admin compose overlay should mount only the specific
directories it needs with appropriate read/write modes, not a blanket
`${OP_HOME}:/openpalm` mount.

---

## 2. Package Architecture

### 2.1 The Shared Lib (`packages/lib/`) -- Over-Coupled God Package

**File:** `/home/founder3/code/github/itlackey/openpalm/packages/lib/src/index.ts`

The barrel export file is 327 lines and exports from 21 internal modules.
This includes:

- Docker compose operations (docker.ts)
- Filesystem operations (home.ts, config-persistence.ts, core-assets.ts)
- Secrets management (secrets.ts, secret-backend.ts)
- Stack spec parsing (stack-spec.ts)
- Registry sync (registry.ts)
- Scheduler execution (scheduler.ts)
- Memory configuration (memory-config.ts)
- OpenCode client (opencode-client.ts)
- Lifecycle state machine (lifecycle.ts)
- Lock management (lock.ts)
- Rollback (rollback.ts)

**Problem:** This is a monolithic shared library masquerading as a package.
The `packages/lib/` barrel exports everything, but many consumers only need a
fraction:

- The **scheduler** runtime (`packages/scheduler/`) imports `createLogger`
  and `loadAutomations` -- it does not need Docker operations, secrets,
  registry, memory config, etc.
- The **admin** imports almost everything.
- The **CLI** imports almost everything.

The "never duplicate control-plane logic" rule forces all logic into this
single package, which means:
1. Any change to lib potentially affects all consumers.
2. The Vite build for admin needs special shims (`bunShim`, `yamlTextImport`)
   because lib uses Bun APIs, but admin runs on Node.
3. Testing requires mocking deep dependencies because everything is
   interconnected.

**Severity:** Medium

**Recommendation:** Split `packages/lib/` into focused packages:
- `@openpalm/config` -- stack spec, env parsing, home layout
- `@openpalm/docker` -- compose operations
- `@openpalm/secrets` -- vault management
- `@openpalm/scheduler-lib` -- automation parsing and execution

Or, at minimum, use proper subpath exports (`@openpalm/lib/docker`,
`@openpalm/lib/config`) so consumers can tree-shake and Vite does not need to
shim Bun APIs for modules the admin never uses.

### 2.2 packages/ vs core/ Split -- Justified

**Layout:**
- `packages/*` -- library/app source (npm workspaces)
- `core/*` -- Docker image build contexts

This split makes sense. `core/guardian/` contains the Bun runtime server that
gets built into a Docker image. `packages/channels-sdk/` is a library
consumed by both guardian and channel adapters. The `core/` directories
contain Dockerfiles, entrypoint scripts, and runtime-only assets.

**Severity:** N/A (good design)

### 2.3 Admin Docker Wrapper -- Justified Preflight Pattern

**File:** `/home/founder3/code/github/itlackey/openpalm/packages/admin/src/lib/server/docker.ts`

The admin re-exports every Docker function from lib with a `runPreflight()`
wrapper on mutation operations. This is thin and justified -- it ensures
compose config is valid before any destructive operation.

One concern: `selfRecreateAdmin()` skips preflight with a comment saying
"compose files were already validated by the lifecycle preflight." This is
true in the upgrade path but could be false if called from other contexts.

**Severity:** Low

---

## 3. Docker Compose Multi-File Strategy

### 3.1 Core + Addon Overlay -- Well Designed

The core compose defines 4 services (memory, assistant, guardian, scheduler).
Addons are separate compose files in `stack/addons/<name>/compose.yml`.
The lifecycle code (`buildComposeFileList`) reads the stack spec to determine
which addons are enabled and builds the `-f` flag list dynamically.

This is clean and extensible. Adding a new channel truly is "drop a compose
file" -- the addon compose files are self-contained with their own service
definitions, network memberships, and health checks.

### 3.2 Variable Substitution Complexity

Every compose file relies heavily on `${VAR:-default}` substitution from
three env files loaded via `--env-file`:
- `vault/stack/stack.env`
- `vault/user/user.env`
- `vault/stack/guardian.env`

This creates a **three-layer env precedence** problem documented in the
CLAUDE.md memory:
> Docker Compose env precedence: Host shell env > `--env-file` > compose
> `environment:` defaults.

The code mitigates this with `collectEnvOverrides()` in `docker.ts` which
merges all env files into `process.env`, but this is fragile. The
`compose.dev.yaml` has to explicitly blank cloud API keys to prevent host
environment leakage.

**Severity:** Medium

**Recommendation:** Consider a single merged env file generated at lifecycle
apply time rather than relying on Docker Compose's multi-env-file precedence.

### 3.3 Dev Compose Divergence

`compose.dev.yaml` is 106 lines and overrides builds, ports, environment for
all services plus adds a voice channel override. This is standard Docker
Compose practice, but the `channel-voice` service definition in
`compose.dev.yaml` (lines 77-105) duplicates all the env_file and volume
mount logic that should come from the addon overlay.

**Severity:** Low

---

## 4. Security Model

### 4.1 HMAC Channel Signing -- Genuine Security

**Files:**
- `/home/founder3/code/github/itlackey/openpalm/packages/channels-sdk/src/crypto.ts`
- `/home/founder3/code/github/itlackey/openpalm/core/guardian/src/server.ts`
- `/home/founder3/code/github/itlackey/openpalm/core/guardian/src/signature.ts`
- `/home/founder3/code/github/itlackey/openpalm/core/guardian/src/replay.ts`

The HMAC implementation is correct:

1. **Constant-time comparison** in `verifySignature()` using XOR comparison.
2. **Timing-safe unknown channel handling**: unknown channels trigger HMAC
   verification against a dummy secret before rejection, preventing timing
   side-channel enumeration.
3. **Replay protection**: Nonce + timestamp with 5-minute clock skew window.
4. **Rate limiting**: Per-user (120/min) and per-channel (200/min).
5. **Payload size limit**: 100KB.
6. **Per-channel secrets**: Each channel gets its own HMAC secret generated
   via `randomBytes(16).toString("hex")` (CSPRNG).

This is well-implemented. The one weakness is the nonce cache is in-memory
and lost on restart, meaning replays of pre-restart messages are possible
within the 5-minute window after a guardian restart.

**Severity:** Low (acceptable for LAN-first threat model)

### 4.2 Admin Token Auth -- CRITICAL WEAKNESS

**File:** `/home/founder3/code/github/itlackey/openpalm/packages/admin/src/lib/server/helpers.ts`

The admin token is compared using `safeTokenCompare()`:
```typescript
export function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
```
This is correct (timing-safe via SHA-256 normalization + `timingSafeEqual`).

**However, the admin token is a static bearer token stored in plaintext in
`vault/stack/stack.env`:**
```
OP_ADMIN_TOKEN=<hex string>
```

This token:
- Is generated once during setup and never rotated.
- Is passed in an `x-admin-token` header (not `Authorization: Bearer`).
- Is stored in the browser's `localStorage` (see `auth.ts`).
- Is shared between the admin UI and the assistant (via `OP_ASSISTANT_TOKEN`).
- Controls access to destructive operations: uninstall, upgrade, container
  management, secrets read/write.

**The assistant token is a *second* static token that grants access to a
subset of admin APIs (those using `requireAuth` instead of `requireAdmin`).**
This means a compromised assistant can read container status, logs, events,
artifacts, automations, config validation, memory config, memory models,
network checks, and installed components.

**Severity:** Critical

**Rationale:** For a LAN-first self-hosted platform, static token auth is
common (Home Assistant, Portainer), but the combination of:
- No token rotation mechanism
- Token in localStorage (XSS exfiltrable)
- Token controls Docker operations
- No session management or expiry
- No HTTPS enforcement (LAN-first means likely HTTP)

...means any XSS in the admin UI or any network sniffer on the LAN can
capture the admin token and gain full control of the stack, including reading
all API keys from `vault/stack/stack.env`.

**Recommendation:**
1. Add session-based auth with expiry.
2. Implement token rotation.
3. Consider HTTPS-only mode or at least warn when running over HTTP.
4. Move the admin token out of localStorage (use httpOnly cookies instead).

### 4.3 Docker Socket Proxy -- Effective Filtering

**File:** `/home/founder3/code/github/itlackey/openpalm/.openpalm/stack/addons/admin/compose.yml`

```yaml
docker-socket-proxy:
  image: tecnativa/docker-socket-proxy:v0.4.2@sha256:...
  environment:
    CONTAINERS: 1
    IMAGES: 1
    NETWORKS: 1
    VOLUMES: 1
    EXEC: 0    # <-- KEY: no exec into containers
    POST: 1
    INFO: 1
  volumes:
    - ${OP_DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock:ro
```

`EXEC: 0` is the critical setting -- it prevents the admin from executing
commands inside containers (which would bypass assistant isolation). The
socket is mounted read-only. The proxy is on an isolated `admin_docker_net`
network.

This is well-configured. However:

**CONTAINERS: 1 + POST: 1** means the admin can create, start, stop, and
remove containers. Combined with `IMAGES: 1`, it could potentially pull and
run arbitrary images. The admin API does not restrict which images can be
pulled -- it delegates to `composePull()` which pulls whatever the compose
files specify.

**Severity:** Low (admin is already a privileged service; the proxy limits
the blast radius of the Docker socket exposure)

### 4.4 Vault/Config Separation -- Provides Real Value

The vault directory uses `0o700`/`0o600` permissions. Secrets are generated
via `randomBytes()` (CSPRNG). The guardian env file with HMAC secrets is
mounted read-only (`:ro`) into the guardian container.

**Value assessment:**
- The separation means a compromised memory or scheduler service cannot read
  API keys from `vault/stack/stack.env`.
- The assistant gets `vault/user/` (which is an empty placeholder) but not
  `vault/stack/` (which has API keys, admin token, etc.).
- The guardian gets only its specific `guardian.env` file.

This is genuine defense-in-depth.

**One weakness:** The assistant compose section passes *all* provider API keys
as environment variables:
```yaml
# core.compose.yml:77-90
OPENAI_API_KEY: ${OPENAI_API_KEY:-}
ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
GROQ_API_KEY: ${GROQ_API_KEY:-}
# ...8 more API keys
```
The entrypoint.sh mitigates this with `maybe_unset_unused_provider_keys()`
which unsets keys that do not match the active provider. This is a good
defense, but the keys are still visible in the container's env before the
entrypoint runs (e.g., `docker inspect`).

**Severity:** Medium (keys in Docker inspect output are accessible to anyone
with Docker access on the host)

---

## 5. Over-Engineering Assessment

### 5.1 Rollback System (`rollback.ts`)

A snapshot/restore system exists for rolling back state on failed lifecycle
operations. Given the project's maturity, this is forward-looking complexity.
The rollback logic runs on every `reconcileCore()` call:

```typescript
// lifecycle.ts:157
snapshotCurrentState(state);
```

For a project that likely has single-digit users, a simpler approach (back up
the env file before upgrade, like the upgrade route already does separately)
would suffice.

**Severity:** Informational (not harmful, just premature)

### 5.2 Orchestrator Lock (`lock.ts`)

File-based locking to prevent concurrent lifecycle operations. This is
justified -- concurrent `applyInstall` and `applyUpdate` calls could corrupt
state. The implementation is simple (pidfile-based) and appropriate.

**Severity:** N/A (justified)

### 5.3 Secret Backend Abstraction (`secret-backend.ts`)

Supports both a plaintext backend and a `pass` (password store) backend.
The `pass` integration adds significant complexity for a feature that very few
self-hosted users would use. However, it is cleanly abstracted and does not
leak into other modules.

**Severity:** Low (adds complexity but is well-isolated)

### 5.4 Registry System (`registry.ts`)

A git-based registry for discovering and installing automations and channel
addons. This includes cloning a remote git repo, discovering components,
syncing, and merging with local state. For a self-hosted platform, this is
heavyweight -- most users will use the built-in channels.

**Severity:** Informational (reasonable investment for a platform that wants
an ecosystem, but adds maintenance burden)

### 5.5 Audit System

Every API route appends audit entries to an in-memory array (capped at 1000).
The guardian writes audit entries to a log file. This is proportionate and
useful for debugging.

**Severity:** N/A (well-calibrated)

### 5.6 Varlock Secret Redaction

The assistant uses Varlock for runtime secret redaction in stdout/stderr and
a `varlock-shell` wrapper so shell tool output is redacted before entering
the LLM context window. This is a genuine security measure -- it prevents
the AI assistant from accidentally leaking API keys in its responses.

**Severity:** N/A (justified and well-implemented)

### 5.7 SSRF Protection in Admin

`helpers.ts` includes `validateExternalUrl()` that blocks localhost, link-
local IPs, and Docker service names while allowing LAN ranges. This is
well-calibrated for the LAN-first design.

**Severity:** N/A (good security practice)

---

## 6. Specific Code Issues

### 6.1 Guardian Stats Endpoint -- Weak Auth

**File:** `/home/founder3/code/github/itlackey/openpalm/core/guardian/src/server.ts:82-86`

```typescript
if (url.pathname === "/stats" && req.method === "GET") {
  if (ADMIN_TOKEN) {
    const token = req.headers.get("x-admin-token");
    if (token !== ADMIN_TOKEN) {
      return json(401, { error: "unauthorized" });
    }
  }
```

The stats endpoint uses a **plain string comparison** (`!==`) for token
validation, not constant-time comparison. This is a timing attack vector.

Also, if `ADMIN_TOKEN` is not set, the stats endpoint is open to anyone.

**Severity:** High

**Fix:** Use the same constant-time comparison as the admin server.

### 6.2 Scheduler Auth -- Not Constant-Time

**File:** `/home/founder3/code/github/itlackey/openpalm/packages/scheduler/src/server.ts:42-48`

```typescript
function requireAuth(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const token =
    req.headers.get("x-admin-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return token === ADMIN_TOKEN;
}
```

Same issue: plain `===` comparison, not timing-safe.

**Severity:** High

**Fix:** Import or reimplement `safeTokenCompare` from the admin helpers.

### 6.3 Memory Service Auth Token -- Unverified

The memory service receives `MEMORY_AUTH_TOKEN` but the review cannot verify
the memory service code (it is in `core/memory/`). If the memory service is
accessible on the host port without token validation, it is a vector for data
exfiltration.

**Severity:** High (pending verification of memory service auth implementation)

### 6.4 Scheduler Gets Full Data Directory

```yaml
# core.compose.yml:167
volumes:
  - ${OP_HOME}/data:/openpalm/data
```

The scheduler has access to the entire `data/` directory. This includes
`data/admin/`, `data/assistant/`, `data/memory/` -- far more than it needs.
The scheduler only needs `data/scheduler/` (if anything) and read access to
`config/automations/`.

**Severity:** High

**Recommendation:** Restrict scheduler to `${OP_HOME}/data/scheduler:/openpalm/data`
and `${OP_HOME}/config:/openpalm/config:ro`.

### 6.5 No CORS Headers on Admin API

The admin API routes do not set CORS headers. Since the admin UI is served
from the same origin, this is fine for the SvelteKit app. However, the API is
also accessed by the assistant (different origin: `assistant:4096` to
`admin:8100`). Docker internal networking uses hostname resolution, not
browser CORS, so this is not a practical issue -- but it means a browser-based
client on a different port cannot use the API without a proxy.

**Severity:** Informational

---

## 7. Complexity Callouts

Per the CLAUDE.md directive to "callout any complexity that cannot be
justified":

| Component | Complexity | Justified? |
|-----------|-----------|------------|
| Multi-file compose overlays | High | Yes -- enables drop-in addons without touching core files |
| Shared lib barrel export (327 lines, 21 modules) | High | Partially -- the "single source of truth" goal is good but the monolithic barrel creates coupling |
| Registry system (git clone + discovery) | Medium | Partially -- useful for ecosystem but adds maintenance burden |
| Secret backend abstraction (plaintext + pass) | Medium | Questionable -- the pass backend serves very few users |
| Rollback/snapshot system | Medium | Premature -- could be a simple file copy |
| 3-layer env file precedence | High | No -- a single generated env file would be simpler and more predictable |
| Varlock secret redaction (2 layers) | Medium | Yes -- genuine security for AI context windows |
| SSRF URL validation | Low | Yes -- necessary for a system that makes HTTP calls from user input |
| Orchestrator file lock | Low | Yes -- prevents race conditions in lifecycle operations |
| Preflight validation on every mutation | Low | Yes -- catches config errors before destructive operations |

---

## 8. Recommendations Summary

### Must Fix (Critical/High)

1. **Admin token in localStorage** -- Replace with httpOnly session cookies.
   Severity: Critical.

2. **Guardian /stats timing attack** -- Use constant-time token comparison.
   File: `core/guardian/src/server.ts:84`.
   Severity: High.

3. **Scheduler timing attack** -- Use constant-time token comparison.
   File: `packages/scheduler/src/server.ts:47`.
   Severity: High.

4. **Scheduler over-broad volume mount** -- Restrict to only the directories
   it needs.
   File: `.openpalm/stack/core.compose.yml:164-167`.
   Severity: High.

5. **Verify memory service auth** -- Confirm that `MEMORY_AUTH_TOKEN` is
   actually validated on every request.
   File: `core/memory/` (not reviewed).
   Severity: High.

### Should Fix (Medium)

6. **Admin mounts entire OP_HOME** -- Restrict to specific subdirectories.
   File: `.openpalm/stack/addons/admin/compose.yml:62`.

7. **Assistant direct host exposure without auth** -- Enable
   `OPENCODE_AUTH: "true"` by default or document the risk prominently.
   File: `.openpalm/stack/core.compose.yml:64`.

8. **Shared lib coupling** -- Add subpath exports to allow consumers to
   import only what they need.
   File: `packages/lib/src/index.ts`.

9. **3-layer env precedence** -- Generate a single merged env file instead
   of relying on Docker Compose env precedence.
   Files: `config-persistence.ts`, `docker.ts`.

10. **All API keys in assistant Docker inspect** -- The entrypoint mitigation
    is good but keys are still visible before the entrypoint runs.
    File: `.openpalm/stack/core.compose.yml:77-90`.

### Nice to Have (Low/Informational)

11. Document that "file assembly, not rendering" applies to compose files
    only; env file generation is necessarily dynamic.

12. Fix the `compose.dev.yaml` voice channel binding to use a bind address
    variable.

13. Consider splitting the rollback system into a simpler backup-before-
    upgrade pattern until the project has more users.

---

## 9. What Works Well

To be fair, several aspects of the architecture are genuinely well-done:

1. **Guardian security pipeline** -- The HMAC + replay + rate-limit chain is
   solid, with thoughtful details like timing-safe comparison and dummy-secret
   enumeration prevention.

2. **Assistant isolation** -- No Docker socket, no vault/stack access, only
   memory and admin API access through authenticated channels.

3. **LAN-first defaults** -- Every port binding defaults to 127.0.0.1.

4. **Addon compose overlay pattern** -- Clean, extensible, truly
   "drop a file" for new channels.

5. **Varlock secret redaction** -- Two-layer approach (process stdout and
   shell tool output) is a genuine innovation for AI assistant platforms.

6. **Docker socket proxy with EXEC: 0** -- Properly limits the admin's
   Docker API access.

7. **Service allowlist validation** -- `isAllowedService()` parses actual
   compose YAML rather than relying on naming conventions.

8. **No shell interpolation** -- Docker commands use `execFile` with argument
   arrays consistently.

9. **SSRF protection** -- `validateExternalUrl()` is well-calibrated for the
   LAN-first threat model, allowing LAN IPs while blocking metadata endpoints.

---

*End of review.*
