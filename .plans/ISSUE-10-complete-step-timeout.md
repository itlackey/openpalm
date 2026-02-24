# ISSUE-10: CompleteStep Timeout Has No Actionable Guidance

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** S — small UI enhancement

## Problem Summary

`CompleteStep.svelte:15-31` polls `setup/health-check` up to 120 times at one-second intervals. On timeout, it shows the generic message "Some services are still starting. You can continue anyway." without indicating which specific services failed. The health-check response already includes per-service status (`gateway`, `assistant`, `openmemory`, `admin`) but only `allOk` is checked — individual status is never displayed.

## Implementation Steps

### Step 1: Store per-service health status in component state

**File:** `packages/ui/src/lib/components/CompleteStep.svelte`

Add a reactive state variable to hold per-service status. After line 13 (`let timedOut = $state(false);`), add:

```typescript
let serviceStatus = $state<Record<string, { ok: boolean; time?: string }>>({});
```

### Step 2: Track service status during polling

**File:** `packages/ui/src/lib/components/CompleteStep.svelte:18-26`

In `pollUntilReady()`, update `serviceStatus` on each successful response. Replace lines 18-26:

```typescript
if (r.ok) {
  const services = r.data?.services || {};
  serviceStatus = Object.fromEntries(
    Object.entries(services).map(([name, s]) => [name, { ok: !!(s as any)?.ok, time: (s as any)?.time }])
  );
  const allOk = Object.values(services).every((s) => (s as any)?.ok);
  if (allOk) {
    ready = true;
    statusText = 'Everything is ready!';
    return;
  }
}
```

### Step 3: Display per-service status on timeout

**File:** `packages/ui/src/lib/components/CompleteStep.svelte:45-47`

Replace the timedOut block to show which services are not healthy:

```svelte
{:else if timedOut}
  <div style="margin:0.5rem 0">
    <p>Some services took too long to start:</p>
    <ul style="margin:0.4rem 0; padding-left:1.2rem">
      {#each Object.entries(serviceStatus) as [name, s]}
        <li style="color: {s.ok ? 'var(--green, green)' : 'var(--red, red)'}">
          {name} — {s.ok ? 'ready' : 'not ready'}
        </li>
      {/each}
    </ul>
    <p class="muted" style="font-size:13px">
      Check your API key is correct, then run <code>openpalm logs</code> for details.
    </p>
  </div>
  <button class="btn-secondary" onclick={oncontinue}>Continue to Admin</button>
{/if}
```

### Step 4: Show live progress during polling (optional enhancement)

**File:** `packages/ui/src/lib/components/CompleteStep.svelte`

During polling (before ready or timedOut), show which services are already up:

After line 42 (`<p class="muted">{statusText}</p>`), add:

```svelte
{#if !ready && !timedOut && Object.keys(serviceStatus).length > 0}
  <ul style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px">
    {#each Object.entries(serviceStatus) as [name, s]}
      <li style="color: {s.ok ? 'var(--green, green)' : 'var(--muted, #888)'}">
        {name} — {s.ok ? 'ready' : 'starting...'}
      </li>
    {/each}
  </ul>
{/if}
```

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/CompleteStep.svelte` | Add serviceStatus state, track per-service health, display on timeout and during polling |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: complete setup → verify per-service status appears during polling
3. Manual test: stop one service (e.g., `docker compose stop assistant`) before setup → verify timeout shows which service failed
4. Verify the "Continue to Admin" button still works on timeout
5. Verify that when all services come up, the happy path ("Everything is ready!") still works

## Dependencies

None — standalone UI enhancement.
