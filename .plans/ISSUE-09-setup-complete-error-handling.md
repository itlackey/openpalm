# ISSUE-9: Setup Wizard Complete Step Has No Error Handling or Retry

**Severity:** HIGH  
**Priority:** Should Fix  
**Effort:** M — add error checks and retry UI

## Problem Summary

`finishSetup()` in `SetupWizard.svelte:168-203` makes four sequential API calls with no error handling. If any call fails (image pull timeout, port conflict, out of disk space), the result is discarded and the wizard advances to CompleteStep unconditionally. The user sees "Finalizing setup..." with no indication that setup actually failed.

## Implementation Steps

### Step 1: Add error handling to finishSetup() channel save call

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:168-203`

The `setup.channels` call at line 177-183 currently discards its result. Wrap it:

```typescript
async function finishSetup() {
  stepError = '';

  const enabledChannels = Array.from(
    document.querySelectorAll<HTMLInputElement>('.wiz-ch:checked')
  ).map((c) => c.value);
  const channelConfigs = collectChannelConfigs();

  const channelsResult = await api('/command', {
    method: 'POST',
    body: JSON.stringify({
      type: 'setup.channels',
      payload: { channels: enabledChannels, channelConfigs }
    })
  });
  if (!channelsResult.ok) {
    stepError = 'Could not save channel configuration. Please try again.';
    return;
  }
```

### Step 2: Add error handling to channel service.up calls

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:186-191`

The `service.up` loop fires sequentially but never checks results. Channel startup failures are non-fatal (channels can be started later), so log but don't block:

```typescript
  // Start enabled channels — non-fatal, channels can be started later
  for (const channel of enabledChannels) {
    const upResult = await api('/command', {
      method: 'POST',
      body: JSON.stringify({ type: 'service.up', payload: { service: channel } })
    });
    if (!upResult.ok) {
      console.warn(`Failed to start ${channel}: ${upResult.data?.error ?? 'unknown'}`);
    }
  }
```

### Step 3: Add error handling to setup.step and setup.complete calls

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:193-203`

The `setup.step` and `setup.complete` calls are critical. The `setup.complete` handler in `command/+server.ts:327-337` calls `applyStack()` and `composeAction('up', [...SetupCoreServices])`. If compose fails, it throws and the outer try/catch at `command/+server.ts:642-643` returns `{ ok: false, error: String(error) }`.

```typescript
  // Mark step complete
  const stepResult = await api('/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'setup.step', payload: { step: currentStepName } })
  });
  if (!stepResult.ok) {
    stepError = 'Could not save step progress. Please try again.';
    return;
  }

  // Finalize — this triggers stack apply and core service restart
  const completeResult = await api('/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'setup.complete', payload: {} })
  });
  if (!completeResult.ok) {
    const errorMsg = completeResult.data?.error ?? 'unknown error';
    stepError = `Setup failed: ${errorMsg}. Check that Docker is running and you have internet access, then click "Finish Setup" to retry.`;
    return; // do NOT advance wizard
  }

  setWizardStep(STEPS.length - 1);
}
```

### Step 4: Add a finishInProgress state to prevent double-clicks

**File:** `packages/ui/src/lib/components/SetupWizard.svelte`

Add a state variable near line 42:

```typescript
let finishInProgress = $state(false);
```

Wrap `finishSetup()` with a guard:

```typescript
async function finishSetup() {
  if (finishInProgress) return;
  finishInProgress = true;
  stepError = '';
  try {
    // ... all the calls from Steps 1-3 ...
  } finally {
    finishInProgress = false;
  }
}
```

Update the "Finish Setup" button at line 244 to show loading state:

```svelte
{#if isLastContentStep}
  <button onclick={finishSetup} disabled={finishInProgress}>
    {finishInProgress ? 'Finishing...' : 'Finish Setup'}
  </button>
{:else}
```

### Step 5: Display the stepError on the channels/healthCheck step page

**File:** `packages/ui/src/lib/components/SetupWizard.svelte`

The `finishSetup()` function is called from the healthCheck step (the last content step before complete). The error needs to be visible. Currently `stepError` is only displayed in components that accept an `error` prop. Since `finishSetup()` runs on the healthCheck step, add error display at the wizard level.

Add after line 236 (after the body div close), inside the wizard but before the actions:

```svelte
{#if stepError && !isComplete}
  <div class="wiz-error visible" style="margin: 0.5rem 0">{stepError}</div>
{/if}
```

This ensures errors from `finishSetup()` are visible regardless of which step component is active.

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/SetupWizard.svelte` | Add error handling to all finishSetup() API calls, add finishInProgress guard, add error display |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: simulate failure by temporarily stopping Docker → run setup → verify error message appears and wizard does not advance
3. Verify: after fixing the issue and clicking "Finish Setup" again, setup completes normally
4. Verify: the "Finish Setup" button is disabled during the operation (no double-click)
5. Verify: channel startup failures don't block overall setup completion

## Dependencies

None — this is a standalone fix.
