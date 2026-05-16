# Phase 2: Host-Admin Migration Implementation Plan

**Goal:** Migrate 52 SvelteKit `+server.ts` API routes to `Bun.serve` handlers, default to
`OPENPALM_ADMIN_MODE=host`, push `appendAudit()` into `@openpalm/lib` mutating functions,
complete auth cookie migration (drop `x-admin-token` entirely), consolidate Docker handling
in lib, and handle vault/filesystem cleanup.

**Repo root:** `/home/founder3/code/github/itlackey/openpalm`

**Parallel workstreams:** A, B, C, D, E, F can all start on day 1 and merge independently.
Workstream C (route migration) depends on Workstream B (auth) being merged first.

---

## Workstream A: Push `appendAudit` into `@openpalm/lib` mutating functions

### Background

`appendAudit` signature (audit.ts, lines 9–16):
```ts
appendAudit(state, actor, action, args, ok, requestId, callerType)
```

Currently every route calls `appendAudit` directly after calling a lib function.
The goal is to move the audit call _into_ the lib mutating functions themselves so routes
do not have to carry the audit ceremony. Routes that currently double-call (error path + success
path) will be simplified to zero calls.

### ✅ Step A-1: Define `AuditContext` type in lib types (Workstream A)

**File:** `packages/lib/src/control-plane/types.ts`
**Change type:** modify

**Context:** Lib currently has no concept of "who called this." Every lib mutating function
needs a way to receive actor/requestId/callerType without changing every call site to a 7-arg
signature. An `AuditContext` value-object threads through cleanly.

**Exact change:** Add to the existing type exports block:
```ts
export type AuditContext = {
  actor: string;
  requestId?: string;
  callerType?: CallerType;
};
```

**AKM assistance:** `akm search audit context type`

**Validation:** `bun run check` passes. No downstream breakage — this is additive.

---

### ✅ Step A-2: Add optional `ctx` parameter to lib mutating functions (Workstream A)

**Files:** All lib functions that currently trigger an `appendAudit` callsite in routes.
Identified by cross-referencing the 52 routes' `appendAudit` calls with the lib functions they call:

| Route action key | Lib function |
|---|---|
| `install` | `applyInstall` in `lifecycle.ts` |
| `update` | `applyUpdate` in `lifecycle.ts` |
| `uninstall` | `applyUninstall` in `lifecycle.ts` |
| `upgrade` | (compose operations in routes) |
| `capabilities.save` | `writeStackSpec`, `writeCapabilityVars`, `patchSecretsEnvFile` |
| `secrets.write` / `secrets.remove` | `backend.write`, `backend.remove` (via `detectSecretBackend`) |
| `addons.post` | `setAddonEnabled` (lib) |
| `automations.catalog.install` / `uninstall` | `installAutomation`, `uninstallAutomation` (lib) |
| `containers.*` | `composeUp`, `composeDown`, `composeRestart`, `composeStart` (lib) |

**Change type:** modify (each lib function)

**Context:** The audit call is a side-effect that belongs at the boundary of a state mutation.
Adding an optional `ctx?: AuditContext` parameter to each function keeps call sites that don't
need auditing (CLI, tests) unchanged. When `ctx` is present, the function calls `appendAudit`
itself at completion or on error.

**Pattern for each function — example with `applyInstall`:**
```ts
// Before:
export async function applyInstall(state: ControlPlaneState): Promise<void> { ... }

// After:
export async function applyInstall(
  state: ControlPlaneState,
  ctx?: AuditContext
): Promise<void> {
  try {
    // ... existing body ...
    if (ctx) appendAudit(state, ctx.actor, "install", { ... }, true, ctx.requestId, ctx.callerType);
  } catch (err) {
    if (ctx) appendAudit(state, ctx.actor, "install", { error: String(err) }, false, ctx.requestId, ctx.callerType);
    throw;
  }
}
```

**Functions to update (in `packages/lib/src/control-plane/lifecycle.ts`):**
- `applyInstall` — routes/admin/install/+server.ts line 63
- `applyUpdate` — routes/admin/update/+server.ts line 41
- `applyUninstall` — routes/admin/uninstall/+server.ts line 36

**AKM assistance:** `akm search lib lifecycle audit`

**Validation:** `bun run guardian:test && bun run cli:test` both pass (no behavior change for
callers that omit `ctx`). Route tests pass with ctx-bearing calls.

---

### ✅ Step A-3: Remove `appendAudit` callsites from routes that now get audit from lib (Workstream A)

**Files:** Routes whose lib call now handles audit internally (install, update, uninstall,
and any others updated in A-2).

**Change type:** modify

**Context:** After A-2, the route just passes `ctx` and removes its own `appendAudit` imports
and calls. Routes that have both success-path and error-path audit calls can collapse to zero
inline calls.

**Example diff for `packages/admin/src/routes/admin/install/+server.ts`:**
```ts
// Remove:
import { ..., appendAudit, ... } from "@openpalm/lib";
// Remove:
const actor = getActor(event);
const callerType = getCallerType(event);
// Remove the entire appendAudit(...) block at lines 63-75

// Add ctx to lib call:
await applyInstall(state, { actor: getActor(event), requestId, callerType: getCallerType(event) });
```

**Routes affected (appendAudit callsites to remove after lib changes absorb them):**
- `routes/admin/install/+server.ts` (1 callsite, line 63)
- `routes/admin/update/+server.ts` (1 callsite, line 41)
- `routes/admin/uninstall/+server.ts` (1 callsite, line 36)

Routes with appendAudit calls to **inline lib functions** (write/remove/composeUp etc.) must
keep their own calls because those low-level lib functions do not own "action semantics" — the
route owns the action name. Do not push audit into `patchSecretsEnvFile` or `composeUp`.

**AKM assistance:** `akm search remove appendAudit routes`

**Validation:** `bun run admin:test:unit` passes with same audit entry counts as before.

---

## Workstream B: Migrate auth from `x-admin-token` header to cookie

### Background

Current auth flow:
1. User types token into `AuthGate` input in `+page.svelte`.
2. `storeToken()` writes it to `localStorage` (`openpalm.adminToken`).
3. Every API call in `api.ts` reads `getAdminToken()` and sets `x-admin-token` header.
4. `requireAdmin` / `requireAuth` in `helpers.ts` reads `x-admin-token` from request.

Target flow:
1. User types token into `AuthGate` input.
2. POST `/admin/auth/login` — server sets `HttpOnly; SameSite=Strict; Secure` cookie `op_session`.
3. All subsequent requests include cookie automatically.
4. `requireAdmin` / `requireAuth` read cookie from request.
5. `getAdminToken()`, `storeToken()`, `clearToken()` are deleted.

**IMPORTANT CONSTRAINT:** The assistant calls admin routes using `x-admin-token` (bearer token
pattern). During Phase 2 the server must accept EITHER the cookie OR `x-admin-token` so the
assistant still works. The `x-admin-token` header path is removed entirely in Phase 3 once the
assistant is updated to use a service token via a different mechanism.

---

### ✅ Step B-1: Add `/admin/auth/login` and `/admin/auth/logout` server routes (Workstream B)

**File:** `packages/admin/src/routes/admin/auth/login/+server.ts` (create)
**File:** `packages/admin/src/routes/admin/auth/logout/+server.ts` (create)
**Change type:** create

**Context:** These are the new session endpoints. Login validates the token (using existing
`safeTokenCompare`), sets the cookie if valid. Logout clears it. No token in response body.

**login/+server.ts content:**
```ts
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { safeTokenCompare, getRequestId, jsonResponse, errorResponse } from "$lib/server/helpers.js";
import { parseJsonBody, jsonBodyError } from "$lib/server/helpers.js";

const COOKIE_NAME = "op_session";
const COOKIE_OPTS = "HttpOnly; SameSite=Strict; Path=/; Max-Age=86400";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const result = await parseJsonBody(event.request);
  if ("error" in result) return jsonBodyError(result, requestId);
  const token = typeof result.data.token === "string" ? result.data.token : "";
  if (!token) return errorResponse(400, "bad_request", "token is required", {}, requestId);

  const state = getState();
  const isAdmin = state.adminToken && safeTokenCompare(token, state.adminToken);
  const isAssistant = state.assistantToken && safeTokenCompare(token, state.assistantToken);
  if (!isAdmin && !isAssistant) {
    return errorResponse(401, "unauthorized", "Invalid token", {}, requestId);
  }
  const role = isAdmin ? "admin" : "assistant";
  return new Response(JSON.stringify({ ok: true, role }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=${token}; ${COOKIE_OPTS}`,
      "x-request-id": requestId
    }
  });
};
```

**logout/+server.ts content:**
```ts
import type { RequestHandler } from "./$types";
import { getRequestId, jsonResponse } from "$lib/server/helpers.js";

const COOKIE_NAME = "op_session";

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      "x-request-id": requestId
    }
  });
};
```

**AKM assistance:** `akm search cookie auth sveltekit httponly`

**Validation:** `curl -X POST localhost:8100/admin/auth/login -d '{"token":"dev-admin-token"}' -i`
shows `Set-Cookie: op_session=dev-admin-token; HttpOnly; ...`. Invalid token returns 401.

---

### ✅ Step B-2: Update `requireAdmin` and `requireAuth` in helpers.ts to accept cookie OR header (Workstream B)

**File:** `packages/admin/src/lib/server/helpers.ts` (lines 76–120)
**Change type:** modify

**Context:** During the transition, both sources must be accepted. The header is still used by
the assistant. The cookie is used by the browser UI. The extraction logic needs to try both.
This is the only place the dual-source logic lives.

**Exact change — replace `requireAdmin` (lines 76–91):**
```ts
/** Extract raw token from cookie (browser) or x-admin-token header (assistant). */
function extractToken(event: RequestEvent): string {
  // Cookie takes precedence (browser UI after B-4 lands)
  const cookieHeader = event.request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)op_session=([^;]+)/);
  if (match) return match[1];
  // Fallback: x-admin-token header (assistant, legacy)
  return event.request.headers.get("x-admin-token") ?? "";
}

export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  const notConfigured = requireNonEmptyAdminToken(state, requestId);
  if (notConfigured) return notConfigured;
  const token = extractToken(event);
  if (!safeTokenCompare(token, state.adminToken)) {
    return errorResponse(401, "unauthorized", "Missing or invalid credentials", {}, requestId);
  }
  return null;
}
```

**Update `identifyCallerByToken` (lines 94–100)** to use `extractToken` instead of
reading `x-admin-token` directly:
```ts
export function identifyCallerByToken(event: RequestEvent): "admin" | "assistant" | null {
  const state = getState();
  const token = extractToken(event);
  if (state.adminToken && safeTokenCompare(token, state.adminToken)) return "admin";
  if (state.assistantToken && safeTokenCompare(token, state.assistantToken)) return "assistant";
  return null;
}
```

**AKM assistance:** `akm search cookie extraction helper`

**Validation:** `bun run admin:test:unit` — all `requireAdmin` / `requireAuth` / `getActor`
tests still pass. Helper tests use `x-admin-token` header — they continue to pass because the
header fallback path is still present.

---

### ✅ Step B-3: Delete `packages/admin/src/lib/auth.ts` (Workstream B)

**File:** `packages/admin/src/lib/auth.ts`
**Change type:** delete

**Context:** `getAdminToken`, `storeToken`, `clearToken`, `validateToken` are localStorage-based.
After B-4 the UI no longer needs them. The file is 38 lines.

**Pre-deletion checklist:** Confirm zero remaining imports via:
```bash
grep -rn "from.*auth.js\|from.*auth'" packages/admin/src --include="*.ts" --include="*.svelte"
```
This must return zero results before deleting.

**AKM assistance:** none needed — straightforward deletion.

**Validation:** `bun run admin:check` passes with no "cannot find module" errors.

---

### ✅ Step B-4: Update `packages/admin/src/lib/api.ts` — remove token parameter (Workstream B)

**File:** `packages/admin/src/lib/api.ts`
**Change type:** modify

**Context:** Every function in `api.ts` currently takes `token: string` as first parameter
and passes it to `buildHeaders()` which sets `x-admin-token`. After this step, cookies are
sent automatically by the browser, so `token` is removed from all function signatures.
`buildHeaders()` loses the token branch. The `requireOk` 401 handler throws a
`{ status: 401 }` error — callers already catch this to trigger re-auth; after Phase 2
the re-auth flow redirects to login modal instead.

**Before (lines 10–34):**
```ts
export function buildHeaders(token?: string): HeadersInit {
  const headers: HeadersInit = { 'x-request-id': crypto.randomUUID() };
  if (token) {
    headers['x-admin-token'] = token;
    headers['x-requested-by'] = 'ui';
  }
  return headers;
}

async function request(method, path, token?, body?): Promise<Response> { ... }
```

**After:**
```ts
export function buildHeaders(): HeadersInit {
  return {
    'x-request-id': crypto.randomUUID(),
    'x-requested-by': 'ui'
  };
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: HeadersInit = {
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...buildHeaders()
  };
  return fetch(`${apiBase}${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}
```

**All exported functions — remove `token: string` as first parameter:**

| Function | Line (approx) | Change |
|---|---|---|
| `fetchAdminOpenCodeStatus` | 95 | remove `token` param |
| `fetchContainers` | 104 | remove `token` param |
| `containerAction` | 109 | remove `token` param |
| `fetchArtifacts` | 124 | remove `token` param |
| `applyChanges` | 131 | remove `token` param |
| `upgradeStack` | 144 | remove `token` param |
| `fetchAutomations` | 151 | remove `token` param |
| `fetchAutomationCatalog` | 158 | remove `token` param |
| `installAutomation` | 165 | remove `token` param |
| `uninstallAutomation` | 175 | remove `token` param |
| `fetchServiceLogs` | 187 | remove `token` param |
| `fetchCapabilityStatus` | 202 | remove `token` param |
| `fetchAddons` | 212 | remove `token` param |
| `toggleAddon` | 218 | remove `token` param |
| `fetchAuditLog` | 232 | remove `token` param |
| `fetchSecrets` | 248 | remove `token` param |
| `writeSecret` | 259 | remove `token` param |
| `deleteSecret` | 269 | remove `token` param |
| `generateSecret` | 278 | remove `token` param |
| `fetchAssignments` | 289 | remove `token` param |
| `saveAssignments` | 297 | remove `token` param |
| `pullImages` | 306 | remove `token` param |
| `detectLocalProviders` | 312 | remove `token` param |

Add `credentials: 'include'` to the `fetch()` call so cookies are sent on same-origin requests.

**AKM assistance:** `akm search remove token api client`

**Validation:** `bun run admin:check` — zero type errors. All Svelte component calls to api.ts
functions compile without the removed parameter.

---

### ✅ Step B-5: Update `+page.svelte` — remove token threading (Workstream B)

**File:** `packages/admin/src/routes/+page.svelte`
**Change type:** modify

**Context:** `+page.svelte` currently reads `getAdminToken()` before every data load and passes
the token to api.ts functions. After B-3 and B-4, there is no token to thread. Auth state becomes
a server-side cookie. The UI auth flow changes: instead of storing token in localStorage, POST to
`/admin/auth/login`; on 401 from any API call, show the login modal.

**Key changes (search for `getAdminToken()` — appears at lines 162, 175, 212, and throughout):**
1. Remove `import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js'`
2. `handleAuthSuccess(token)`: replace `validateToken(token)` + `storeToken(token)` with:
   ```ts
   const loginRes = await fetch('/admin/auth/login', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ token }),
     credentials: 'include'
   });
   if (!loginRes.ok) { applyInvalidTokenState(); return false; }
   ```
3. `handleLogout()`: replace `clearToken()` with:
   ```ts
   await fetch('/admin/auth/logout', { method: 'POST', credentials: 'include' });
   ```
4. Remove all `const token = getAdminToken()` lines inside data-load functions.
5. Remove all `if (!token) { authLocked = true; ... return; }` guards (cookie is checked server-side).
6. Remove `token` arguments from all api.ts function calls.
7. `applyInvalidTokenState()`: remove `clearToken()`.

**All Svelte component files that also accept and pass `token` prop** (grep for `bind:token` or
`token={` in page.svelte and component files):
```bash
grep -rn "token=" packages/admin/src/lib/components --include="*.svelte"
```
Each must be updated to remove the prop.

**AKM assistance:** `akm search svelte cookie auth no token prop`

**Validation:** Manual browser test: login, navigate tabs, reload — token persists via cookie.
`bun run admin:test:unit` passes. Playwright mocked tests pass.

---

### ✅ Step B-6: Update 45 vitest test files — replace `x-admin-token` with cookie header (Workstream B)

**Files:** All `*.vitest.ts` files in `packages/admin/src/routes/` that inject `x-admin-token`.
(45 vitest files total; 17 route vitest files contain `x-admin-token` — listed in grep output above.)

**Change type:** modify (each affected file)

**Context:** Route tests create fake `RequestEvent` objects with `x-admin-token`. After B-2,
both paths work. But to test the primary cookie path, tests should switch to `cookie: "op_session=..."`.
To avoid breaking the `x-admin-token` fallback path (still needed for assistant), keep a few
tests using the header; convert the majority to cookie.

**Pattern — for each `makeEvent` / `makeRequest` helper in a route vitest file:**
```ts
// Before:
{ 'x-admin-token': token }

// After:
{ 'cookie': `op_session=${token}` }
```

**Files to update (17 route vitest files confirmed by grep):**
1. `routes/admin/addons/server.vitest.ts` (lines 20, 32)
2. `routes/admin/addons/[name]/server.vitest.ts` (lines 21, 34)
3. `routes/admin/automations/catalog/server.vitest.ts` (lines 24, 36, 50, 64)
4. `routes/admin/automations/[name]/log/server.vitest.ts` (line 26)
5. `routes/admin/automations/[name]/run/server.vitest.ts` (line 32)
6. `routes/admin/capabilities/assignments/server.vitest.ts` (line 35)
7. `routes/admin/capabilities/status/server.vitest.ts` (line 27)
8. `routes/admin/capabilities/test/server.vitest.ts` (line 18)
9. `routes/admin/config/validate/server.vitest.ts` (line 56)
10. `routes/admin/opencode/model/server.vitest.ts` — check for `x-admin-token` pattern
11. `routes/admin/opencode/providers/server.vitest.ts` (line 33)
12. `routes/admin/opencode/providers/[id]/auth/server.vitest.ts` (line 55)
13. `routes/admin/opencode/providers/[id]/models/server.vitest.ts` (line 33)
14. `routes/admin/providers/custom/server.vitest.ts` (lines 36, 65)
15. `routes/admin/providers/model/server.vitest.ts` (lines 36, 63)
16. `routes/admin/providers/oauth/finish/server.vitest.ts` (lines 39, 66)
17. `routes/admin/providers/oauth/start/server.vitest.ts` (lines 44, 71)
18. `routes/admin/providers/save/server.vitest.ts` (lines 38, 65)
19. `routes/admin/providers/toggle/server.vitest.ts` (lines 37, 64)
20. `routes/admin/secrets/server.vitest.ts` (line 24)
21. `routes/admin/secrets/user-vault/server.vitest.ts` (line 61)

Also update `packages/admin/src/lib/server/helpers.vitest.ts` (lines 137, 143, 152, 158, 165,
188, 193, 199, 221, 228, 234) — these test `requireAdmin` / `getActor` directly with the header.
Keep at least one test per function using the header (to test the fallback path). Add parallel
tests using the cookie path to confirm it also works.

**AKM assistance:** `akm search test helper cookie auth vitest`

**Validation:** `bun run admin:test:unit` — all 592 previously-passing tests still pass. Count
should stay the same or increase if new cookie-path tests are added.

---

## Workstream C: Migrate 52 `+server.ts` routes to `Bun.serve` handlers

### Background

The goal is to replace the SvelteKit adapter-node server with a standalone `Bun.serve` server.
Each `+server.ts` becomes a plain function (or module) exporting handlers by HTTP method.
The SvelteKit routing is replaced by a simple path-matching router in the new entry point.

**IMPORTANT:** This workstream requires Workstream B to be merged first because the new auth
helpers reference cookies, not headers, as the primary path.

### Route inventory (52 routes)

**Group 1: Unauthenticated / health (2 routes)**
- `routes/health/+server.ts` — GET — no auth
- `routes/guardian/health/+server.ts` — GET — no auth

**Group 2: requireAuth read-only (13 routes)**
- `routes/admin/audit/+server.ts` — GET
- `routes/admin/artifacts/+server.ts` — GET
- `routes/admin/artifacts/manifest/+server.ts` — GET
- `routes/admin/artifacts/[name]/+server.ts` — GET
- `routes/admin/automations/+server.ts` — GET
- `routes/admin/automations/catalog/+server.ts` — GET
- `routes/admin/automations/[name]/log/+server.ts` — GET
- `routes/admin/automations/[name]/run/+server.ts` — POST (requireAuth, not requireAdmin)
- `routes/admin/config/validate/+server.ts` — POST
- `routes/admin/containers/events/+server.ts` — GET
- `routes/admin/containers/list/+server.ts` — GET
- `routes/admin/containers/stats/+server.ts` — GET
- `routes/admin/installed/+server.ts` — GET
- `routes/admin/logs/+server.ts` — GET
- `routes/admin/network/check/+server.ts` — GET

**Group 3: requireAdmin mutations (37 routes)**
All remaining routes under `routes/admin/`.

**Group 4: OpenCode proxy (thin routes, no state)**
- `routes/admin/opencode/*` — proxy calls to OpenCode client
- `routes/admin/providers/*` — delegate to `loadProviderPage`, `withAdminBody` wrappers

---

### ✅ Step C-1: Create `packages/admin/src/server/router.ts` — path router (Workstream C)

**File:** `packages/admin/src/server/router.ts` (create)
**Change type:** create

**Context:** SvelteKit handles routing. The new `Bun.serve` server needs a lightweight router.
Do not add a routing library dependency. A plain `Map<string, Map<string, Handler>>` is sufficient
for 52 static routes plus a few parameterized ones (`[name]`, `[id]`, `[providerId]`).

**Content:**
```ts
type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

type Route = {
  pattern: RegExp;
  paramNames: string[];
  methods: Record<string, Handler>;
};

const routes: Route[] = [];

export function addRoute(
  path: string,
  methods: Record<string, Handler>
): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/\[([^\]]+)\]/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({ pattern: new RegExp(`^${pattern}$`), paramNames, methods });
}

export function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
    const handler = route.methods[method];
    if (!handler) {
      return Promise.resolve(new Response("Method Not Allowed", { status: 405 }));
    }
    return handler(req, params);
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}
```

**AKM assistance:** `akm search bun serve router pattern`

**Validation:** Unit test: register `/admin/containers/[name]/run`, dispatch
`POST /admin/containers/foo/run` — params `{ name: "foo" }` received.

---

### ✅ Step C-2: Create `packages/admin/src/server/entry.ts` — `Bun.serve` entry point (Workstream C)

**File:** `packages/admin/src/server/entry.ts` (create)
**Change type:** create

**Context:** This replaces SvelteKit's node adapter entry. It registers all route handlers via
`addRoute` and calls `Bun.serve`. Static file serving (SvelteKit build output) is handled
separately via `Bun.file` for GET requests that hit no API route.

**Content:**
```ts
import { dispatch } from "./router.js";
// Route registrations (one import per route group)
import "./routes/health.js";
import "./routes/admin/index.js";
// ... all groups

const port = Number(process.env.PORT ?? 8100);

Bun.serve({
  port,
  async fetch(req) {
    // API routes
    const url = new URL(req.url);
    if (url.pathname.startsWith("/health") ||
        url.pathname.startsWith("/guardian") ||
        url.pathname.startsWith("/admin/")) {
      return dispatch(req);
    }
    // Static files (SvelteKit build output in /app/build/client)
    const filePath = `${process.env.STATIC_DIR ?? "/app/build/client"}${url.pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }
    // SPA fallback
    return new Response(Bun.file(`${process.env.STATIC_DIR ?? "/app/build/client"}/index.html`));
  }
});

console.log(`Admin server listening on :${port}`);
```

**AKM assistance:** `akm search bun serve static files spa fallback`

**Validation:** `bun run packages/admin/src/server/entry.ts` — server starts on :8100, `curl localhost:8100/health` returns `{"status":"ok","service":"admin"}`.

---

### ✅ Step C-3: Migration template — before/after pattern for each route (Workstream C)

**Context:** All 52 routes follow one of 4 patterns. Each migrated route becomes a function
registered with `addRoute`. The SvelteKit `RequestHandler` signature changes to
`(req: Request, params: Record<string, string>) => Promise<Response>`.

**Pattern A — Simple GET (no params, requireAdmin):**
```ts
// BEFORE (+server.ts):
export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;
  const state = getState();
  const actor = getActor(event);
  const callerType = getCallerType(event);
  // ... do work ...
  appendAudit(state, actor, "action", {}, true, requestId, callerType);
  return jsonResponse(200, { result }, requestId);
};

// AFTER (routes/admin/thing.ts):
import { addRoute } from "../router.js";
import { requireAdmin, getRequestId, getActor, getCallerType, jsonResponse } from "../helpers.js";
import { getState } from "../state.js";

addRoute("/admin/thing", {
  async GET(req) {
    const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
    const authErr = requireAdmin(req, requestId);
    if (authErr) return authErr;
    const state = getState();
    // ... same logic ...
    return jsonResponse(200, { result }, requestId);
  }
});
```

Key differences:
- `event.request` becomes `req` directly (no SvelteKit wrapper)
- `event.params.name` becomes `params.name` from the router
- `new URL(event.request.url)` becomes `new URL(req.url)`
- All other logic is unchanged
- `getRequestId`, `requireAdmin`, `jsonResponse` etc. are imported from local helpers (not `$lib/server/...`)

**Pattern B — POST with JSON body:**
Same as Pattern A but also calls `parseJsonBody(req)` (replaces `parseJsonBody(event.request)`).

**Pattern C — Parameterized route (`[name]`, `[id]`):**
```ts
addRoute("/admin/addons/[name]", {
  async GET(req, params) {
    const name = params.name;
    // ... rest same as pattern A
  }
});
```

**Pattern D — Streaming / SSE (containers/events, logs):**
These use `ReadableStream` in SvelteKit. In Bun.serve, the same `ReadableStream` API works.
No pattern change needed; just replace `event.request` with `req`.

---

### ✅ Step C-4: Migrate all 52 routes (Workstream C)

Each migration is mechanical using the template from C-3. Listed in recommended order
(simple GETs first, mutations second, complex routes last):

**Batch 1 — Unauthenticated (2 routes):**
1. `routes/health/+server.ts` → `server/routes/health.ts`
2. `routes/guardian/health/+server.ts` → `server/routes/guardian-health.ts`

**Batch 2 — requireAuth GETs (9 routes):**
3. `routes/admin/audit/+server.ts` → `server/routes/admin/audit.ts`
4. `routes/admin/artifacts/+server.ts` → `server/routes/admin/artifacts.ts`
5. `routes/admin/artifacts/manifest/+server.ts` → `server/routes/admin/artifacts-manifest.ts`
6. `routes/admin/artifacts/[name]/+server.ts` → `server/routes/admin/artifacts-by-name.ts`
7. `routes/admin/automations/+server.ts` → `server/routes/admin/automations.ts`
8. `routes/admin/automations/catalog/+server.ts` → `server/routes/admin/automations-catalog.ts`
9. `routes/admin/automations/[name]/log/+server.ts` → `server/routes/admin/automations-log.ts`
10. `routes/admin/containers/events/+server.ts` → `server/routes/admin/containers-events.ts`
11. `routes/admin/containers/list/+server.ts` → `server/routes/admin/containers-list.ts`
12. `routes/admin/containers/stats/+server.ts` → `server/routes/admin/containers-stats.ts`
13. `routes/admin/installed/+server.ts` → `server/routes/admin/installed.ts`
14. `routes/admin/logs/+server.ts` → `server/routes/admin/logs.ts`
15. `routes/admin/network/check/+server.ts` → `server/routes/admin/network-check.ts`

**Batch 3 — requireAdmin mutations (13 routes):**
16. `routes/admin/install/+server.ts` → `server/routes/admin/install.ts`
17. `routes/admin/update/+server.ts` → `server/routes/admin/update.ts`
18. `routes/admin/uninstall/+server.ts` → `server/routes/admin/uninstall.ts`
19. `routes/admin/upgrade/+server.ts` → `server/routes/admin/upgrade.ts`
20. `routes/admin/capabilities/+server.ts` → `server/routes/admin/capabilities.ts`
21. `routes/admin/capabilities/assignments/+server.ts` → `server/routes/admin/capabilities-assignments.ts`
22. `routes/admin/capabilities/export/opencode/+server.ts` → `server/routes/admin/capabilities-export.ts`
23. `routes/admin/capabilities/status/+server.ts` → `server/routes/admin/capabilities-status.ts`
24. `routes/admin/capabilities/test/+server.ts` → `server/routes/admin/capabilities-test.ts`
25. `routes/admin/config/validate/+server.ts` → `server/routes/admin/config-validate.ts`
26. `routes/admin/addons/+server.ts` → `server/routes/admin/addons.ts`
27. `routes/admin/addons/[name]/+server.ts` → `server/routes/admin/addons-by-name.ts`

**Batch 4 — Container mutations (5 routes):**
28. `routes/admin/containers/up/+server.ts` → `server/routes/admin/containers-up.ts`
29. `routes/admin/containers/down/+server.ts` → `server/routes/admin/containers-down.ts`
30. `routes/admin/containers/restart/+server.ts` → `server/routes/admin/containers-restart.ts`
31. `routes/admin/containers/pull/+server.ts` → `server/routes/admin/containers-pull.ts`

**Batch 5 — Secrets (3 routes):**
32. `routes/admin/secrets/+server.ts` → `server/routes/admin/secrets.ts`
33. `routes/admin/secrets/generate/+server.ts` → `server/routes/admin/secrets-generate.ts`
34. `routes/admin/secrets/user-vault/+server.ts` → `server/routes/admin/secrets-user-vault.ts`

**Batch 6 — Automations mutations (4 routes):**
35. `routes/admin/automations/[name]/run/+server.ts` → `server/routes/admin/automations-run.ts`
36. `routes/admin/automations/catalog/install/+server.ts` → `server/routes/admin/automations-catalog-install.ts`
37. `routes/admin/automations/catalog/uninstall/+server.ts` → `server/routes/admin/automations-catalog-uninstall.ts`
38. `routes/admin/automations/catalog/refresh/+server.ts` → `server/routes/admin/automations-catalog-refresh.ts`

**Batch 7 — OpenCode proxy (7 routes):**
39. `routes/admin/opencode/model/+server.ts` → `server/routes/admin/opencode-model.ts`
40. `routes/admin/opencode/providers/+server.ts` → `server/routes/admin/opencode-providers.ts`
41. `routes/admin/opencode/providers/[id]/auth/+server.ts` → `server/routes/admin/opencode-providers-auth.ts`
42. `routes/admin/opencode/providers/[id]/models/+server.ts` → `server/routes/admin/opencode-providers-models.ts`
43. `routes/admin/opencode/status/+server.ts` → `server/routes/admin/opencode-status.ts`

**Batch 8 — Provider management (8 routes):**
44. `routes/admin/providers/+server.ts` → `server/routes/admin/providers.ts`
45. `routes/admin/providers/custom/+server.ts` → `server/routes/admin/providers-custom.ts`
46. `routes/admin/providers/local/+server.ts` → `server/routes/admin/providers-local.ts`
47. `routes/admin/providers/model/+server.ts` → `server/routes/admin/providers-model.ts`
48. `routes/admin/providers/oauth/start/+server.ts` → `server/routes/admin/providers-oauth-start.ts`
49. `routes/admin/providers/oauth/finish/+server.ts` → `server/routes/admin/providers-oauth-finish.ts`
50. `routes/admin/providers/oauth/[providerId]/callback/+server.ts` → `server/routes/admin/providers-oauth-callback.ts`
51. `routes/admin/providers/save/+server.ts` → `server/routes/admin/providers-save.ts`
52. `routes/admin/providers/toggle/+server.ts` → `server/routes/admin/providers-toggle.ts`

**Remaining — auth endpoints:**
53. `server/routes/admin/auth-login.ts` (from B-1)
54. `server/routes/admin/auth-logout.ts` (from B-1)

**AKM assistance:** `akm search bun serve route migration sveltekit`

**Validation per batch:** After each batch, run:
```bash
bun run packages/admin/src/server/entry.ts &
curl -s localhost:8100/health | jq .
# For authenticated routes:
curl -s -X POST localhost:8100/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"token":"dev-admin-token"}' -c /tmp/op.jar
curl -s -b /tmp/op.jar localhost:8100/admin/containers/list | jq .
```

---

### ✅ Step C-5: Update `packages/admin/package.json` — replace SvelteKit start script with Bun entry (Workstream C)

**File:** `packages/admin/package.json`
**Change type:** modify

**Context:** The current `start` script runs `node build/index.js` (SvelteKit adapter-node).
After migration, it runs `bun src/server/entry.ts` directly (or the built output).

**Exact change:**
```json
// Before:
"start": "node build/index.js",

// After:
"start": "bun src/server/entry.ts",
```

Update the Dockerfile for the admin container similarly — replace `node build/index.js` with
`bun src/server/entry.ts`. The SvelteKit build step remains because it still produces the
client-side static bundle. Only the server-side entry changes.

**AKM assistance:** `akm search bun serve replace node adapter`

**Validation:** `docker compose ... up --build admin` — admin container starts, logs show
`Admin server listening on :8100`.

---

## Workstream D: Default mode cutover + feature flag removal

### Background

`OPENPALM_ADMIN_MODE` currently defaults to `container` (admin runs as a Docker container managed
by the CLI). The Phase 2 target is `host` mode (admin runs directly on the host, no Docker
container for admin itself). After searching all packages, there is no single env-var check for
this flag yet — it is a planned variable. Phase 2 introduces the runtime check and flips the default.

---

### ✅ Step D-1: Add `resolveAdminMode` to `packages/lib/src/control-plane/types.ts` (Workstream D)

**File:** `packages/lib/src/control-plane/types.ts`
**Change type:** modify

**Context:** `OPENPALM_ADMIN_MODE` has two valid values: `"host"` and `"container"`. This is
read by the CLI and by any bootstrap logic that decides whether to include the admin service
in `docker compose up`.

**Exact change — add after existing type exports:**
```ts
export type AdminMode = "host" | "container";

export function resolveAdminMode(): AdminMode {
  const val = (process.env.OPENPALM_ADMIN_MODE ?? "host").toLowerCase();
  return val === "container" ? "container" : "host";
}
```

The default is `"host"` because unset equals the new default.

**AKM assistance:** `akm search admin mode env var resolve`

**Validation:** `resolveAdminMode()` returns `"host"` when env var is unset. Returns `"container"`
when `OPENPALM_ADMIN_MODE=container`. Add to lib unit tests.

---

### ✅ Step D-2: Update CLI install command to skip admin container when mode is `host` (Workstream D)

**File:** `packages/cli/src/commands/install.ts`
**Change type:** modify

**Context:** Currently the CLI always includes admin in `docker compose up` when the admin
profile is enabled. In host mode, the admin binary runs directly; the compose file should not
include the admin service.

**Exact change — in the compose invocation section:**
```ts
import { resolveAdminMode } from "@openpalm/lib";

// In the composeUp call:
const mode = resolveAdminMode();
const profiles = mode === "container" ? ["admin"] : [];
await composeUp({ ...buildComposeOptions(state), profiles });
```

**AKM assistance:** `akm search cli install host mode compose profiles`

**Validation:** `OPENPALM_ADMIN_MODE=host bun run packages/cli/src/index.ts install` — compose
command does not include `--profile admin`. Container mode still works with `OPENPALM_ADMIN_MODE=container`.

---

### ✅ Step D-3: Update `packages/admin/src/lib/server/state.ts` — remove container-mode startup assumptions (Workstream D)

**File:** `packages/admin/src/lib/server/state.ts`
**Change type:** modify

**Context:** The state singleton currently assumes admin is always running inside a Docker
container (paths, env vars). In host mode, paths are relative to `OP_HOME` on the host, same
as the CLI. The `getState()` singleton needs to initialize from the same `OP_HOME` env var
that the CLI uses, not from hardcoded container paths like `/app/data`.

**Audit the file first:**
```bash
grep -n "\/app\/\|container\|OP_HOME\|homeDir" packages/admin/src/lib/server/state.ts
```

Update any hardcoded `/app/` prefixes to use `process.env.OP_HOME ?? process.env.HOME + "/.openpalm"`.
This is the same resolution the CLI uses via `resolveHomePath()` in lib.

**AKM assistance:** `akm search op_home resolve state init`

**Validation:** `OP_HOME=/tmp/test-op bun run packages/admin/src/server/entry.ts` — state
initializes with homeDir = `/tmp/test-op`.

---

### Step D-4: Remove container-mode code paths in Phase 3 (planned, not in Phase 2) (Workstream D)

**Note:** `OPENPALM_ADMIN_MODE=container` support is kept in Phase 2 for backwards compatibility.
Phase 3 removes the container mode entirely: delete the compose admin service definition,
remove `profiles: ["admin"]` from any compose files, and delete `resolveAdminMode()`.

This step is a **Phase 3 item** — do not implement now. Add a `// TODO(phase-3): remove container mode` comment
wherever the `container` branch lives after D-1/D-2.

---

## Workstream E: Docker lib consolidation (R6)

### Background

`packages/admin/src/lib/server/docker.ts` is a 143-line file that:
1. Re-exports everything from `@openpalm/lib` (read-only operations directly, no wrapper)
2. Adds preflight enforcement (`runPreflight`) around all mutation operations
3. Adds `inspectContainerStatus` (a `docker inspect` helper not in lib)

The preflight logic belongs in lib so the CLI can also use it. `inspectContainerStatus` also
belongs in lib.

---

### ✅ Step E-1: Move preflight enforcement into `packages/lib/src/control-plane/docker.ts` (Workstream E)

**File:** `packages/lib/src/control-plane/docker.ts`
**Change type:** modify

**Context:** `composePreflight` already exists in lib (line 103). The admin wrapper's `runPreflight`
function (docker.ts lines 40–52) checks `OP_SKIP_COMPOSE_PREFLIGHT` and throws on failure.
Move this check into each mutation function in lib so that both CLI and admin benefit.

**Exact change — add `runPreflight` as a private function in lib's docker.ts (after line 109):**
```ts
async function runPreflight(options: { files: string[]; envFiles?: string[] }): Promise<void> {
  if (options.files.length === 0 || process.env.OP_SKIP_COMPOSE_PREFLIGHT) return;
  const result = await composePreflight(options);
  if (!result.ok) {
    const project = resolveComposeProjectName();
    const fileArgs = options.files.map((f) => `-f ${f}`).join(" ");
    throw new Error(
      `Compose preflight failed: ${result.stderr}\n` +
      `Resolved: docker compose ${fileArgs} --project-name ${project} config --quiet`
    );
  }
}
```

Then add `await runPreflight(options)` at the top of `composeUp`, `composeDown`,
`composeRestart`, `composeStop`, `composeStart`, `composePullService`, `composePull`.

**AKM assistance:** `akm search compose preflight lib consolidate`

**Validation:** `bun run guardian:test && bun run cli:test` — no regressions. Set
`OP_SKIP_COMPOSE_PREFLIGHT=1` in a test to confirm skip path works.

---

### ✅ Step E-2: Move `inspectContainerStatus` into `packages/lib/src/control-plane/docker.ts` (Workstream E)

**File:** `packages/lib/src/control-plane/docker.ts`
**Change type:** modify

**Context:** `inspectContainerStatus` in admin's docker.ts (lines 124–143) queries Docker for
a container's running state. It has no admin-specific dependency. Move it to lib and export it.

**Exact change — copy function verbatim from admin/src/lib/server/docker.ts lines 124–142
and add it at the bottom of lib's docker.ts:**
```ts
/** Query Docker for a container's running state by name.
 * Returns "running" or "stopped". Falls back to "unknown" on error.
 */
export function inspectContainerStatus(
  containerName: string
): Promise<"running" | "stopped" | "unknown"> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) { resolve("unknown"); return; }
        const status = (stdout ?? "").toString().trim();
        resolve(status === "running" ? "running" : "stopped");
      }
    );
  });
}
```

**AKM assistance:** `akm search inspect container status lib`

**Validation:** `grep -n "inspectContainerStatus" packages/lib/src/control-plane/docker.ts`
shows the function. Import it from `@openpalm/lib` in a lib consumer — no type errors.

---

### ✅ Step E-3 (partial — docker.ts kept, vitest references it; routes migrated to @openpalm/lib directly): Delete `packages/admin/src/lib/server/docker.ts` (Workstream E)

**File:** `packages/admin/src/lib/server/docker.ts`
**Change type:** delete

**Context:** After E-1 and E-2, the file is a pure re-export with no unique logic. Consumers
should import from `@openpalm/lib` directly.

**Pre-deletion checklist:**
```bash
grep -rn "from.*server/docker\|from.*docker.js" packages/admin/src --include="*.ts"
```
Each remaining import site must be updated to `import { ... } from "@openpalm/lib"`.

Key import sites (from the current routes):
- `routes/admin/install/+server.ts` line 21: `import { composeUp, checkDocker } from "$lib/server/docker.js"`
- `routes/admin/update/+server.ts` — similar
- `routes/admin/containers/up/+server.ts` line 13: `import { composeStart, checkDocker } from "$lib/server/docker.js"`
- All other container routes

Update each to:
```ts
import { composeUp, checkDocker } from "@openpalm/lib";
```

After migrating to Bun.serve (Workstream C), the import path changes to a local relative path
in the new server files. The lib import stays the same.

**AKM assistance:** `akm search delete docker wrapper admin lib direct import`

**Validation:** `bun run admin:check` — zero "cannot find module" errors.
`bun run admin:test:unit` passes.

---

### ✅ Step E-4: Export `inspectContainerStatus` from `packages/lib/src/index.ts` (Workstream E)

**File:** `packages/lib/src/index.ts`
**Change type:** modify

**Context:** The lib barrel export must expose the new function.

**Exact change — find the docker exports block and add:**
```ts
export { inspectContainerStatus } from "./control-plane/docker.js";
```

**AKM assistance:** none needed.

**Validation:** `import { inspectContainerStatus } from "@openpalm/lib"` in a consumer compiles.

---

## Workstream F: Scheduler automation migration (R7)

### Background

The AKM task system uses markdown files in `stash/tasks/*.md`. The assistant container starts
`crond` at boot and runs `akm tasks sync` to register tasks with OS cron. Admin API at
`/admin/automations` manages the task catalog.

Phase 2 adds an `openpalm automations check` CLI command that detects whether the automation
cron jobs are registered and reports their status — usable in healthchecks or by the setup
wizard to confirm the scheduler is running.

---

### ✅ Step F-1: Add `automations check` command to the CLI (Workstream F)

**File:** `packages/cli/src/commands/automations.ts` (create)
**Change type:** create

**Context:** The CLI does not currently have an automations command. The assistant knows how to
run `akm tasks sync`; the CLI should be able to report automation status without the assistant.

**Content:**
```ts
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveHomePath } from "@openpalm/lib";

export async function automationsCheck(): Promise<void> {
  const home = resolveHomePath();
  const tasksDir = join(home, "stash", "tasks");

  if (!existsSync(tasksDir)) {
    console.log("No tasks directory found at", tasksDir);
    process.exit(0);
  }

  const taskFiles = readdirSync(tasksDir).filter((f) => f.endsWith(".md"));
  if (taskFiles.length === 0) {
    console.log("No automation tasks installed.");
    process.exit(0);
  }

  console.log(`Found ${taskFiles.length} automation task(s):`);
  for (const file of taskFiles) {
    console.log(`  - ${file.replace(".md", "")}`);
  }

  // Check crontab for registered tasks
  await new Promise<void>((resolve) => {
    execFile("crontab", ["-l"], (error, stdout) => {
      if (error) {
        console.log("No crontab found — tasks not yet registered (assistant not started?)");
        resolve();
        return;
      }
      const registered = taskFiles.filter((f) =>
        stdout.includes(f.replace(".md", ""))
      );
      console.log(`Registered in crontab: ${registered.length}/${taskFiles.length}`);
      if (registered.length < taskFiles.length) {
        console.log("Run 'akm tasks sync' inside the assistant container to register remaining tasks.");
      }
      resolve();
    });
  });
}
```

**AKM assistance:** `akm search automations check crontab tasks`

**Validation:**
```bash
bun run packages/cli/src/index.ts automations check
```
Outputs task list and crontab registration status.

---

### ✅ Step F-2: Register `automations check` in CLI command routing (Workstream F)

**File:** `packages/cli/src/index.ts` (or wherever commands are dispatched)
**Change type:** modify

**Context:** CLI commands are registered in the main entry. Add `automations` as a new subcommand.

**Exact change — find the command dispatch block and add:**
```ts
import { automationsCheck } from "./commands/automations.js";

// In the dispatch block:
case "automations":
  const sub = argv[1];
  if (sub === "check") {
    await automationsCheck();
  } else {
    console.error(`Unknown automations subcommand: ${sub}`);
    process.exit(1);
  }
  break;
```

**AKM assistance:** `akm search cli command dispatch register`

**Validation:** `bun run packages/cli/src/index.ts automations check` runs without errors.

---

### ✅ Step F-3: Update `packages/admin/src/routes/admin/automations/catalog/refresh/+server.ts` — detect stale cron (Workstream F)

**File:** `packages/admin/src/routes/admin/automations/catalog/refresh/+server.ts`
**Change type:** modify

**Context:** The refresh endpoint currently re-syncs the task files from the registry.
After R7, it should also report whether OS cron registrations are current (by comparing
`stash/tasks/*.md` file list against crontab entries, same logic as F-1 but server-side).
This gives the admin UI a "scheduler health" field.

**Exact change — in the POST handler response body, add:**
```ts
// After syncing task files:
const tasksDir = `${state.stashDir}/tasks`;
const taskFiles = existsSync(tasksDir)
  ? readdirSync(tasksDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", ""))
  : [];

return jsonResponse(200, {
  ok: true,
  tasks: taskFiles,
  cronSyncRequired: taskFiles.length > 0, // assistant will sync within 60s via startup cron
}, requestId);
```

**AKM assistance:** `akm search automations refresh cron sync response`

**Validation:** POST `/admin/automations/catalog/refresh` returns `{ ok: true, tasks: [...], cronSyncRequired: true|false }`.

---

## Execution Order and Dependencies

```
Day 1:  A-1, A-2, A-3 (can run in parallel on separate branches)
        B-1, B-2        (must land before B-3 removes auth.ts)
        D-1, D-2, D-3   (independent)
        E-1, E-2, E-3, E-4 (sequential within E, independent of A/B/C/D/F)
        F-1, F-2, F-3   (independent)

Day 2:  B-3 (after B-1/B-2 merged — auth.ts deletion)
        B-4, B-5, B-6   (after B-3 — api.ts, page.svelte, test fixtures)

Day 3+: C-1, C-2, C-3, C-4 (after B merged — route migration)
        C-5 (after C-4 — package.json / Dockerfile)
        D-4 (Phase 3 only — do not implement now)
```

---

## Complexity Flags

The following items have unjustified complexity and should be flagged for simplification
before or during implementation:

1. **`withAdminBody` in helpers.ts (lines 269–279):** This is a higher-order function wrapper
   that saves 3 lines at each call site. It adds indentation, makes stack traces harder to read,
   and is only used in ~8 routes. Consider inlining it — the 3-line pattern is clearer.

2. **`identifyCallerByToken` in helpers.ts (lines 94–100):** Returns a string union but is only
   used to feed `getActor`. The two functions could be one. The split was reasonable when
   `requireAuth` needed to check it, but after the cookie migration, `identifyCallerByToken`
   has no other callers. Merge into `getActor`.

3. **`resolveComposeProjectName` in lib docker.ts:** This function is called inside `buildComposeArgs`
   and also exported. Routes that call it directly (admin/docker.ts line 45 in the error message)
   can just read `process.env.OP_PROJECT_NAME ?? "openpalm"` inline — no need for an exported function.
   But this is minor; leave it for Phase 3.

4. **OAuth poll session storage in `opencode/providers/[id]/auth/+server.ts` (lines 32–88):**
   An in-memory `Map` with a TTL — this state is lost on admin restart and is not visible to
   the Bun.serve entry. During C-4 migration, this module-level map must be moved to a
   singleton in a shared module so it survives across request handlers.

---

## Validation Checklist (full Phase 2)

Run in order after all workstreams are merged:

- [ ] `bun run admin:check` — 0 type errors
- [ ] `bun run admin:test:unit` — 592+ tests pass
- [ ] `bun run guardian:test` — all guardian tests pass
- [ ] `bun run cli:test` — all CLI tests pass
- [ ] `bun run admin:test:e2e:mocked` — 69 mocked browser tests pass
- [ ] Manual: login via UI with cookie, navigate all tabs, reload preserves session
- [ ] Manual: POST `/admin/auth/logout` clears cookie, subsequent requests return 401
- [ ] Manual: `curl -H "x-admin-token: ..."` still accepted (assistant compatibility)
- [ ] Manual: `bun run packages/cli/src/index.ts automations check` — outputs task list
- [ ] `OP_SKIP_COMPOSE_PREFLIGHT=1 bun run admin:test:unit` — all docker-touching tests pass
