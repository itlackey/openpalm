# ISSUE-11: No Admin UI Access if Caddy Fails to Start

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** S — add port mapping and update error message

## Problem Summary

If port 80 is occupied and Caddy exits, the admin service at port 8100 is running and healthy inside the container, but the user cannot reach it because the minimal compose at `install.ts:276-322` does not expose port 8100 on the host. The health check loop at `install.ts:366-378` times out and the user sees "Setup did not come online within 3 minutes" with no way to access the admin UI.

## Implementation Steps

### Step 1: Add direct host port mapping for admin in minimal compose

**File:** `packages/cli/src/commands/install.ts:290-311`

In the minimal compose string, add a `ports` section to the admin service. Currently the admin service block starts at line 290. Add the ports mapping:

After `restart: unless-stopped` (line 292), add:

```yaml
    ports:
      - "127.0.0.1:8100:8100"
```

The full admin service block becomes:

```yaml
  admin:
    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8100:8100"
    env_file:
      - ${OPENPALM_STATE_HOME}/system.env
    environment:
      # ... unchanged
```

This is `127.0.0.1` bound, so it's only reachable from localhost — consistent with the security model during initial setup.

### Step 2: Update the health check URL to try admin directly

**File:** `packages/cli/src/commands/install.ts:358-378`

Currently the health check polls `http://localhost/setup/status` (through Caddy). Add a fallback that tries the direct admin port if the Caddy-proxied URL fails:

```typescript
const adminUrl = "http://localhost";
const adminDirectUrl = "http://localhost:8100";
const healthUrl = `${adminUrl}/setup/status`;
const healthDirectUrl = `${adminDirectUrl}/setup/status`;

// ... in the polling loop, after the existing fetch fails:
try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
  if (response.ok) {
    healthy = true;
    break;
  }
} catch {
  // Try direct admin port as fallback
  try {
    const directResponse = await fetch(healthDirectUrl, { signal: AbortSignal.timeout(3000) });
    if (directResponse.ok) {
      healthy = true;
      adminUrl = adminDirectUrl; // Use direct URL for browser open
      break;
    }
  } catch {
    // Neither route ready yet
  }
}
```

Note: `adminUrl` needs to be declared with `let` instead of `const` for this pattern. Currently it's `const` at line 358.

### Step 3: Update the failure message to include direct admin URL

**File:** `packages/cli/src/commands/install.ts:428-446`

In the "Setup did not come online" failure block, add a step mentioning the direct admin URL. After the existing step 4 (line 444-445), add:

```typescript
info("");
info("  5. If the browser doesn't open, try the direct admin URL:");
info(`     ${cyan("http://localhost:8100")}`);
```

### Step 4: Also update the success output to mention direct URL

**File:** `packages/cli/src/commands/install.ts:409-410`

After the setup wizard URL line, add a note about the direct port:

```typescript
info(`  Setup wizard: ${cyan(adminUrl)}`);
info(`  Direct admin: ${cyan("http://localhost:8100")} (if port 80 is blocked)`);
```

### Step 5: Add ports to full stack compose template as well

**File:** `packages/lib/src/embedded/state/docker-compose.yml:138-165`

The full stack admin service definition also lacks a direct host port mapping. Add:

```yaml
  admin:
    image: ${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8100:8100"
    env_file:
    # ... rest unchanged
```

This ensures the direct admin access persists after the full stack compose replaces the minimal one.

## Files Changed

| File | Change |
|---|---|
| `packages/cli/src/commands/install.ts` | Add admin port mapping in minimal compose, add direct URL fallback in health check, update error/success messages |
| `packages/lib/src/embedded/state/docker-compose.yml` | Add admin port `127.0.0.1:8100:8100` mapping |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: occupy port 80 with another service → run `openpalm install` → verify admin is reachable at `http://localhost:8100`
3. Verify: when port 80 is free, the normal flow (`http://localhost`) still works
4. Verify: direct admin URL is printed in both success and failure terminal output
5. Verify: the full stack compose also includes the admin port mapping

## Dependencies

None — standalone fix. Complements ISSUE-4 (port 80 conflict).
