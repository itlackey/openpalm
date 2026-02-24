# ISSUE-4: Port 80 Conflict Has No Resolution Path

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** M

## Problem Summary

The preflight check warns if port 80 is occupied but install proceeds anyway. Caddy silently fails to bind, the health check times out, and the user gets no useful diagnosis. There is no `--port` flag to use an alternative port.

## Implementation Steps

### Step 1: Elevate port 80 warning to fatal error in install.ts

**File:** `packages/cli/src/commands/install.ts:42-64`

After the daemon warning check (lines 57-64), add a port 80 check:

```typescript
const port80Warning = preflightWarnings.find((w) =>
  w.message.includes("Port 80 is already in use")
);
if (port80Warning && !options.port) {
  error("Port 80 is required but already in use. Use --port to specify an alternative.");
  process.exit(1);
}
```

### Step 2: Add --port flag to CLI install command

**File:** `packages/cli/src/commands/install.ts`

The `InstallOptions` type (defined in `packages/cli/src/types.ts`) needs a `port` field added:

```typescript
port?: number;
```

Register the `--port` flag in the CLI argument parser (likely in `packages/cli/src/index.ts` or wherever commands are defined).

### Step 3: Thread port through to OPENPALM_INGRESS_PORT env var

**File:** `packages/cli/src/commands/install.ts:183-199`

In the `upsertEnvVars` call, add the port if specified:

```typescript
if (options.port) {
  entries.push(["OPENPALM_INGRESS_PORT", String(options.port)]);
}
```

### Step 4: Update minimal Caddy JSON to use configurable port

**File:** `packages/cli/src/commands/install.ts:228-266`

Change the hardcoded `listen: [":80"]` at line 235 to:

```typescript
listen: [`:${options.port ?? 80}`],
```

### Step 5: Update minimal compose to use configurable port

**File:** `packages/cli/src/commands/install.ts:276-322`

Change the port binding at line 281 from:
```yaml
- "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80"
```
to use the port variable:
```yaml
- "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:${OPENPALM_INGRESS_PORT:-80}:80"
```

### Step 6: Parameterize the stack generator Caddy listen directive

**File:** `packages/lib/src/admin/stack-generator.ts`

In the `renderCaddyJsonConfig` function, the main server listen is hardcoded at `[":80"]` (around line 290 in the returned config). The stack spec should carry the ingress port.

1. Add `ingressPort?: number` to `StackSpec` type in `packages/lib/src/admin/stack-spec.ts`
2. In `renderCaddyJsonConfig`, change `listen: [":80"]` to `listen: [`:${spec.ingressPort ?? 80}`]`
3. The stack manager should read `OPENPALM_INGRESS_PORT` from runtime env and pass it through

### Step 7: Update the health check URL in install.ts

**File:** `packages/cli/src/commands/install.ts:358-359`

Change `const adminUrl = "http://localhost"` to include the port:

```typescript
const port = options.port ?? 80;
const adminUrl = port === 80 ? "http://localhost" : `http://localhost:${port}`;
```

### Step 8: Update preflight port check to check the configured port

**File:** `packages/lib/src/preflight.ts:46-82`

Rename `checkPort80` to `checkPort` and accept a `port` parameter:

```typescript
export async function checkPort(port: number = 80): Promise<PreflightWarning | null> {
```

Update all references to port 80 within the function to use the parameter. Update `runPreflightChecks` to accept and pass the port.

## Files Changed

| File | Change |
|---|---|
| `packages/cli/src/commands/install.ts` | Add --port flag handling, use configurable port in Caddy JSON, compose, and health check URL |
| `packages/cli/src/types.ts` | Add `port` to InstallOptions |
| `packages/lib/src/preflight.ts` | Parameterize port check function |
| `packages/lib/src/admin/stack-spec.ts` | Add `ingressPort` to StackSpec |
| `packages/lib/src/admin/stack-generator.ts` | Use spec.ingressPort in Caddy listen directive |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: `openpalm install` with port 80 occupied → should fail with clear error
3. Manual test: `openpalm install --port 8080` → should succeed with alternative port
4. Verify Caddy binds to the specified port
5. Verify admin URL uses the correct port in terminal output and browser open
