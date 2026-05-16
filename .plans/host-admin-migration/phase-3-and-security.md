# Phase 3 and Security Hardening

**Goal:** (1) Implement security hardening measures that must ship alongside Phase 1a and be
verified in Phase 2. (2) Delete all container-admin artifacts after host-admin is the confirmed
default (Phase 2 complete). After Phase 3, no admin container, no `admin-tools` package, no
`core/admin/` image, and no `selfRecreateAdmin` code path exist anywhere in the repo.

**Scope boundary:** Security steps (SEC-1 through SEC-5) are scoped to Phase 1a implementation
and Phase 2 testing. Deletion steps (Phase 3, Steps 1–13) execute only after
`OPENPALM_ADMIN_MODE=host` is the default and all Phase 2 validation passes.

---

## Part 1: Security Hardening

These five steps harden the host admin server against CSRF, DNS rebinding, path traversal, and
token-theft attacks. SEC-1 and SEC-2 belong in `packages/admin/`; SEC-3 and SEC-4 belong in
`packages/cli/` and `packages/lib/`; SEC-5 is a one-line platform guard.

---

## ✅ SEC-1: Host header allowlist middleware

**Files:**
- `packages/admin/src/lib/server/helpers.ts` (add after line 279)
- `packages/admin/src/hooks.server.ts` (create or modify)

**Change type:** modify / create

**Context:** Without a Host header check, a DNS-rebinding attack can cause a browser on the same
LAN to reach the admin server using an attacker-controlled hostname. Rejecting any `Host` value
that is not `localhost:{port}` or `127.0.0.1:{port}` closes this vector. The check must run
before every handler — SvelteKit's `handle` hook in `hooks.server.ts` is the correct insertion
point because it wraps all routes uniformly.

**Exact change — add `checkHostHeader` to `packages/admin/src/lib/server/helpers.ts` after line 279:**

```typescript
// ── SEC-1: Host header allowlist ─────────────────────────────────────────
/**
 * Reject requests whose Host header does not match localhost or 127.0.0.1
 * on the configured admin port.
 *
 * @param request  Incoming Request (or SvelteKit RequestEvent.request)
 * @param port     The port this server is bound to (e.g. 3880 or 8100)
 * @returns        A 400 Response if the host is rejected; null if allowed
 */
export function checkHostHeader(request: Request, port: number): Response | null {
  const host = request.headers.get("host") ?? "";
  // Strip any trailing dot or extra whitespace
  const normalized = host.trim().replace(/\.$/, "");
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (allowed.includes(normalized)) return null;
  return new Response(
    JSON.stringify({ error: "invalid_host", host: normalized }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}
```

**Exact change — wire into `packages/admin/src/hooks.server.ts`:**

If the file does not exist, create it. If it exists, add the `handle` export:

```typescript
import type { Handle } from "@sveltejs/kit";
import { checkHostHeader } from "$lib/server/helpers.js";

// Read port at module init so it is not re-parsed on every request.
const ADMIN_PORT = Number(process.env.PORT ?? 8100);

export const handle: Handle = async ({ event, resolve }) => {
  const hostError = checkHostHeader(event.request, ADMIN_PORT);
  if (hostError) return hostError;
  return resolve(event);
};
```

**AKM assistance:** none

**Validation:**
```bash
# Bad Host → 400
curl -H "Host: evil.example.com" http://localhost:3880/health
# Expected: {"error":"invalid_host","host":"evil.example.com"} with HTTP 400

# Good Host → passes through
curl -H "Host: localhost:3880" http://localhost:3880/health
# Expected: {"ok":true} (or whatever /health normally returns) with HTTP 200
```

---

## ✅ SEC-2: Origin check on state-mutating endpoints

**Files:**
- `packages/admin/src/lib/server/helpers.ts` (add after SEC-1 block)

**Change type:** modify

**Context:** The `Host` header check (SEC-1) blocks DNS rebinding. The `Origin` check blocks
cross-site request forgery on POST/PUT/DELETE from attacker-controlled pages. Requests with no
`Origin` header (curl, CLI tools, the assistant) are allowed through; the assistant already uses
`x-admin-token` / cookie for auth. Requests with an `Origin` that does not resolve to localhost
are rejected with 403 before the admin token is ever checked.

**Exact change — add `checkOriginHeader` to `packages/admin/src/lib/server/helpers.ts` after the SEC-1 block:**

```typescript
// ── SEC-2: Origin check for state-mutating requests ──────────────────────
/**
 * Reject POST/PUT/DELETE requests whose Origin header does not match
 * localhost or 127.0.0.1. Requests with no Origin (non-browser clients)
 * are always allowed.
 *
 * @param request  Incoming Request
 * @param port     The port this server is bound to
 * @returns        A 403 Response if the origin is rejected; null if allowed
 */
export function checkOriginHeader(request: Request, port: number): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const origin = request.headers.get("origin");
  if (!origin) return null; // non-browser clients have no Origin

  try {
    const u = new URL(origin);
    const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (allowed.includes(u.host)) return null;
  } catch {
    // Unparseable Origin is treated as hostile
  }
  return new Response(
    JSON.stringify({ error: "forbidden_origin", origin }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
}
```

**Wire into `withAdminBody` at line 269 — add before `requireAdmin`:**

```typescript
// In withAdminBody (or its equivalent inline call):
const originError = checkOriginHeader(event.request, ADMIN_PORT);
if (originError) return originError;
// ... existing requireAdmin call follows
```

**Note:** `ADMIN_PORT` is the same constant defined in `hooks.server.ts`. Import or re-derive it
in helpers.ts as `const ADMIN_PORT = Number(process.env.PORT ?? 8100)`.

**AKM assistance:** none

**Validation:**
```bash
# POST with bad Origin → 403
curl -X POST http://localhost:3880/admin/install \
  -H "Origin: http://evil.com" \
  -H "x-admin-token: dev-admin-token" \
  -H "content-type: application/json" \
  -d '{}' | jq .error
# Expected: "forbidden_origin"

# POST with matching Origin → passes through to auth/handler
curl -X POST http://localhost:3880/admin/install \
  -H "Origin: http://localhost:3880" \
  -H "x-admin-token: dev-admin-token" \
  -H "content-type: application/json" \
  -d '{}' | jq .
# Expected: normal handler response (may be an error about missing fields, not 403)

# POST with no Origin (CLI/curl default) → passes through
curl -X POST http://localhost:3880/admin/install \
  -H "x-admin-token: dev-admin-token" \
  -H "content-type: application/json" \
  -d '{}' | jq .
# Expected: normal handler response
```

---

## ✅ SEC-3: Admin skills allowlist for host OpenCode subprocess

**Files:**
- `packages/cli/src/lib/admin-skills/index.ts` (new file)

**Change type:** create

**Context:** When the assistant (OpenCode subprocess) calls admin API operations via the host
admin gateway, it uses skills defined in `packages/admin-tools/`. After the host migration
those skills call the admin API over loopback. A compromised or hallucinating assistant could
request destructive operations with adversarial arguments (path traversal, empty confirmation
tokens, raw shell strings). This module validates every argument before it reaches the admin API
or lib functions.

Four invariants are enforced on every admin skill call:
1. **No path traversal** — `..` is rejected in any path argument.
2. **Service names validated** — only names in `CORE_SERVICES` are accepted.
3. **Destructive ops require confirmation** — any operation tagged destructive must include
   `confirmation: "yes-i-am-sure"`.
4. **No raw shell strings** — arguments must be typed values (string, number, boolean);
   no sub-shell expansions (`$()`, backticks, `|`, `&&`).

**Exact change — full file content for `packages/cli/src/lib/admin-skills/index.ts`:**

```typescript
/**
 * Admin skills allowlist.
 *
 * Validates arguments for every admin skill call before they reach the admin API
 * or lib functions. This is the security boundary between the assistant subprocess
 * and the control plane.
 *
 * Four invariants enforced:
 *   1. No ".." in path arguments (path traversal).
 *   2. Service names must be in CORE_SERVICES.
 *   3. Destructive operations require confirmation: "yes-i-am-sure".
 *   4. No raw shell strings (sub-shell expansions, pipes, redirects).
 */
import { CORE_SERVICES } from "@openpalm/lib";

// ── Invariant helpers ────────────────────────────────────────────────────

/** INV-1: No path traversal */
function assertNoPathTraversal(value: string, field: string): string | null {
  if (value.includes("..")) {
    return `${field}: path traversal ("..") is not allowed`;
  }
  return null;
}

/** INV-2: Service name must be in CORE_SERVICES */
function assertValidServiceName(value: string, field: string): string | null {
  const valid = new Set<string>(CORE_SERVICES);
  if (!valid.has(value as never)) {
    return `${field}: "${value}" is not a valid service name (allowed: ${[...valid].join(", ")})`;
  }
  return null;
}

/** INV-3: Destructive ops require explicit confirmation */
function assertConfirmation(confirmation: unknown, field = "confirmation"): string | null {
  if (confirmation !== "yes-i-am-sure") {
    return `${field}: destructive operation requires confirmation === "yes-i-am-sure"`;
  }
  return null;
}

/** INV-4: No shell special characters in string arguments */
const SHELL_INJECTION_RE = /[$`|&;<>(){}[\]\\!]/;
function assertNoShellInjection(value: string, field: string): string | null {
  if (SHELL_INJECTION_RE.test(value)) {
    return `${field}: shell special characters are not allowed in admin skill arguments`;
  }
  return null;
}

// ── Public validation entry points ───────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate arguments for a container operation (up/down/restart/start/stop).
 *
 * @param serviceName  The name of the service to act on
 */
export function validateContainerOp(serviceName: string): ValidationResult {
  const err =
    assertNoPathTraversal(serviceName, "serviceName") ??
    assertValidServiceName(serviceName, "serviceName") ??
    assertNoShellInjection(serviceName, "serviceName");
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate arguments for a destructive operation (uninstall, wipe, etc.).
 *
 * @param confirmation  Must equal "yes-i-am-sure"
 */
export function validateDestructiveOp(confirmation: unknown): ValidationResult {
  const err = assertConfirmation(confirmation);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate a filesystem path argument passed to any admin skill.
 *
 * @param path  The path string to validate
 */
export function validatePathArg(path: string): ValidationResult {
  const err =
    assertNoPathTraversal(path, "path") ??
    assertNoShellInjection(path, "path");
  if (err) return { ok: false, error: err };
  return { ok: true };
}

/**
 * Validate an addon name (same rules as service name but addons are not in CORE_SERVICES;
 * still must not contain shell characters or path traversal).
 *
 * @param name  The addon name
 */
export function validateAddonName(name: string): ValidationResult {
  // Addon names are not fixed like CORE_SERVICES, but must be clean identifiers.
  const ADDON_NAME_RE = /^[a-zA-Z0-9_-]+$/;
  if (!ADDON_NAME_RE.test(name)) {
    return { ok: false, error: `name: "${name}" is not a valid addon name (alphanumeric, _ and - only)` };
  }
  const err =
    assertNoPathTraversal(name, "name") ??
    assertNoShellInjection(name, "name");
  if (err) return { ok: false, error: err };
  return { ok: true };
}
```

**AKM assistance:** none

**Validation — adversarial unit tests in `packages/cli/src/lib/admin-skills/index.test.ts`:**

```typescript
import { describe, it, expect } from "bun:test";
import {
  validateContainerOp,
  validateDestructiveOp,
  validatePathArg,
  validateAddonName,
} from "./index.ts";

describe("validateContainerOp", () => {
  it("rejects path traversal in service name", () => {
    const r = validateContainerOp("../../etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown service name", () => {
    const r = validateContainerOp("evil-service");
    expect(r.ok).toBe(false);
  });

  it("accepts a valid core service name", () => {
    // CORE_SERVICES contains at least "assistant" — adjust to whatever is in the set
    const r = validateContainerOp("assistant");
    expect(r.ok).toBe(true);
  });
});

describe("validateDestructiveOp", () => {
  it("rejects empty confirmation", () => {
    const r = validateDestructiveOp("");
    expect(r.ok).toBe(false);
  });

  it("rejects wrong confirmation string", () => {
    const r = validateDestructiveOp("yes");
    expect(r.ok).toBe(false);
  });

  it("accepts correct confirmation", () => {
    const r = validateDestructiveOp("yes-i-am-sure");
    expect(r.ok).toBe(true);
  });
});

describe("validatePathArg", () => {
  it("rejects path traversal", () => {
    expect(validatePathArg("../../secrets").ok).toBe(false);
  });

  it("rejects shell injection characters", () => {
    expect(validatePathArg("foo$(rm -rf /)").ok).toBe(false);
  });

  it("accepts a normal relative path", () => {
    expect(validatePathArg("stash/tasks/my-task.md").ok).toBe(true);
  });
});

describe("validateAddonName", () => {
  it("rejects names with slashes", () => {
    expect(validateAddonName("../../admin").ok).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(validateAddonName("my addon").ok).toBe(false);
  });

  it("accepts a clean addon name", () => {
    expect(validateAddonName("voice-channel").ok).toBe(true);
  });
});
```

**Run validation:**
```bash
cd packages/cli && bun test src/lib/admin-skills/index.test.ts
# Expected: all tests pass; path traversal and empty confirmation must return {ok:false}
```

---

## ✅ SEC-4: Token file management

**Files:**
- `packages/lib/src/control-plane/paths.ts` (line 46, `adminServiceDir`)
- `packages/lib/src/control-plane/admin-token.ts` (new file)
- `packages/lib/src/index.ts` (barrel export)

**Change type:** modify / create

**Context:** The admin token is currently written inline during `applyInstall`. A dedicated
`admin-token.ts` module centralizes creation, storage, and rotation. The token file lives at
`{adminServiceDir}/token` with mode `0600`. `ensureAdminToken` is idempotent (skips write if
the file already exists and is non-empty). `rotateAdminToken` is called only by
`openpalm admin rotate-token` — never by any automated path.

NFS warning: file permissions (`chmod 0600`) are silently ignored on NFS mounts and CIFS shares.
`statfsSync` can detect these filesystems by magic number. The function warns but does not fail
because the operator has already chosen to put `OP_HOME` on a network share.

**Windows note:** `0o600` is a no-op on Windows because Windows does not implement POSIX
permission bits. Document this in the function JSDoc. A future follow-up can use ICACLS, but
that is out of scope for Phase 1a.

**Exact change — add `adminServiceDir` to `packages/lib/src/control-plane/paths.ts` (if not already present at line 46):**

First confirm the current content:
```bash
grep -n "adminServiceDir\|adminDir\|service" packages/lib/src/control-plane/paths.ts | head -10
```

If `adminServiceDir` is not present, add after the last existing `Dir` export:
```typescript
/** Directory for admin service state (token, pid, etc.). Lives under stateDir. */
export function adminServiceDir(homeDir: string): string {
  return join(homeDir, "state", "admin");
}
```

**Exact change — full file content for `packages/lib/src/control-plane/admin-token.ts`:**

```typescript
/**
 * Admin token file management.
 *
 * Token lives at {adminServiceDir}/token, mode 0600.
 * - ensureAdminToken: idempotent — skips write if file already exists and is non-empty.
 * - rotateAdminToken: overwrites unconditionally. Only called by `openpalm admin rotate-token`.
 *
 * Windows note: chmodSync(path, 0o600) is a no-op on Windows.
 * NFS/CIFS warning: mode bits are ignored on network shares. ensureAdminToken warns via console.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { adminServiceDir } from "./paths.js";

// NFS magic numbers (decimal)
const NFS_MAGIC    = 0x6969;
const NFSv4_MAGIC  = 0x6e4a380;
const CIFS_MAGIC   = 0xff534d42;
const NETWORK_FS_MAGICS = new Set([NFS_MAGIC, NFSv4_MAGIC, CIFS_MAGIC]);

function isNetworkFilesystem(dir: string): boolean {
  try {
    // statfsSync is a Bun/Node 22+ API. Guard for older runtimes.
    const stats = (statfsSync as ((path: string) => { type: number }) | undefined)?.(dir);
    if (stats && NETWORK_FS_MAGICS.has(stats.type)) return true;
  } catch {
    // Not available on this platform or runtime — assume local
  }
  return false;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Ensure an admin token file exists at {adminServiceDir(homeDir)}/token.
 * Idempotent: if the file already exists and is non-empty, returns the existing token.
 * Creates the directory if necessary. Sets mode 0600 (no-op on Windows/NFS).
 *
 * @param homeDir  The OP_HOME directory (e.g. ~/.openpalm)
 * @returns        The admin token (new or existing)
 */
export function ensureAdminToken(homeDir: string): string {
  const dir = adminServiceDir(homeDir);
  mkdirSync(dir, { recursive: true });

  if (isNetworkFilesystem(dir)) {
    console.warn(
      `[openpalm] Warning: admin token directory "${dir}" is on a network filesystem. ` +
      `File permissions (0600) will not be enforced by the OS.`
    );
  }

  const tokenPath = join(dir, "token");

  if (existsSync(tokenPath)) {
    const existing = Bun.file(tokenPath).textSync().trim();
    if (existing.length > 0) return existing;
  }

  const token = generateToken();
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    // Some platforms require a separate chmod call to enforce the mode.
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows — ignore silently
  }
  return token;
}

/**
 * Rotate the admin token. Overwrites the token file unconditionally.
 * Only call this from `openpalm admin rotate-token`.
 *
 * @param homeDir  The OP_HOME directory
 * @returns        The new admin token
 */
export function rotateAdminToken(homeDir: string): string {
  const dir = adminServiceDir(homeDir);
  mkdirSync(dir, { recursive: true });

  const tokenPath = join(dir, "token");
  const token = generateToken();
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Windows — ignore silently
  }
  return token;
}
```

**Exact change — export from `packages/lib/src/index.ts`:**

Find the existing export block for `control-plane` and add:
```typescript
export { ensureAdminToken, rotateAdminToken } from "./control-plane/admin-token.js";
```

**AKM assistance:** none

**Validation:**
```bash
cd packages/lib && bun -e "
  import { ensureAdminToken, rotateAdminToken } from './src/index.ts';
  const token1 = ensureAdminToken('/tmp/op-token-test');
  const token2 = ensureAdminToken('/tmp/op-token-test'); // idempotent
  console.assert(token1 === token2, 'idempotent check failed');
  const token3 = rotateAdminToken('/tmp/op-token-test');
  console.assert(token3 !== token1, 'rotate must produce a different token');
  console.log('SEC-4 validation passed');
"
ls -la /tmp/op-token-test/state/admin/token
# Expected: -rw------- (0600) owned by current user
```

---

## ✅ SEC-5: Windows `symlinkSync` → `copyFileSync` guard

**File:** `packages/cli/src/lib/opencode-subprocess.ts` (lines 59–61)

**Change type:** modify

**Context:** Line 59 calls `symlinkSync` to link the opencode binary into the subprocess working
directory. On Windows, `symlinkSync` requires elevated privileges or Developer Mode and throws
`EPERM` for unprivileged users. `copyFileSync` is already imported at line 8. A platform guard
makes the code functional on Windows without changing POSIX behavior.

**Exact change — wrap the `symlinkSync` call with a platform check:**

Before (lines 59–61):
```typescript
symlinkSync(opencodeBinaryPath, join(subprocessDir, "opencode"));
```

After:
```typescript
if (process.platform === "win32") {
  copyFileSync(opencodeBinaryPath, join(subprocessDir, "opencode.exe"));
} else {
  symlinkSync(opencodeBinaryPath, join(subprocessDir, "opencode"));
}
```

**AKM assistance:** none

**Validation:**
```bash
# On Linux/macOS: no behavior change
grep -n "symlinkSync\|copyFileSync\|win32" packages/cli/src/lib/opencode-subprocess.ts
# Expected: shows the new if/else block at the correct line

# TypeScript check
cd packages/admin && npm run check  # (or bun run check from repo root)
```

---

## Part 2: Phase 3 Deletion Plan

All steps in this section execute only after Phase 2 is fully validated — that is, after
`OPENPALM_ADMIN_MODE=host` is the confirmed default, all 592+ unit tests pass, all Playwright
tests pass, and no admin container is being used in production.

Steps are grouped into tiers based on dependency ordering. Run all Tier 1 steps first (they are
independent), then Tier 2, then Tier 3.

---

## Step 1: Delete `core/admin/`

**Files to delete:**
- `core/admin/Dockerfile`
- `core/admin/entrypoint.sh`
- `core/admin/opencode/opencode.jsonc`
- `core/admin/README.md`

**Change type:** delete (4 files)

**Context:** The admin container image is replaced by the host binary. The `core/admin/`
directory is the Docker build context. After deletion, `docker build` of the admin image is no
longer possible.

**Pre-deletion checklist:**
```bash
# Confirm no other Dockerfile or compose file references core/admin/
grep -rn "core/admin" . --include="*.yml" --include="*.yaml" \
  --include="Dockerfile" --include="*.json" --include="*.sh" \
  --exclude-dir=".git" --exclude-dir="node_modules"
# Must return zero results before deleting
```

**Exact deletion:**
```bash
rm -rf core/admin/
```

**AKM assistance:** none

**Validation:**
```bash
ls core/
# core/admin/ must not appear
git status --short | grep "^D  core/admin"
# All 4 files should show as deleted
```

**Tier:** 1 (independent)

---

## Step 2: Delete admin addon compose files and update registry validation script

**Files to delete / modify:**
- `.openpalm/registry/addons/admin/compose.yml` (121 lines) — delete
- `.openpalm/registry/addons/admin/.env.schema` — delete
- `scripts/validate-registry.sh` (line 102) — modify: remove `admin_docker_net` from network allowlist regex

**Change type:** delete / modify

**Context:** The admin addon is no longer a compose-file addon. Removing it from the registry
prevents `openpalm addon install admin` from attempting to mount a non-existent image.
`validate-registry.sh` has a regex that whitelists `admin_docker_net` as a known compose
network; after deletion, that entry becomes a stale reference and will cause false positives.

**Pre-deletion checklist:**
```bash
# Confirm no registry catalog references this addon path
grep -rn "addons/admin" .openpalm/registry/ .openpalm/config/
# Confirm the env schema path
ls .openpalm/registry/addons/admin/
```

**Exact deletion:**
```bash
rm -rf .openpalm/registry/addons/admin/
```

**Exact change in `scripts/validate-registry.sh` — read line 102 first:**
```bash
grep -n "admin_docker_net\|allowlist\|network" scripts/validate-registry.sh | head -10
```
Remove `admin_docker_net` from the network name allowlist regex (exact edit depends on the line content read above).

**AKM assistance:** none

**Validation:**
```bash
bash scripts/validate-registry.sh
# Must pass without errors or "unknown network" warnings
grep -rn "admin_docker_net" scripts/
# Must return zero results
```

**Tier:** 1 (independent)

---

## Step 3: Delete `packages/admin-tools/` and remove from workspace

**Files to delete:**
- `packages/admin-tools/` (entire directory, 32 files)
  - Key file: `packages/admin-tools/src/lib.ts` line 1 reads `OP_ADMIN_API_URL`

**Files to modify:**
- `package.json` (repo root) — three removals:
  1. Remove `"packages/admin-tools"` from the `workspaces` array
  2. Remove `"admin-tools:test"` from the `scripts` block
  3. Remove `packages/admin-tools` from the composite test script

**Change type:** delete / modify

**Context:** `admin-tools` is the admin API tools plugin for the assistant. After the host
migration, the assistant calls admin API routes via loopback using the host gateway — the
`OP_ADMIN_API_URL` env var and all the wrapper functions in `lib.ts` become dead code.

**Pre-deletion checklist:**
```bash
# Confirm no package imports from admin-tools
grep -rn "@openpalm/admin-tools\|admin-tools" packages/ core/ \
  --include="*.ts" --include="*.json" --exclude-dir="node_modules" \
  --exclude-dir="packages/admin-tools"
# Must return zero results from outside packages/admin-tools before deleting
```

**Exact deletion:**
```bash
rm -rf packages/admin-tools/
```

**Exact changes to root `package.json`:**

1. Remove from `workspaces` array:
```json
// Remove this line:
"packages/admin-tools",
```

2. Remove from `scripts`:
```json
// Remove:
"admin-tools:test": "bun test --cwd packages/admin-tools",
```

3. Update the composite `test` script to remove the `admin-tools` invocation.

**After all edits:**
```bash
bun install
# Regenerate lockfile — REQUIRED after any package.json workspace change
bun install --frozen-lockfile
# Should succeed with no lockfile drift
```

**AKM assistance:** none

**Validation:**
```bash
ls packages/ | grep admin-tools
# Must return nothing
bun run check
# Must pass with 0 errors
```

**Tier:** 1 (independent)

---

## Step 4: Remove `selfRecreateAdmin` from all files

**Files to modify:**
- `packages/lib/src/control-plane/docker.ts` — delete lines 318–339 (the function; line 325 contains `"--profile", "admin"`)
- `packages/lib/src/index.ts` — delete line 210 (the `selfRecreateAdmin` export)
- `packages/admin/src/lib/server/docker.ts` — delete line 21 (import) and lines 109–116 (wrapper function)
- `packages/admin/src/lib/server/docker.vitest.ts` — delete lines 538–601 (the test block for `selfRecreateAdmin`)
- `packages/admin/src/routes/admin/upgrade/+server.ts` — delete line 20 (import) and line 71 (the call)

**Change type:** modify (5 files)

**Context:** `selfRecreateAdmin` is the mechanism by which the container admin restarts itself
during an upgrade. In host mode, the CLI handles upgrades directly. This function has no callers
after host mode becomes the default.

**Pre-deletion checklist:**
```bash
grep -rn "selfRecreateAdmin" packages/ core/ --include="*.ts"
# Should show only the 5 locations listed above. Confirm before editing.
```

**Exact changes — read each file location first, then remove the identified lines.**

In `packages/admin/src/routes/admin/upgrade/+server.ts`, the upgrade route still exists and
still handles upgrade logic — only the `selfRecreateAdmin` call is removed. Confirm the route
continues to function after removal:
```bash
# After edit:
cd packages/admin && npm run check
```

**AKM assistance:** none

**Validation:**
```bash
grep -rn "selfRecreateAdmin" packages/ core/
# Must return zero results

bun run admin:test:unit
# All tests pass (selfRecreateAdmin test block at vitest.ts:538-601 is gone)
```

**Tier:** 2 (after Tier 1 — depends on Step 3 completing first to avoid import errors from admin-tools)

---

## Step 5: Simplify `OptionalServiceName` and `OPTIONAL_SERVICES` and remove stale test assertions

**Files to modify:**
- `packages/lib/src/control-plane/types.ts` — lines 11 and 68–71
- `packages/admin/src/lib/server/lifecycle.vitest.ts` — line 198 (test assertion)
- `packages/admin/src/lib/server/registry.test.ts` — lines 323–329 (test block)

**Change type:** modify (3 files)

**Context:** `OptionalServiceName` currently includes `"admin"` as a valid optional service
because the admin container could be toggled on/off. After Phase 3, there is no admin container.
Removing `"admin"` from the type and set prevents any future code path from accidentally
starting the admin container. Stale test assertions that check for `"admin"` in the optional
services list must be removed or updated.

**Pre-deletion checklist:**
```bash
grep -n "OptionalServiceName\|OPTIONAL_SERVICES\|\"admin\"" \
  packages/lib/src/control-plane/types.ts
# Confirm "admin" is present in the type before removing it

grep -n "admin.*optional\|optional.*admin\|OPTIONAL_SERVICES" \
  packages/admin/src/lib/server/lifecycle.vitest.ts \
  packages/admin/src/lib/server/registry.test.ts
```

**Exact change in `types.ts`:**
- Remove `"admin"` from the `OptionalServiceName` union type (line 11)
- Remove `"admin"` from the `OPTIONAL_SERVICES` array (lines 68–71)

**AKM assistance:** none

**Validation:**
```bash
bun run admin:test:unit
# Must pass with 0 failures — stale "admin in optional services" assertions removed

grep -rn "\"admin\"" packages/lib/src/control-plane/types.ts
# Must return zero results
```

**Tier:** 2 (after Tier 1)

---

## Step 6: Remove `OP_ADMIN_API_URL` from core compose file and assistant README

**Files to modify:**
- `.openpalm/stack/core.compose.yml` — delete line 77 (`OP_ADMIN_API_URL: ${OP_ADMIN_API_URL:-}`)
- `core/assistant/README.md` — delete the `OP_ADMIN_API_URL` row (line 55)

**Change type:** modify (2 files)

**Context:** `OP_ADMIN_API_URL` was the env var that told the assistant container where the admin
API was running. In host mode, the assistant calls the admin API via loopback at a well-known
address configured at startup — no env var injection needed.

**Pre-deletion checklist:**
```bash
grep -rn "OP_ADMIN_API_URL" .openpalm/ core/ packages/ --include="*.yml" \
  --include="*.yaml" --include="*.md" --include="*.ts" --include="*.env*"
# Confirm only the two locations listed above remain before editing
```

**AKM assistance:** none

**Validation:**
```bash
grep -rn "OP_ADMIN_API_URL" .openpalm/ core/ packages/
# Must return zero results

# Stack still composes cleanly
docker compose -f .openpalm/stack/core.compose.yml config --quiet
# Must succeed (exit 0) — no undefined variable errors
```

**Tier:** 1 (independent)

---

## Step 7: Remove `OPENPALM_ADMIN_MODE` feature flag everywhere

**Context:** Once Phase 3 is complete, there is only one admin mode (host). The feature flag is
deleted from all env schemas, compose files, and documentation.

**Discovery — run this before editing anything:**
```bash
grep -rn "OPENPALM_ADMIN_MODE" packages/ core/ scripts/ .openpalm/ docs/ \
  --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.md" \
  --include="*.env" --include="*.json" --include="*.sh"
```

**Files to modify (after discovery confirms locations):**
- All env schemas that declare `OPENPALM_ADMIN_MODE` as a key
- All compose files that pass `OPENPALM_ADMIN_MODE` as an env var
- `packages/lib/src/control-plane/types.ts` — delete `AdminMode` type and `resolveAdminMode()` function
- `packages/lib/src/index.ts` — remove `AdminMode` and `resolveAdminMode` from barrel export
- `packages/cli/src/commands/admin.ts` — remove the `resolveAdminMode()` check in `serveCmd`
- `packages/cli/src/commands/install.ts` — remove `--admin-mode` flag and `adminMode` option
- `docs/technical/core-principles.md` — remove the `OPENPALM_ADMIN_MODE` subsection added in Phase 1a Step 18

**Change type:** modify (multiple files — exact count determined by grep output above)

**AKM assistance:** none

**Validation:**
```bash
grep -rn "OPENPALM_ADMIN_MODE" packages/ core/ scripts/ .openpalm/ docs/
# Must return zero results

bun run check
# Must pass with 0 errors (AdminMode type references gone)
```

**Tier:** 2 (after Tiers 1 and steps 4/5 complete — depends on admin-tools and selfRecreateAdmin being gone)

---

## Step 8: Clean SSRF blocklist in `packages/admin/src/lib/server/helpers.ts`

**File:** `packages/admin/src/lib/server/helpers.ts` (lines 139–144)

**Change type:** modify

**Context:** The `DOCKER_SERVICE_NAMES` Set is used to block SSRF attacks (requests from the
admin API forwarding to other containers by service name). After Phase 3, `"admin"` and
`"docker-socket-proxy"` are no longer running containers and cannot be legitimate SSRF targets.
Keeping them in the blocklist is harmless but adds stale entries that could confuse future readers.

**Pre-deletion checklist:**
```bash
grep -n "DOCKER_SERVICE_NAMES\|admin\|docker-socket-proxy" \
  packages/admin/src/lib/server/helpers.ts | head -20
# Confirm the Set is at lines 139-144 and contains "admin" and "docker-socket-proxy"
```

**Exact change — remove `"admin"` and `"docker-socket-proxy"` from the Set:**

Before:
```typescript
const DOCKER_SERVICE_NAMES = new Set([
  "admin",
  "docker-socket-proxy",
  "assistant",
  "guardian",
  // ... other services
]);
```

After: remove only `"admin"` and `"docker-socket-proxy"` entries.

**AKM assistance:** none

**Validation:**
```bash
bun run admin:test:unit
# SSRF tests must still pass — "assistant" and "guardian" remain blocked
grep -n "\"admin\"\|\"docker-socket-proxy\"" packages/admin/src/lib/server/helpers.ts
# Must return zero results in the SSRF blocklist context
```

**Tier:** 2 (after Tier 1)

---

## Step 9: Delete `docs/technical/docker-dependency-resolution.md` and remove references

**Files to delete / modify:**
- `docs/technical/docker-dependency-resolution.md` — delete
- `CLAUDE.md` — remove the "Key Files" row referencing `docker-dependency-resolution.md`
- `docs/technical/core-principles.md` — remove reference link at line 229

**Change type:** delete / modify (3 files)

**Context:** `docker-dependency-resolution.md` documents the npm/Bun dependency resolution
pattern for the admin Docker image. After Phase 3, there is no admin Docker image. The document
becomes misleading. References to it in `CLAUDE.md` and `core-principles.md` must also be removed.

**Pre-deletion checklist:**
```bash
grep -rn "docker-dependency-resolution" . --include="*.md" --exclude-dir=".git"
# Should show only CLAUDE.md and core-principles.md as references
```

**AKM assistance:** none

**Validation:**
```bash
grep -rn "docker-dependency-resolution" . --include="*.md" --exclude-dir=".git"
# Must return zero results
ls docs/technical/docker-dependency-resolution.md
# Must not exist (ls returns error)
```

**Tier:** 3 (after Tier 2 — docs cleanup goes last)

---

## Step 10: Update `docs/technical/core-principles.md`

**File:** `docs/technical/core-principles.md`

**Change type:** modify

**Context:** The core-principles doc is the authoritative architectural source. It must reflect
the post-Phase 3 reality: admin is a host process, not a container. Two targeted changes:

1. **Rewrite invariant #1 (line 58):** Change from "Admin UI is served by the Docker container"
   to "Admin is a host process managed by the CLI binary. No admin container exists."

2. **Add new invariant #6:** "Admin is host-only. Containers cannot reach admin under any
   configuration. Admin binds to 127.0.0.1 only and is never exposed to the Docker bridge
   network."

3. **Remove Docker build dependency contract section (lines 228–249):** This section documented
   the npm/Bun dependency pattern for the admin Docker image. After Phase 3 it is stale.
   The link to `docker-dependency-resolution.md` (deleted in Step 9) must also be removed.

**Pre-edit verification:**
```bash
grep -n "## \|invariant\|Admin.*container\|docker-dependency" \
  docs/technical/core-principles.md | head -30
# Confirm line numbers and section headings before editing
```

**AKM assistance:** none

**Validation:**
```bash
grep -n "admin.*container\|container.*admin" docs/technical/core-principles.md
# Must return zero results for the old framing
grep -n "host-only\|127.0.0.1" docs/technical/core-principles.md
# Must show the new invariant #6
```

**Tier:** 3 (after Tier 2)

---

## Step 11: Update `docs/technical/foundations.md`

**File:** `docs/technical/foundations.md`

**Change type:** modify

**Context:** `foundations.md` documents the system architecture. After Phase 3, three changes are
required:

1. **Line 45 (Docker socket):** Remove the sentence that describes the admin container as the
   component that accesses the Docker socket. The host CLI binary now accesses Docker directly;
   the `docker-socket-proxy` container is gone.

2. **Remove `admin_docker_net` network row (line 59):** This network is used to connect the
   admin container to the docker-socket-proxy. After Phase 3 neither exists.

3. **Delete Admin Addon section (lines 242–298):** This section describes the admin addon's
   compose file, port mapping, and lifecycle. Entirely obsolete after Phase 3.

4. **Add two new sections** after the deletion:
   - "Admin (host process)": Describes that admin is a Bun.serve server started by the CLI,
     binds to 127.0.0.1, and embeds the SvelteKit UI as a pre-built tarball.
   - "UI-first principle": The admin UI is the primary operator interface; CLI commands are
     the fallback for scripted workflows and headless environments.

**Pre-edit verification:**
```bash
grep -n "## \|admin_docker_net\|Docker socket\|Admin Addon\|admin.*container" \
  docs/technical/foundations.md | head -30
# Confirm exact line numbers before editing
```

**AKM assistance:** none

**Validation:**
```bash
grep -n "admin_docker_net\|docker-socket-proxy" docs/technical/foundations.md
# Must return zero results
grep -n "host process\|UI-first" docs/technical/foundations.md
# Must show the two new sections
```

**Tier:** 3 (after Tier 2)

---

## Step 12: Update remaining documentation files

**Files to modify:**
- `docs/technical/environment-and-mounts.md` — remove admin container env var rows and volume mount rows
- `docs/technical/opencode-configuration.md` — remove any reference to `OP_ADMIN_API_URL` or admin container OpenCode config
- `core/assistant/README.md` — update the architecture diagram and service table (admin row becomes "Admin (host binary)")
- `packages/cli/README.md` — add `openpalm admin serve` usage, update service list
- `docs/system-requirements.md` — remove Docker requirement for admin (admin is now a host binary; Docker still required for assistant, guardian, channels)
- `.openpalm/stack/README.md` — remove admin addon section and `admin_docker_net` references
- `AGENTS.md` — update any reference to the admin container or `OP_ADMIN_API_URL`
- `CLAUDE.md` — update "Key Files" table (remove `core/admin/`, `packages/admin-tools/`, `docker-dependency-resolution.md` rows)

**Change type:** modify (8 files)

**Context:** Each document contains stale references to the container admin model. After Phase 3,
any mention of `core/admin/`, `packages/admin-tools/`, `OP_ADMIN_API_URL`, `admin_docker_net`,
or `docker-socket-proxy` in documentation is either wrong or misleading.

**Discovery — run before editing:**
```bash
grep -rn "core/admin\|admin-tools\|OP_ADMIN_API_URL\|admin_docker_net\|docker-socket-proxy" \
  docs/ AGENTS.md CLAUDE.md core/assistant/README.md packages/cli/README.md \
  .openpalm/stack/README.md --include="*.md"
# Review each match and determine whether it needs rewrite or deletion
```

**AKM assistance:** none

**Validation:**
```bash
grep -rn "core/admin\|admin-tools\|OP_ADMIN_API_URL\|admin_docker_net\|docker-socket-proxy" \
  docs/ AGENTS.md CLAUDE.md core/assistant/README.md packages/cli/README.md \
  .openpalm/stack/README.md
# Must return zero results
```

**Tier:** 3 (after Tier 2)

---

## Step 13: Update test scripts to remove admin and docker-socket-proxy from health check lists

**Files to modify:**
- `scripts/dev-e2e-test.sh` — line 316 (remove `admin` and `docker-socket-proxy` from service health check list)
- `scripts/release-e2e-test.sh` — line 483 (same)
- `scripts/upgrade-test.sh` — lines 171, 323, 366, 484, 557, 618 (all occurrences of admin/docker-socket-proxy in health check arrays)

**Change type:** modify (3 files)

**Context:** These scripts assert that specific container names appear in `docker ps` output as
part of stack health validation. After Phase 3, `admin` and `docker-socket-proxy` containers do
not exist. Their presence in the check list will cause false failures.

**Pre-edit verification:**
```bash
grep -n "admin\|docker-socket-proxy" \
  scripts/dev-e2e-test.sh \
  scripts/release-e2e-test.sh \
  scripts/upgrade-test.sh
# Confirm all line numbers listed above match the actual content
```

**AKM assistance:** none

**Validation:**
```bash
bash -n scripts/dev-e2e-test.sh
bash -n scripts/release-e2e-test.sh
bash -n scripts/upgrade-test.sh
# All must pass syntax check (exit 0)

grep -n "admin\|docker-socket-proxy" \
  scripts/dev-e2e-test.sh scripts/release-e2e-test.sh scripts/upgrade-test.sh
# Must return zero results in the service health check context
# (other references to "admin" in test scripts — e.g. admin API URL — are acceptable)
```

**Tier:** 2 (after Tier 1 — test scripts should be updated before running post-Phase-3 CI)

---

## Final Validation Suite

After all Phase 3 steps are complete, run this script from the repo root. It fails if any
deleted concept remains anywhere in the codebase.

```bash
#!/usr/bin/env bash
set -euo pipefail

FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  local result
  result=$(grep -rn "$pattern" packages/ core/ scripts/ .openpalm/ docs/ CLAUDE.md AGENTS.md \
    --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.md" \
    --include="*.json" --include="*.sh" --include="*.env" \
    --exclude-dir=".git" --exclude-dir="node_modules" --exclude-dir=".plans" \
    2>/dev/null || true)
  if [[ -n "$result" ]]; then
    echo "FAIL [$label]:"
    echo "$result"
    FAIL=1
  else
    echo "PASS [$label]"
  fi
}

check "OP_ADMIN_API_URL"          "OP_ADMIN_API_URL"
check "admin_docker_net"          "admin_docker_net"
check "docker-socket-proxy"       "docker-socket-proxy"
check "x-admin-token"             "x-admin-token"
check "OP_ADMIN_TOKEN"            "OP_ADMIN_TOKEN"
check "selfRecreateAdmin"         "selfRecreateAdmin"
check "OPENPALM_ADMIN_MODE"       "OPENPALM_ADMIN_MODE"
check "profiles.*admin"           "profiles.*admin"
check "packages/admin-tools"      "packages/admin-tools"
check "core/admin/Dockerfile"     "core/admin/Dockerfile"

if [[ $FAIL -ne 0 ]]; then
  echo ""
  echo "PHASE 3 VALIDATION FAILED: stale references remain in the codebase."
  exit 1
fi

echo ""
echo "All Phase 3 validation checks passed."
```

Save to `scripts/validate-phase3-complete.sh` and run:
```bash
chmod +x scripts/validate-phase3-complete.sh
./scripts/validate-phase3-complete.sh
```

---

## Step Prerequisite Ordering

```
Tier 1 (run in parallel — no interdependencies):
  Step 1   — Delete core/admin/
  Step 2   — Delete admin addon compose files + update validate-registry.sh
  Step 3   — Delete packages/admin-tools/ + remove from workspace + bun install
  Step 6   — Remove OP_ADMIN_API_URL from core compose file + assistant README

Tier 2 (after all Tier 1 steps complete):
  Step 4   — Remove selfRecreateAdmin (depends on Step 3: admin-tools gone avoids import chase)
  Step 5   — Simplify OptionalServiceName / OPTIONAL_SERVICES (depends on Step 3: no admin addon)
  Step 7   — Remove OPENPALM_ADMIN_MODE feature flag (depends on Steps 4+5: all call sites gone)
  Step 8   — Clean SSRF blocklist in helpers.ts (depends on Step 3: admin-tools not importing helpers)
  Step 13  — Update test scripts health check lists (update CI scripts before running post-Phase-3 CI)

Tier 3 (after all Tier 2 steps complete — docs go last):
  Step 9   — Delete docker-dependency-resolution.md + remove references
  Step 10  — Update core-principles.md
  Step 11  — Update foundations.md
  Step 12  — Update remaining docs (environment-and-mounts, opencode-configuration,
             assistant README, cli README, system-requirements, stack README, AGENTS.md, CLAUDE.md)

Final: Run validate-phase3-complete.sh after all Tier 3 steps.
```
