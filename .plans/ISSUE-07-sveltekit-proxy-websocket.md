# ISSUE-7: SvelteKit Proxy Cannot Handle WebSocket or SSE

**Severity:** BLOCKER (unless Option A from ISSUE-6 is chosen)  
**Priority:** Must Fix  
**Effort:** Resolved by ISSUE-6 fix

## Problem Summary

The SvelteKit proxy at `routes/opencode/[...path]/+server.ts` uses `fetch()` with `AbortSignal.timeout(5000)`, which kills any response longer than 5 seconds. SvelteKit server routes also cannot upgrade HTTP to WebSocket. This breaks all real AI chat responses.

## Implementation Steps

### Step 1: Resolved by ISSUE-6

If ISSUE-6 is implemented (changing `QuickLinks.svelte:5` to use `/services/opencode/` via Caddy), this issue is automatically resolved:

- Caddy handles WebSocket upgrades natively
- Caddy has no timeout on long-lived connections
- SSE streams work without interruption

No additional code changes are needed.

### Step 2: (Optional) Increase timeout as defense-in-depth

**File:** `packages/ui/src/routes/opencode/[...path]/+server.ts:27`

Even though the primary path will go through Caddy, if the SvelteKit proxy route is kept for programmatic access, the 5-second timeout should be raised:

Change:
```typescript
signal: AbortSignal.timeout(5000),
```
to:
```typescript
signal: AbortSignal.timeout(300_000),  // 5 minutes for AI responses
```

This is a minor defensive change. The route is unlikely to be used for chat after ISSUE-6, but raising the timeout prevents confusion if anyone does hit this endpoint programmatically.

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/routes/opencode/[...path]/+server.ts` | (Optional) Raise timeout from 5s to 300s |

## Testing

1. ISSUE-6 tests cover the primary path
2. If timeout is raised: verify programmatic API calls through the proxy route work with longer responses
