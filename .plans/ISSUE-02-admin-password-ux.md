# ISSUE-2: Admin Password UX Is Fundamentally Broken for Non-Technical Users

**Severity:** HIGH  
**Priority:** Should Fix  
**Effort:** M — touches 5+ files but changes are clearly scoped

## Problem Summary

The admin password is a random 64-character machine-generated token printed to the terminal during install. Users must copy-paste it from the terminal into the browser wizard's Security step. There is no recovery path, no server-side validation at paste time, and no way to change the password later. This is hostile to non-technical users.

## Implementation Steps

### Step 1: Add password fields to ProfileStep.svelte

**File:** `packages/ui/src/lib/components/ProfileStep.svelte`

Add two password fields (password + confirm) below the existing email field (after line 23):

- `id="wiz-profile-password"`, type="password", placeholder="Choose a password (min 8 characters)", autocomplete="new-password"
- `id="wiz-profile-password2"`, type="password", placeholder="Repeat password", autocomplete="new-password"
- Add an `error` prop (matching the pattern in ProvidersStep.svelte) to display validation errors
- Add a conditional error div: `{#if error}<div class="wiz-error visible">{error}</div>{/if}`

### Step 2: Update ProfileStep props interface

**File:** `packages/ui/src/lib/components/ProfileStep.svelte`

Add the `error` prop following the same pattern as `ProvidersStep.svelte:4-8`:
```typescript
interface Props { error: string; }
let { error }: Props = $props();
```

### Step 3: Pass error prop from SetupWizard to ProfileStep

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:222`

Change:
```svelte
<ProfileStep />
```
to:
```svelte
<ProfileStep error={stepError} />
```

### Step 4: Add password validation in wizardNext() for the profile step

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:64-80`

In the `if (currentStepName === 'profile')` block, after reading name and email (line 68), add:

1. Read `password` from `#wiz-profile-password`
2. Read `password2` from `#wiz-profile-password2`
3. Validate: `if (password.length < 8)` → set `stepError = 'Password must be at least 8 characters.'` and return
4. Validate: `if (password !== password2)` → set `stepError = 'Passwords do not match.'` and return
5. Add `password` to the API payload: `{ name, email, password }`
6. After successful API call, call `setAdminToken(password)` to save to localStorage

### Step 5: Handle password in the setup.profile server command

**File:** `packages/ui/src/routes/command/+server.ts:244-265`

In the `setup.profile` handler:

1. Extract password: `const password = typeof payload.password === 'string' ? payload.password.trim() : '';`
2. After `updateDataEnv(...)` (line 247-250), add password persistence:
   ```typescript
   if (password.length >= 8) {
     await upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password);
   }
   ```
3. Add required imports at the top of the file:
   - `import { upsertEnvVar } from '@openpalm/lib/env';` (the function exists at `packages/lib/src/env.ts:43`)
   - `RUNTIME_ENV_PATH` needs to be imported from `$lib/server/config` (currently line 42 imports `SECRETS_ENV_PATH` — add `RUNTIME_ENV_PATH` to the same import)
   - **Note:** The existing env-helpers (`updateRuntimeEnv` etc.) could also be used, but they operate on batch updates. `upsertEnvVar` is the correct choice for setting a single key atomically, and it's already used in `install.ts:7`.

**Note:** The running admin process's `ADMIN_TOKEN` is a frozen module-level constant (`config.ts:17`). The new password takes effect when `setup.complete` fires and calls `composeAction('up', [...SetupCoreServices])` which recreates the admin container with the updated `.env`.

### Step 6: Gut the SecurityStep — remove password paste, keep security info

**File:** `packages/ui/src/lib/components/SecurityStep.svelte`

Replace the entire component content. Remove:
- The admin token import and `currentToken` derived state (lines 2, 9)
- The `error` prop (it's no longer needed since password moved to Profile)
- The password paste `<input>` and its surrounding `sec-box` div (lines 18-29)

Keep:
- The "Security Features" box (lines 31-38) — this is informational and useful

The component becomes a simple info display with no props needed.

### Step 7: Remove security step handling from wizardNext()

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:135-138`

Remove the entire `if (currentStepName === 'security')` block. The `setAdminToken()` call now happens in the profile step (Step 4 above).

### Step 8: Update the Security step rendering in SetupWizard

**File:** `packages/ui/src/lib/components/SetupWizard.svelte:226`

Change:
```svelte
<SecurityStep error={stepError} />
```
to:
```svelte
<SecurityStep />
```

(Since SecurityStep no longer has an `error` prop.)

### Step 9: Soften the terminal password display during install

**File:** `packages/cli/src/commands/install.ts:166-175`

Change the banner from "YOUR ADMIN PASSWORD (save this!)" to a lighter message:

```typescript
if (generatedAdminToken) {
  log("");
  info("  A temporary admin token has been generated.");
  info("  You will choose your own password in the setup wizard.");
  info(`  Temporary token saved in: ${dim(stateEnvFile)}`);
  log("");
}
```

Also update the final output section at line 412-414 — remove the second `Admin password:` line since the wizard now handles password selection.

### Step 10: Add a post-setup password change command

**File:** `packages/ui/src/routes/command/+server.ts`

Add a new command handler `secret.set_admin_password` (after the existing `secret.upsert` handler around line 369):

```typescript
if (type === 'secret.set_admin_password') {
  const password = typeof payload.password === 'string' ? payload.password.trim() : '';
  if (password.length < 8) {
    return json(400, { ok: false, error: 'Password must be at least 8 characters.', code: 'invalid_password' });
  }
  await upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password);
  await composeAction('restart', 'admin');
  return json(200, { ok: true });
}
```

This is authenticated (checked at line 109), so only the current admin can change the password. The admin container restart applies the new token from `.env`.

### Step 11: Update the install flow "What happens next" text

**File:** `packages/cli/src/commands/install.ts:416-421`

Update step descriptions to reflect the new flow:
- Step 2: "Create your admin password and profile"
- Remove references to "setting a password" from step 4

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/ProfileStep.svelte` | Add password fields and error prop |
| `packages/ui/src/lib/components/SecurityStep.svelte` | Remove password paste, keep security info only |
| `packages/ui/src/lib/components/SetupWizard.svelte` | Add password validation in profile step, remove security step handler, update prop passing |
| `packages/ui/src/routes/command/+server.ts` | Handle password in setup.profile, add secret.set_admin_password command |
| `packages/cli/src/commands/install.ts` | Soften terminal password display, update "what happens next" text |

## Testing

1. Run existing tests: `bun test` — ensure no regressions
2. Manual smoke test: full install → wizard → verify password is set in Profile step, SecurityStep shows info only
3. Verify: after setup.complete, admin container restarts with user-chosen password
4. Verify: `secret.set_admin_password` command works post-setup
5. Verify: old token display in terminal is replaced with softer message
