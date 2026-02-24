# ISSUE-3: Setup Wizard Allows Skipping Required Steps

**Severity:** HIGH  
**Priority:** Must Fix (Blocker)  
**Effort:** S — add one validation check

## Problem Summary

The AI Provider step (`serviceInstances`) does not validate that the user has entered an Anthropic API key before advancing. If a user skips this, the assistant starts without `ANTHROPIC_API_KEY` and every chat request fails silently.

## Implementation Steps

### Step 1: Add Anthropic API key validation guard in wizardNext()

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:82-133`

In the `if (currentStepName === 'serviceInstances')` block, after reading `anthropicApiKey` at line 95-96, add validation before the API call:

Insert after line 96 (after reading `anthropicApiKey`), before `smallModelEndpoint` (line 97):

```typescript
// Require Anthropic key — it's the primary provider and must be set during initial setup
if (!anthropicApiKey.trim()) {
  stepError = 'An Anthropic API key is required. Get one free at console.anthropic.com.';
  return;
}
```

This is a simple client-side non-empty check. The server-side check in Step 2 adds defense-in-depth by also checking whether a key was previously saved in `secrets.env`.

**Note:** No new import is needed for this step — it only reads a DOM input value and sets `stepError`, both of which are already available.

### Step 2: Verify server-side also validates (defense in depth)

**File:** `packages/ui/src/routes/command/+server.ts:267-303`

In the `setup.service_instances` handler, the server currently accepts payloads without an Anthropic key (line 273: `const anthropicApiKey = sanitizeEnvScalar(payload.anthropicApiKey);` — if empty, it just skips writing it at line 286).

Add server-side validation as a defense-in-depth measure. After extracting `anthropicApiKey` at line 273:

```typescript
// During initial setup, require Anthropic key unless already configured
if (!setupState.completed) {
  const existingSecrets = readSecretsEnv();
  if (!anthropicApiKey && !existingSecrets.ANTHROPIC_API_KEY) {
    return json(400, { ok: false, error: 'anthropic_key_required', code: 'anthropic_key_required' });
  }
}
```

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/SetupWizard.svelte` | Add Anthropic key non-empty validation in serviceInstances step |
| `packages/ui/src/routes/command/+server.ts` | Add server-side Anthropic key validation in setup.service_instances handler |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: try advancing the Providers step with no Anthropic key → should show error
3. Manual test: after setup is complete, editing providers with blank Anthropic key should be allowed (key already exists in secrets.env)
4. Manual test: enter a valid key → should advance normally
