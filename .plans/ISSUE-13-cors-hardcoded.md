# ISSUE-13: CORS Hardcoded to `http://localhost` Breaks LAN Access

**Severity:** MEDIUM  
**Priority:** Should Fix  
**Effort:** S — replace constant with dynamic logic

## Problem Summary

`packages/ui/src/hooks.server.ts:5` hardcodes `const ALLOWED_ORIGIN = 'http://localhost'`. When a LAN user accesses the admin UI via IP address (e.g., `http://192.168.1.50`), the browser sends `Origin: http://192.168.1.50` but the response returns `Access-Control-Allow-Origin: http://localhost`. The browser blocks all API calls due to CORS mismatch, completely breaking the LAN access scope feature.

## Implementation Steps

### Step 1: Import setupManager in hooks.server.ts

**File:** `packages/ui/src/hooks.server.ts`

Add import for `getSetupManager` at line 3 (after existing imports):

```typescript
import { getSetupManager } from '$lib/server/init';
```

### Step 2: Add helper functions for dynamic origin resolution

**File:** `packages/ui/src/hooks.server.ts`

Add two helper functions after the imports (replacing the `ALLOWED_ORIGIN` constant at line 5):

```typescript
function isPrivateOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

function computeAllowedOrigin(scope: string, requestOrigin: string): string {
  // No origin header = same-origin request, reflect nothing
  if (!requestOrigin) return '';

  if (scope === 'public') return requestOrigin;

  if (scope === 'lan') {
    // Reflect the origin if it's a private/local IP
    if (isPrivateOrigin(requestOrigin)) return requestOrigin;
    return 'http://localhost';
  }

  // 'host' scope — only localhost
  if (requestOrigin.includes('localhost') || requestOrigin.includes('127.0.0.1')) {
    return requestOrigin;
  }
  return 'http://localhost';
}
```

### Step 3: Update the OPTIONS preflight handler

**File:** `packages/ui/src/hooks.server.ts:12-22`

Replace the static `ALLOWED_ORIGIN` usage with dynamic resolution:

```typescript
if (event.request.method === 'OPTIONS') {
  const setupManager = await getSetupManager();
  const { accessScope } = setupManager.getState();
  const requestOrigin = event.request.headers.get('origin') ?? '';
  const allowedOrigin = computeAllowedOrigin(accessScope ?? 'host', requestOrigin);

  return new Response(null, {
    status: 204,
    headers: {
      ...(allowedOrigin ? { 'access-control-allow-origin': allowedOrigin } : {}),
      'access-control-allow-headers': 'content-type, x-admin-token, x-request-id',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'Origin'
    }
  });
}
```

### Step 4: Update the CORS headers on all responses

**File:** `packages/ui/src/hooks.server.ts:31-38`

Replace the static CORS header application:

```typescript
// Resolve dynamic CORS origin
const setupManager = await getSetupManager();
const { accessScope } = setupManager.getState();
const requestOrigin = event.request.headers.get('origin') ?? '';
const allowedOrigin = computeAllowedOrigin(accessScope ?? 'host', requestOrigin);

// Resolve request
const response = await resolve(event);

// CORS headers on all responses
if (allowedOrigin) {
  response.headers.set('access-control-allow-origin', allowedOrigin);
}
response.headers.set(
  'access-control-allow-headers',
  'content-type, x-admin-token, x-request-id'
);
response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
response.headers.append('vary', 'Origin');

return response;
```

### Step 5: Optimize — cache setupManager call to avoid double resolution

**File:** `packages/ui/src/hooks.server.ts`

Since both the OPTIONS handler and the regular handler need `accessScope`, move the resolution before the OPTIONS check so it's done once:

```typescript
export const handle: Handle = async ({ event, resolve: resolveEvent }) => {
  await ensureInitialized();

  const setupManager = await getSetupManager();
  const { accessScope } = setupManager.getState();
  const requestOrigin = event.request.headers.get('origin') ?? '';
  const allowedOrigin = computeAllowedOrigin(accessScope ?? 'host', requestOrigin);

  // OPTIONS preflight
  if (event.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...(allowedOrigin ? { 'access-control-allow-origin': allowedOrigin } : {}),
        'access-control-allow-headers': 'content-type, x-admin-token, x-request-id',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        vary: 'Origin'
      }
    });
  }

  // Parse auth token
  const token = event.request.headers.get('x-admin-token') ?? '';
  event.locals.authenticated = verifyAdminToken(token);

  // Resolve request
  const response = await resolveEvent(event);

  // CORS headers on all responses
  if (allowedOrigin) {
    response.headers.set('access-control-allow-origin', allowedOrigin);
  }
  response.headers.set('access-control-allow-headers', 'content-type, x-admin-token, x-request-id');
  response.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.headers.append('vary', 'Origin');

  return response;
};
```

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/hooks.server.ts` | Replace hardcoded `ALLOWED_ORIGIN` with dynamic `computeAllowedOrigin()` based on `accessScope` |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test (host scope): access admin from `http://localhost` → verify API calls work
3. Manual test (LAN scope): set access scope to "lan" → access admin from `http://192.168.x.x` → verify API calls work
4. Manual test (LAN scope): access admin from non-private IP → verify CORS blocks the request
5. Verify: `Vary: Origin` header is always present (required for caching correctness)
6. Verify: no CORS header is set when there's no `Origin` header in the request (same-origin navigation)

## Dependencies

None — standalone fix. The `accessScope` is already stored in setup state by the Access step of the wizard.
