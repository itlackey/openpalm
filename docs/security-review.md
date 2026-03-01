# OpenPalm Security Review — Red Team Assessment

**Date:** 2026-03-01
**Scope:** Full application stack — admin API, guardian, channels, assistant, Docker infrastructure, CI/CD, supply chain
**Methodology:** Manual source code review, architecture analysis, threat modeling

---

## Executive Summary

This red team assessment identified **55 security findings** across the OpenPalm stack. The most critical issues center around **authentication bypass during initial setup**, **Docker socket proxy over-permissioning**, and **unauthenticated exposure of setup credentials**. Several findings chain together to create high-impact attack paths — for example, an attacker on the same network as a fresh installation can take complete ownership of the stack in seconds.

| Severity | Count |
|----------|-------|
| CRITICAL | 5     |
| HIGH     | 14    |
| MEDIUM   | 22    |
| LOW      | 14    |

---

## CRITICAL Findings

### SEC-001: Authentication Bypass When ADMIN_TOKEN Is Empty

**Files:** `core/admin/src/lib/server/helpers.ts:9-15`, `core/admin/src/lib/server/helpers.ts:53-66`

The `safeTokenCompare` function compares the provided token against `state.adminToken`. When `state.adminToken` is an empty string (the default before setup — per `control-plane.ts:250`), and the attacker sends an empty `x-admin-token: ` header, the comparison becomes `safeTokenCompare("", "")`. This creates two zero-length Buffers, passes the length check (`0 !== 0` is false), and `timingSafeEqual(Buffer.alloc(0), Buffer.alloc(0))` returns `true`.

**Every `requireAdmin`-protected endpoint is completely unauthenticated until the user configures an ADMIN_TOKEN.** The default state grants full admin access to anyone.

**Impact:** Any unauthenticated attacker can access all admin API endpoints (container management, config changes, secrets updates, channel install/uninstall, compose up/down) on any OpenPalm instance that has not completed setup.

**Remediation:** Add an explicit empty-string check in `safeTokenCompare`:
```typescript
if (!a || !b) return false;
```

---

### SEC-002: Setup Token Leaked via Unauthenticated Endpoints

**Files:** `core/admin/src/routes/admin/setup/+server.ts:58`, `core/admin/src/routes/setup/+page.server.ts:13`

The `GET /admin/setup` endpoint requires no authentication. When setup is not yet complete, it returns the ephemeral `setupToken` in the JSON response. This token is the **sole credential** required to execute `POST /admin/setup` during first-run, which allows setting the `ADMIN_TOKEN` and running the full install sequence. The setup page's server-side load function also returns the token without auth.

**Impact:** An attacker can hit `GET /admin/setup` to obtain the `setupToken`, then immediately call `POST /admin/setup` to set an `ADMIN_TOKEN` of their choosing, taking over the entire instance in a race condition against the legitimate operator.

**Remediation:** Do not return the setup token via the API. Instead, generate it during `setup.sh`, display it in the terminal, and require the user to enter it in the browser to prove they are the operator.

---

### SEC-003: Docker Socket Proxy Grants EXEC and POST — Container Escape Path

**File:** `assets/docker-compose.yml:184-188`

The docker-socket-proxy is configured with `EXEC: 1` and `POST: 1`. The `EXEC` permission allows the admin container to execute arbitrary commands inside any container via the Docker API `POST /containers/{id}/exec`. Combined with `POST: 1`, this permits creating new containers with arbitrary mounts.

**Impact:** Full container escape to host. An attacker who compromises the admin service can exec into any container, read the host filesystem, or create a new privileged container mounting `/`. This is equivalent to root access on the host.

**Remediation:** Remove `EXEC: 1`. If exec is needed for specific operations (Caddy reload), use a more restrictive proxy configuration or a purpose-built sidecar.

---

### SEC-004: Guardian Endpoint Exposed Without Access Restriction via Caddy

**File:** `assets/Caddyfile:41-43`

The `/guardian/*` path in the Caddyfile has no `import lan_only` directive. Unlike `/admin/*` routes that are restricted to LAN IPs, the guardian endpoint is open to all traffic from any source.

**Impact:** An attacker on the internet can directly reach the guardian. While HMAC verification protects the `/channel/inbound` endpoint, this exposes the guardian's full attack surface (including the `/health` endpoint and any future endpoints) to external networks.

**Remediation:** Add `import lan_only` to the guardian handle block, or explicitly define which access level is intended.

---

### SEC-005: Curl Pipe to Bash — Insecure Supply Chain Pattern

**Files:** `scripts/setup.sh:5`, `core/assistant/Dockerfile:13`

The setup script advertises `curl -fsSL ... | bash` installation, and the assistant Dockerfile uses `curl -fsSL https://opencode.ai/install | HOME=/usr/local bash` to install opencode at build time. This executes arbitrary remote code without integrity verification.

**Impact:** Supply chain attack. Compromised install scripts would inject malware into every built image.

**Remediation:** Pin the opencode install by checksum or use a pre-built binary with GPG signature verification. Document the expected hash in the Dockerfile.

---

## HIGH Findings

### SEC-006: Admin Token Stored in localStorage — XSS Exfiltration

**File:** `core/admin/src/lib/auth.ts:5,13`

The admin token is stored in `localStorage` under `openpalm.adminToken`. Any XSS payload running on the same origin can exfiltrate it via `localStorage.getItem()`.

**Remediation:** Consider using `httpOnly` cookies with `SameSite=Strict` and `Secure` flags for token storage instead of localStorage.

---

### SEC-007: No Rate Limiting or Brute Force Protection on Admin Auth

**Files:** `core/admin/src/lib/server/helpers.ts:53-66`, all admin API endpoints

No admin API endpoint implements rate limiting, account lockout, or backoff. An attacker can perform unlimited brute-force attempts against the admin token.

**Remediation:** Implement per-IP rate limiting on all admin endpoints (e.g., 10 failed auth attempts per minute triggers a progressive delay).

---

### SEC-008: No Token Expiration or Session Rotation

**Files:** `core/admin/src/lib/auth.ts`, `core/admin/src/lib/server/helpers.ts:53-66`

The admin token has no expiration, no TTL, and no rotation mechanism. A stolen token remains valid forever. There is no way to force re-authentication without manually editing `secrets.env` and restarting.

**Remediation:** Implement session-based tokens with configurable expiration. Add a token rotation mechanism accessible from the admin UI.

---

### SEC-009: No ADMIN_TOKEN Strength Requirements

**File:** `core/admin/src/routes/admin/setup/+server.ts:108-110`

The setup endpoint accepts any non-empty string as `adminToken` — including single characters. No minimum length, complexity, or entropy requirements.

**Remediation:** Enforce minimum token length (16+ characters) and minimum entropy requirements. Consider auto-generating a strong token and displaying it to the user.

---

### SEC-010: Chat Channel Missing Auth on Anthropic `/v1/messages` Endpoint

**File:** `channels/chat/server.ts:83-84`

The authentication check only applies to `isChatCompletions` or `isCompletions`. The Anthropic-format endpoint (`/v1/messages`) is explicitly excluded from the API key check:
```typescript
if ((isChatCompletions || isCompletions) && API_KEY) {
```

**Impact:** Even when `OPENAI_COMPAT_API_KEY` is configured, requests to `/v1/messages` bypass authentication entirely.

**Remediation:** Add `isAnthropicMsg` to the auth check condition, and verify the `x-api-key` header for Anthropic-format requests.

---

### SEC-011: Discord Webhook Endpoint Has No Inbound Authentication

**File:** `channels/discord/server.ts:39-44`

The `/discord/webhook` endpoint has no authentication. Unlike the API and chat channels which check API keys, the Discord channel accepts any POST from any source.

**Remediation:** Implement Discord webhook signature verification using `X-Signature-Ed25519` and `X-Signature-Timestamp` headers, or add shared-secret authentication on the inbound endpoint.

---

### SEC-012: Prompt Injection via Stored Memory Content

**File:** `core/assistant/plugins/memory-context.ts:29-31,98`

Memory content from OpenMemory is injected into the assistant's context during session compaction without sanitization. An attacker who stores malicious memory entries can inject adversarial instructions into the assistant's prompt.

**Remediation:** Add content filtering on memory retrieval. Consider sandboxing memory content with clear delimiters and instructing the model to treat it as untrusted data.

---

### SEC-013: No TLS/HTTPS Enforcement in Reverse Proxy

**File:** `assets/Caddyfile:17`

Caddy listens on `:80` (plain HTTP) with no HTTPS configuration, no HSTS, and no HTTP-to-HTTPS redirect. All traffic including admin tokens and API keys flows in cleartext.

**Remediation:** Configure Caddy for HTTPS with automatic certificates for production deployments. Add HSTS headers. Document the requirement for TLS when deploying beyond localhost.

---

### SEC-014: Missing Security Headers in Reverse Proxy

**File:** `assets/Caddyfile` (entire file)

No security headers are configured: no `X-Frame-Options`, no `Content-Security-Policy`, no `X-Content-Type-Options`, no `Referrer-Policy`.

**Remediation:** Add a standard security headers block to the Caddyfile:
```
header {
    X-Frame-Options DENY
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Content-Security-Policy "default-src 'self'"
}
```

---

### SEC-015: Admin Container Starts as Root with Broad Host Mounts

**File:** `assets/docker-compose.yml:200-244`, `core/admin/entrypoint.sh`

The admin container runs initially as root (for cron setup), then drops privileges via gosu. It has writable bind mounts to CONFIG_HOME, STATE_HOME, and DATA_HOME. Combined with the docker-socket-proxy, this is a powerful attack surface if the privilege drop is bypassed.

**Remediation:** Explore running cron setup in an init container or sidecar to avoid root in the main process. Mount directories read-only where possible.

---

### SEC-016: Kiosk ISO Uses Hardcoded Default Password

**Files:** `scripts/iso/build-debian13-kiosk-iso.sh:27`, `scripts/iso/files/hooks/0100-openpalm-configure.chroot:5`

The kiosk ISO uses `ChangeMeNow123!` as a default password, embedded in the ISO build. While `chage -d 0` forces change on first login, the password is baked into the ISO image and extractable.

**Remediation:** Generate a random password at build time and display it only in the terminal output. Never embed passwords in filesystem artifacts.

---

### SEC-017: Postgres Password Potentially Empty

**File:** `assets/docker-compose.yml:36`

`POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}` defaults to an empty string. If `stack.env` is missing, PostgreSQL starts with no password.

**Remediation:** Add a startup check that fails if `POSTGRES_PASSWORD` is empty. Consider a healthcheck that validates authentication is required.

---

## MEDIUM Findings

### SEC-018: No CORS Configuration on Admin API

**File:** `core/admin/src/lib/server/helpers.ts`

No CORS headers or policy is configured. The custom `x-admin-token` header triggers CORS preflight (which provides some implicit CSRF protection), but no explicit deny-all CORS policy exists.

**Remediation:** Add explicit CORS headers restricting allowed origins.

---

### SEC-019: Missing CSRF Protection on State-Changing Endpoints

**Files:** All POST admin endpoints, `core/admin/src/routes/+page.svelte`, `core/admin/src/routes/setup/+page.svelte`

The admin console makes state-changing requests using `fetch()` with only the admin token from localStorage. No CSRF tokens are used.

**Remediation:** Implement CSRF tokens or verify `Origin`/`Referer` headers on state-changing endpoints.

---

### SEC-020: Shared Memory Namespace — No Per-User Isolation

**Files:** `core/assistant/tools/memory-*.ts`, `core/assistant/tools/lib.ts`

All memory tools use a single global `USER_ID` from `OPENMEMORY_USER_ID`. All channel users share the same memory namespace. Any user can access, modify, or delete any other user's memories.

**Remediation:** Pass the channel user ID through to the memory tools and scope all memory operations per-user.

---

### SEC-021: Connections Page Bypasses API Authentication

**File:** `core/admin/src/routes/connections/+page.server.ts:13-32`

The server-side load function directly reads secrets and returns masked values without any authentication check.

**Remediation:** Add authentication checks to server-side load functions that access sensitive data.

---

### SEC-022: Error Messages Leak Internal Infrastructure Details

**Files:** `core/admin/src/routes/admin/setup/+server.ts:130,173,205`, `channels/*/server.ts` (error handlers)

Docker stderr, internal error messages, filesystem paths, and service names are returned in API error responses.

**Remediation:** Return generic error messages to clients. Log detailed errors server-side only.

---

### SEC-023: API Key Comparison Uses Non-Constant-Time String Equality

**Files:** `channels/api/server.ts:73`, `channels/chat/server.ts:84`

Channel API key authentication uses JavaScript `!==` which is vulnerable to timing attacks.

**Remediation:** Use `timingSafeEqual` for all secret comparisons, including API key checks.

---

### SEC-024: Unvalidated User ID Enables Cross-User Impersonation

**Files:** `channels/api/server.ts:87`, `channels/chat/server.ts:99`

Channels accept a user-controlled `user` field from the request body as the `userId`. Any authenticated client can send messages as any user.

**Remediation:** Derive user identity from the authentication credential, not from the request body.

---

### SEC-025: No Request Body Size Limit

**File:** `core/admin/src/lib/server/helpers.ts:81-89`

`parseJsonBody` calls `request.json()` without body size limits. Large payloads are fully buffered.

**Remediation:** Enforce a maximum body size (e.g., 1MB) before JSON parsing.

---

### SEC-026: getActor Trusts Token Presence, Not Validity

**File:** `core/admin/src/lib/server/helpers.ts:69-73`

`getActor` returns `"admin"` if any `x-admin-token` header is present, even if the token is invalid.

**Remediation:** Have `getActor` validate the token or only be called after `requireAdmin` succeeds.

---

### SEC-027: Secrets Written in Plaintext to Multiple Disk Locations

**Files:** `core/admin/src/lib/server/control-plane.ts:659-676,997-1001`

Postgres password, API keys, and channel secrets are written in plaintext to `DATA_HOME/stack.env` and `STATE_HOME/artifacts/stack.env`.

**Remediation:** Use filesystem permissions (0600) for all secrets files. Consider encryption at rest for sensitive values.

---

### SEC-028: secrets.env Template Tracked in Version Control

**Files:** `assets/secrets.env`, `.gitignore`

The secrets.env template is tracked by git. No `.gitignore` rule prevents accidental commit of filled-in values.

**Remediation:** Add `**/secrets.env` to `.gitignore`. Rename the template to `secrets.env.example` or `secrets.env.template`.

---

### SEC-029: No Container Resource Limits

**File:** `assets/docker-compose.yml` (all services)

No services define `mem_limit`, `cpus`, or `pids_limit`.

**Remediation:** Add resource limits to all services, especially the assistant and PostgreSQL.

---

### SEC-030: Docker Images Use `latest` Tag by Default

**File:** `assets/docker-compose.yml:100,140`

OpenPalm service images default to `latest` tag. Third-party images like `caddy:2-alpine` and `postgres:18.2-alpine` are unpinned.

**Remediation:** Pin all images to specific versions with SHA256 digests.

---

### SEC-031: Unbounded Audit Log on Disk

**File:** `core/admin/src/lib/server/control-plane.ts:1079-1111`

The audit log JSONL file grows without bound. Only the in-memory copy is trimmed to 1000 entries.

**Remediation:** Implement log rotation with a size cap (e.g., 10MB with 3 rotated files).

---

### SEC-032: No Rate Limiting on Channel Endpoints

**Files:** `channels/api/server.ts`, `channels/chat/server.ts`, `channels/discord/server.ts`

None of the channel adapters implement rate limiting.

**Remediation:** Add per-IP and per-user rate limiting in channel adapters, or rely explicitly on the guardian's rate limiting with documentation.

---

### SEC-033: SSH Port Exposed on Assistant Container

**File:** `assets/docker-compose.yml:120`

Port 22 (SSH) is mapped to host port 2222. If bind address is changed to `0.0.0.0`, SSH becomes publicly accessible.

**Remediation:** Default SSH to disabled. Only enable when `OPENCODE_ENABLE_SSH=1` is explicitly set.

---

### SEC-034: Automation ADMIN_TOKEN in Process Table

**File:** `assets/automations/update-containers:10`

Cron jobs source `/etc/openpalm-env` and pass `ADMIN_TOKEN` in curl command-line arguments, visible in `/proc/*/cmdline`.

**Remediation:** Pass the token via stdin or a temp file instead of command-line arguments.

---

### SEC-035: No Read-Only Root Filesystem on Containers

**File:** `assets/docker-compose.yml` (all services)

No containers use `read_only: true`, allowing post-exploitation persistence.

**Remediation:** Enable `read_only: true` where feasible, with explicit `tmpfs` mounts for writable paths.

---

### SEC-036: OpenCode Auth Disabled by Default

**File:** `assets/docker-compose.yml:105`

`OPENCODE_AUTH: "false"` disables authentication on the OpenCode interface. Any LAN user can access it.

**Remediation:** Enable OpenCode auth by default or document the security implications.

---

## LOW Findings

### SEC-037: Client-Controlled Request ID in Audit Logs

**File:** `core/admin/src/lib/server/helpers.ts:48-50`

Request IDs from client headers appear in audit logs without sanitization.

---

### SEC-038: Duplicate safeTokenCompare Implementations

**Files:** `core/admin/src/lib/server/helpers.ts:9-15`, `core/admin/src/routes/admin/setup/+server.ts:28-34`

Two copies with subtle behavioral differences — the setup version rejects empty strings, the helper version does not.

---

### SEC-039: Silent JSON Parse Failures Return Empty Object

**File:** `core/admin/src/lib/server/helpers.ts:81-89`

Malformed JSON is silently treated as `{}` rather than returning 400.

---

### SEC-040: Setup Endpoint Exposes System Username

**File:** `core/admin/src/routes/admin/setup/+server.ts:59`

The unauthenticated setup endpoint returns `detectedUserId` (the system username).

---

### SEC-041: dev.env.example Contains Misleading Placeholder Token

**File:** `dev.env.example:7`

`ADMIN_TOKEN=REQUIRED!` could be used as-is if a user copies the file without editing.

---

### SEC-042: Health Endpoints Enable Service Fingerprinting

**Files:** `core/admin/src/routes/health/+server.ts`, `core/admin/src/routes/guardian/health/+server.ts`

Unauthenticated health endpoints return service names.

---

### SEC-043: Gallery Endpoints Accept Arbitrary Extension IDs

**Files:** `core/admin/src/routes/admin/gallery/install/+server.ts`, `core/admin/src/routes/admin/gallery/item/[id]/+server.ts`

Extension IDs are not validated against a known catalog before being accepted.

---

### SEC-044: .dockerignore Does Not Exclude Sensitive Files

**File:** `.dockerignore`

Does not explicitly exclude `.env`, `secrets.env`, `*.pem`, or `*.key` files.

---

### SEC-045: No `--no-new-privileges` Security Option on Containers

**File:** `assets/docker-compose.yml`

No containers use `security_opt: ["no-new-privileges:true"]`.

---

### SEC-046: Nonce Cache Has Weak Eviction Under Load

**File:** `core/guardian/src/server.ts:93-110`

The nonce cache only prunes when size exceeds 100 entries, with O(n) eviction.

---

### SEC-047: Timing Side-Channel in Token Length Check

**Files:** `core/admin/src/lib/server/helpers.ts:13`, `core/admin/src/routes/admin/setup/+server.ts:32`

Early return on buffer length mismatch leaks the token length.

---

### SEC-048: Caddy Container on Multiple Networks Increases Pivot Surface

**File:** `assets/docker-compose.yml:27`

Caddy spans `assistant_net`, `channel_lan`, and `channel_public`, making it a high-value lateral-movement target.

---

### SEC-049: Kiosk User Added to Docker Group (Root-Equivalent)

**File:** `scripts/iso/files/hooks/0100-openpalm-configure.chroot:7`

Docker group membership is effectively root-equivalent access.

---

### SEC-050: Guardian Dockerfile Deletes Lock File Before Install

**File:** `core/guardian/Dockerfile:21`

The guardian Dockerfile runs `rm -f bun.lock bun.lockb && bun install --production`, destroying all dependency integrity guarantees. The guardian is the security-critical HMAC ingress component.

---

### SEC-051: Inconsistent Docker Base Image Pinning

**Files:** All Dockerfiles

Base images are inconsistently pinned — some use floating tags (`oven/bun:1-slim`, `node:22-slim`), others pin to minor versions (`oven/bun:1.3.9`). None use SHA256 digest pinning.

---

### SEC-052: No Security-Focused ESLint Rules

**File:** `core/admin/eslint.config.js`

No security plugins (`eslint-plugin-security`, `eslint-plugin-no-unsanitized`) are configured. `no-undef` is disabled.

---

### SEC-053: Vite Config Loads All Env Vars Into process.env

**File:** `core/admin/vite.config.ts:12-16`

`loadEnv(mode, rootDir, "")` loads ALL environment variables (not just `VITE_`-prefixed ones), increasing risk of secret exposure in client bundles.

---

### SEC-054: No Content Security Policy for Admin UI

**File:** `core/admin/svelte.config.js`

No CSP directives are configured. XSS in the admin panel could steal admin tokens and execute Docker operations.

---

### SEC-055: Stale package-lock.json Alongside bun.lock

**File:** `package-lock.json`

An outdated `package-lock.json` with wrong project name (`op-mvp` vs `openpalm`) and obsolete dependencies coexists with `bun.lock`. Running `npm install` instead of `bun install` could pull vulnerable old versions.

---

## Attack Chains

### Chain 1: Fresh Install Takeover (CRITICAL)
1. Attacker scans LAN for port 8080/8100
2. Hits `GET /admin/setup` — receives `setupToken`
3. Calls `POST /admin/setup` with their own `adminToken` and malicious LLM key
4. Now owns the entire OpenPalm instance permanently

### Chain 2: Post-Setup Privilege Escalation (HIGH)
1. Attacker finds XSS in any admin UI path
2. Steals `adminToken` from localStorage
3. Uses token to access all admin APIs
4. Via Docker socket proxy (with EXEC), breaks out to host

### Chain 3: Channel-Based LLM Abuse (HIGH)
1. Attacker discovers unauthenticated `/v1/messages` endpoint on chat channel
2. Sends prompt injection payload to manipulate the assistant
3. Assistant executes admin tools (install/uninstall/container management)
4. Attacker achieves persistent access via stored memory injection

---

## Recommended Priority Order

1. **P0 (Immediate):** SEC-001 (empty token bypass), SEC-002 (setup token leak), SEC-003 (docker exec)
2. **P1 (This week):** SEC-004 (guardian exposure), SEC-010 (chat auth bypass), SEC-011 (discord no auth), SEC-009 (token strength)
3. **P2 (This sprint):** SEC-005 (curl|bash), SEC-006 (localStorage), SEC-007 (rate limiting), SEC-013/014 (TLS/headers)
4. **P3 (Backlog):** All MEDIUM and LOW findings
