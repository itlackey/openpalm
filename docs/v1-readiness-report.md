# OpenPalm v1 MVP Readiness Report

**Date:** 2026-02-24
**Version reviewed:** 0.3.4
**Reviewer:** Automated end-to-end review with local manual verification

---

## v1 MVP Requirements

| # | Requirement | Status |
|---|---|---|
| 1 | A non-technical user can easily install and complete initial setup | **Partial** |
| 2 | Once setup is complete the user can easily chat with the assistant in their browser | **Blocked** |
| 3 | End-to-end UX from install to first chat session is failure-proof, always resulting in a working admin UI for troubleshooting | **Partial** |

---

## Executive Summary

The solution has strong architectural foundations: a well-designed CLI installer, a multi-step setup wizard, a robust stack management engine with atomic apply/rollback, and comprehensive test coverage (576 passing tests, 0 failures). Docker images are published to Docker Hub for amd64/arm64, CLI binaries are available on GitHub Releases for all major platforms, and the npm package is published.

However, there are several blocking and high-priority issues that prevent the v1 MVP from meeting its three hard requirements. The most critical is that **the primary path to chatting with the assistant via the browser does not work** due to an authentication/routing mismatch in the OpenCode web interface proxy. The second most impactful is that **the admin password UX is fragile and hostile to non-technical users** — the auto-generated token must be copied from the terminal into the browser wizard, and there is no recovery path if the user misses it. Additional issues around error recovery, UX gaps in the wizard, and CORS configuration need resolution before release.

---

## Requirement 1: Easy Install and Setup

### What Works

- **One-command install**: `install.sh` (Linux/macOS) and `install.ps1` (Windows) download the pre-compiled CLI binary from GitHub Releases, verify checksums, and delegate to `openpalm install`. This is well-designed for non-technical users.
- **Prerequisites documentation**: The README clearly explains what a container runtime is and links to installation guides for each platform.
- **Runtime detection**: The CLI automatically detects Docker, Podman, or OrbStack and selects the correct compose command.
- **Preflight checks**: The installer checks for disk space (3 GB minimum), port 80 availability, and Docker daemon status before proceeding. Each failure provides clear, actionable guidance.
- **Secret generation**: The admin token and all channel HMAC secrets are auto-generated securely using `generateToken()` (`packages/lib/src/tokens.ts:10`), which produces 64-character cryptographically secure URL-safe base64 strings.
- **Idempotency guard**: Re-running `openpalm install` detects an existing installation and offers to update or force-reinstall.
- **Setup wizard**: An 8-step browser wizard (Welcome, Profile, AI Providers, Security, Channels, Access, Health Check, Complete) walks users through configuration.

### Issues Found

---

#### ISSUE-2: Admin Password UX Is Fundamentally Broken for Non-Technical Users (Severity: HIGH)

This is the most impactful UX problem in the entire install flow. The current design forces users through an error-prone, non-intuitive process to authenticate their own admin panel.

**How it currently works — the full chain:**

1. **`install.ts:140`** — `generateToken()` creates a random 64-character token and assigns it to `generatedAdminToken`.
2. **`install.ts:145-151`** — Token is written to `$OPENPALM_STATE_HOME/.env` as `ADMIN_TOKEN=<token>`.
3. **`install.ts:166-175`** — Token is printed to the terminal with a banner: `YOUR ADMIN PASSWORD (save this!)`.
4. **`install.ts:423-426`** — If startup is healthy, token is printed *again* at the bottom of terminal output.
5. **`config.ts:17`** — Admin service reads `ADMIN_TOKEN` from its environment at process startup. It is a module-level constant — `export const ADMIN_TOKEN = env.ADMIN_TOKEN ?? 'change-me-admin-token'` — frozen for the lifetime of the process.
6. **`auth.ts:16-20`** — `verifyAdminToken()` does a constant-time HMAC comparison of the submitted token against this frozen value. If `ADMIN_TOKEN` equals the default insecure token it always returns `false`.
7. **`hooks.server.ts:25-26`** — Auth is checked from the `x-admin-token` header *only* — no cookie, no session. `event.locals.authenticated = verifyAdminToken(token)`.
8. **`auth.svelte.ts:5`** — Token is stored in the browser's `localStorage` under key `'op_admin'`.
9. **`api.ts:11-16`** — Every API call reads the token from the store and injects it as `x-admin-token`.
10. **`SecurityStep.svelte:20-28`** — The wizard's Security step tells the user: *"Your admin password was printed in the terminal during installation. Look for the line labeled YOUR ADMIN PASSWORD and paste it below."*
11. **`SetupWizard.svelte:135-138`** — When the user clicks Next on the Security step, `setAdminToken(adminInput.value)` saves whatever they typed into localStorage. **Nothing is verified server-side at this point.**

**The specific problems:**

1. **Terminal scroll-off**: Image pulls during install produce many lines of output. On most terminals the password banner (printed at `install.ts:166-175`) scrolls off the screen before the user can copy it. The second print at `install.ts:423-426` is immediately followed by browser open, which the user's attention shifts to.

2. **No recovery path**: `SecurityStep.svelte:24-27` says: *"If you lost it, you can also find it in the `.env` file"*. Non-technical users do not know what a `.env` file is, where it lives (`$HOME/.local/state/openpalm/.env`), or how to open it in a text editor. There is no `openpalm show-password` command, no recovery UI endpoint.

3. **Silent auth failure**: If the user pastes the wrong value (or pastes nothing), `setAdminToken()` in `SetupWizard.svelte:137` happily stores it in localStorage. The wizard advances to the next step with no error. The first visible failure comes later when an authenticated API call returns 401.

4. **No server-side password validation in the Security step**: `wizardNext()` at `SetupWizard.svelte:135-138` does **not** verify the token against the server before advancing. It just stores whatever was typed.

5. **The user cannot choose their own password**: The token is a random 64-character machine-generated string. Non-technical users are accustomed to choosing their own passwords. Asking them to copy-paste a long opaque string from a terminal into a browser field is a jarring, fragile experience.

6. **Password cannot be changed through the UI**: There is no admin API endpoint, no CLI command, and no UI control for updating `ADMIN_TOKEN`. The only way to change it is to manually edit `$OPENPALM_STATE_HOME/.env` and restart the admin container.

**Recommended fix — move password creation to the Profile step:**

The Profile step (`packages/ui/src/lib/components/ProfileStep.svelte`) currently collects only name and email. This is the natural place to also collect a user-chosen password. Combining these three fields under "Tell OpenPalm who is running this workspace" is idiomatic and matches how most self-hosted tools (Gitea, Nextcloud, Grafana) handle first-run setup.

**Changes required:**

**A. `packages/ui/src/lib/components/ProfileStep.svelte`** — Add password fields below the email field:

```svelte
<label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-password">
  Admin Password
</label>
<input
  id="wiz-profile-password"
  type="password"
  placeholder="Choose a password (min 8 characters)"
  autocomplete="new-password"
/>

<label style="display:block; margin:0.6rem 0 0.2rem" for="wiz-profile-password2">
  Confirm Password
</label>
<input
  id="wiz-profile-password2"
  type="password"
  placeholder="Repeat password"
  autocomplete="new-password"
/>
```

**B. `packages/ui/src/lib/components/SetupWizard.svelte:64-80`** — In `wizardNext()`, extend the `profile` block to validate and send the password:

```typescript
if (currentStepName === 'profile') {
  const name = (document.getElementById('wiz-profile-name') as HTMLInputElement)?.value || '';
  const email = (document.getElementById('wiz-profile-email') as HTMLInputElement)?.value || '';
  const password = (document.getElementById('wiz-profile-password') as HTMLInputElement)?.value || '';
  const password2 = (document.getElementById('wiz-profile-password2') as HTMLInputElement)?.value || '';

  if (password.length < 8) {
    stepError = 'Password must be at least 8 characters.';
    return;
  }
  if (password !== password2) {
    stepError = 'Passwords do not match.';
    return;
  }

  const profileResult = await api('/command', {
    method: 'POST',
    body: JSON.stringify({
      type: 'setup.profile',
      payload: { name, email, password }  // add password
    })
  });
  if (!profileResult.ok) {
    stepError = 'Could not save your profile. Please try again.';
    return;
  }
  // Save the chosen password to localStorage so subsequent API calls are authenticated
  setAdminToken(password);
}
```

**C. `packages/ui/src/routes/command/+server.ts:205-226`** — In the `setup.profile` handler, accept and persist the password:

```typescript
if (type === 'setup.profile') {
  const name = sanitizeEnvScalar(payload.name);
  const email = sanitizeEnvScalar(payload.email);
  const password = typeof payload.password === 'string' ? payload.password.trim() : '';

  updateDataEnv({
    OPENPALM_PROFILE_NAME: name || undefined,
    OPENPALM_PROFILE_EMAIL: email || undefined
  });

  // Persist new admin password to the state .env so it takes effect on next admin restart
  if (password.length >= 8) {
    await upsertEnvVar(RUNTIME_ENV_PATH, 'ADMIN_TOKEN', password);
    // Note: the running process's ADMIN_TOKEN constant is frozen at startup.
    // The new password takes effect when the admin container is restarted
    // by setup.complete → composeAction('up', 'admin').
  }

  const state = setupManager.setProfile({ name, email });
  // ...rest of handler unchanged
}
```

This requires importing `upsertEnvVar` from `@openpalm/lib/env` and `RUNTIME_ENV_PATH` from `$lib/server/config` in the command handler.

**D. `packages/ui/src/lib/components/SecurityStep.svelte`** — Remove the password paste section entirely. Keep only the security features summary (HMAC verification, rate limiting, etc.) as informational content. Alternatively, remove the Security step from the wizard entirely if the features list is better placed in a help/about page. The step reference is in `SetupWizard.svelte:21-30` (`STEPS` array) and `SetupWizard.svelte:225` (the conditional render).

**E. `packages/cli/src/commands/install.ts:165-175`** — Remove or soften the password display banner. Since the user will set their own password in the wizard, the auto-generated `ADMIN_TOKEN` in `.env` is now just a temporary initial value that gets replaced during setup. The terminal output can instead say: *"Setup wizard is ready — you will create your password in the browser."*

**Why the timing works:** During the initial setup wizard, all `setup.*` commands in `command/+server.ts:106-112` bypass authentication when `setupState.completed === false && isLocalRequest(request)`. So the profile command can update the `.env` file without needing the old token. When `setup.complete` fires at `command/+server.ts:288-298`, it calls `composeAction('up', [...SetupCoreServices])` which recreates the admin container with the new `ADMIN_TOKEN` from `.env`. The user's chosen password is already stored in `localStorage` (set in step B above), so they are seamlessly authenticated after the restart.

**F. Add a post-setup password change command** — Add a `secret.set_admin_password` command (authenticated, post-setup) that: validates the new password, writes it to `.env` via `upsertEnvVar`, and restarts the admin container. This gives users a supported path to change their password later without editing files.

---

#### ISSUE-3: Setup Wizard Allows Skipping Required Steps (Severity: HIGH)

The AI Provider step (`serviceInstances`) does not validate that the user has entered an Anthropic API key before advancing. The `Next` button in `SetupWizard.svelte` calls `wizardNext()` which at lines `82-133` sends whatever was entered (including empty strings) directly to the server. If a user skips this, the assistant container starts without `ANTHROPIC_API_KEY` and every chat request fails silently.

**Exact locations:**
- `packages/ui/src/lib/components/SetupWizard.svelte:95-96` — `anthropicApiKey` read from `#wiz-anthropic-key`, sent as-is with no length check.
- `packages/ui/src/lib/components/SetupWizard.svelte:113-115` — `if (anthropicApiKey.trim()) servicePayload.anthropicApiKey = anthropicApiKey.trim()` — silently omits the key rather than blocking.
- `packages/ui/src/lib/components/ProvidersStep.svelte:39` — `state?.anthropicKeyConfigured` is available in reactive state but never used to gate the Next button.
- `packages/ui/src/routes/command/+server.ts:246-248` — Server accepts the payload even without an Anthropic key.

**Recommendation:** In `wizardNext()` at `SetupWizard.svelte:82`, add:

```typescript
if (currentStepName === 'serviceInstances') {
  const anthropicApiKey = (document.getElementById('wiz-anthropic-key') as HTMLInputElement)?.value.trim();
  const alreadyConfigured = getSetupState()?.anthropicKeyConfigured;
  if (!anthropicApiKey && !alreadyConfigured) {
    stepError = 'An Anthropic API key is required. Get one free at console.anthropic.com.';
    return;
  }
  // ... rest of existing handler
}
```

---

#### ISSUE-4: Port 80 Conflict Has No Resolution Path (Severity: MEDIUM)

The preflight check at `packages/lib/src/preflight.ts:46-82` warns if port 80 is occupied, but the install proceeds anyway and silently fails when Caddy cannot bind. The minimal compose written at `install.ts:286-287` binds `${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80` — if port 80 is taken, Caddy exits immediately and the health check loop at `install.ts:377-389` times out with no useful diagnosis.

**Recommendation:**
- Elevate the port 80 preflight warning to a fatal error.
- Add a `--port` flag to `install.ts` and thread it through to `OPENPALM_INGRESS_PORT` env var and the Caddy config. Stack generator at `packages/lib/src/admin/stack-generator.ts` would need to parameterize the `listen` directive.

---

#### ISSUE-5: npx/bunx Alternative Install Not Tested (Severity: LOW)

The README mentions `npx openpalm install` as an alternative. The npm package contains CLI TypeScript source, not a compiled binary. The `npx` path requires Bun to be installed, which is not a standard prerequisite for most users.

**Recommendation:** Remove the `npx`/`bunx` alternative from user-facing documentation for v1. Keep the binary installer (`install.sh` / `install.ps1`) as the only documented path.

---

## Requirement 2: Chat with Assistant in Browser

### What Works

- **OpenCode web interface**: The assistant container runs `opencode web --hostname 0.0.0.0 --port 4096` which serves the full OpenCode web chat interface.
- **Caddy direct proxy**: `packages/lib/src/admin/stack-generator.ts` generates a Caddy route at `/services/opencode*` that strips the prefix and reverse-proxies to `assistant:4096`. Caddy handles WebSocket and SSE natively with no timeout.
- **Admin dashboard QuickLinks**: `packages/ui/src/lib/components/QuickLinks.svelte` shows an "Open OpenCode" card.

### Issues Found

---

#### ISSUE-6: "Open OpenCode" Link Is Broken — Authentication Mismatch (Severity: BLOCKER)

This is the most critical functional defect. The "Open OpenCode" link in `QuickLinks.svelte:5` is:

```typescript
const assistantUrl = `${base}/opencode/`;
```

This routes to the SvelteKit proxy at `packages/ui/src/routes/opencode/[...path]/+server.ts`. Line 18 of that file immediately checks:

```typescript
if (!locals.authenticated) return unauthorizedJson();
```

`locals.authenticated` is set by `hooks.server.ts:26`:

```typescript
const token = event.request.headers.get('x-admin-token') ?? '';
event.locals.authenticated = verifyAdminToken(token);
```

**The problem:** When the user clicks the "Open OpenCode" link it opens in a new browser tab (`target="_blank"` at `QuickLinks.svelte:12`). The browser sends a plain GET request with no `x-admin-token` header — browsers never attach custom headers to link navigations. `locals.authenticated` is `false`. The proxy returns a 401 JSON error. The user sees a blank page or JSON error, never the chat interface.

The working Caddy route at `/services/opencode*` (generated by `stack-generator.ts`) requires no admin token — it is already LAN-restricted by IP guard — but it is not used anywhere in the UI.

**Recommended fix (Option A — simplest, correct for v1):**

Change `QuickLinks.svelte:5` from:
```typescript
const assistantUrl = `${base}/opencode/`;
```
to:
```typescript
const assistantUrl = `/services/opencode/`;
```

This uses the Caddy direct proxy which handles WebSocket, SSE, and long-lived connections natively. The SvelteKit route at `routes/opencode/[...path]/+server.ts` can remain for programmatic API access (where callers can set headers).

**Recommended fix (Option B — more complete, longer-term):**

Add cookie-based session auth alongside the existing header auth. In `hooks.server.ts`:

```typescript
const token = event.request.headers.get('x-admin-token')
  ?? event.cookies.get('op_admin_session')
  ?? '';
event.locals.authenticated = verifyAdminToken(token);
```

Set a `Secure; HttpOnly; SameSite=Strict` cookie when `setAdminToken()` is called. This would make the SvelteKit proxy route work with browser navigation. However, it does not resolve ISSUE-7 below.

---

#### ISSUE-7: SvelteKit Proxy Cannot Handle WebSocket or SSE (Severity: BLOCKER unless Option A in ISSUE-6 is chosen)

`packages/ui/src/routes/opencode/[...path]/+server.ts:23` uses `fetch()` with `AbortSignal.timeout(5000)`:

```typescript
const proxyResp = await fetch(target, {
  method: request.method,
  headers: buildSafeHeaders(request.headers),
  body: ...,
  signal: AbortSignal.timeout(5000),  // kills any response > 5 seconds
});
```

Two compounding problems:
1. SvelteKit server route handlers cannot upgrade HTTP connections to WebSocket.
2. The 5-second timeout aborts virtually every real AI response.

If Option A from ISSUE-6 is adopted (point the link directly at `/services/opencode/` via Caddy), both problems are resolved automatically — Caddy handles WebSocket/SSE natively with no timeout. If the SvelteKit proxy is kept as the primary path, the timeout at minimum must be raised to 300 seconds and a WebSocket upgrade mechanism must be added.

---

#### ISSUE-8: OpenCode Web Interface May Prompt for Separate Authentication (Severity: MEDIUM)

Even after fixing the URL, OpenCode's web UI at `assistant:4096` has its own auth model and may present its own login screen. A user who just completed the setup wizard may be confused by a second authentication prompt from a differently-styled UI.

**Recommendation:** Investigate whether OpenCode web supports auth bypass or pre-configuration via environment variables passed in `core/assistant/Dockerfile` or `core/assistant/extensions/opencode.jsonc`. If not possible, add a clear callout in `CompleteStep.svelte` — for example: *"When the chat window opens, you may be asked to sign in again — this is normal for the OpenCode interface."*

---

## Requirement 3: Failure-Proof UX — Always End with Working Admin UI

### What Works

- **Two-phase install**: `install.ts:275-395` starts only Caddy + Admin first (Phase 2: "Early UI access"), then the setup wizard brings up remaining services. Even if the full stack fails, the admin UI remains accessible.
- **Fallback compose and Caddy configs**: `install.ts:267-271` and `install.ts:330-334` write `caddy-fallback.json` and `docker-compose-fallback.yml` as minimal configs. The stack-apply-engine can roll back to these.
- **Atomic stack apply**: `packages/lib/src/admin/stack-apply-engine.ts` stages artifacts to `.next` temp files, validates, then atomically promotes via rename. Failures mid-apply leave the previous config intact.
- **Self-test on startup**: The admin entrypoint runs `self-test-fallback.js` to validate fallback bundle integrity.
- **Comprehensive health checks**: The admin UI polls real-time health status for Gateway, Assistant, Memory, and Admin via `setup/health-check`.

### Issues Found

---

#### ISSUE-9: Setup Wizard Complete Step Has No Error Handling or Retry (Severity: HIGH)

`finishSetup()` in `SetupWizard.svelte:168-203` makes four sequential API calls with no error handling:

```typescript
await api('/command', { ..., body: JSON.stringify({ type: 'setup.channels', ... }) });
for (const channel of enabledChannels) {
  await api('/command', { ..., body: JSON.stringify({ type: 'service.up', ... }) });
}
await api('/command', { ..., body: JSON.stringify({ type: 'setup.step', ... }) });
await api('/command', { ..., body: JSON.stringify({ type: 'setup.complete', ... }) });
setWizardStep(STEPS.length - 1);  // advances regardless of errors
```

The `setup.complete` handler in `command/+server.ts:288-298` calls `applyStack()` and `composeAction('up', [...SetupCoreServices])`. If compose fails (image pull timeout, port conflict, out of disk space), it throws. The outer try/catch at `command/+server.ts:603-605` returns a 400 with `{ ok: false, error: String(error) }`. But `finishSetup()` never checks `profileResult.ok` on any of these calls — it advances to the `CompleteStep` unconditionally.

**Exact location of missing check:** `SetupWizard.svelte:194-203` — the `setup.complete` call result is discarded.

**Recommendation:**

```typescript
async function finishSetup() {
  stepError = '';
  // ... existing channel/service calls ...

  const completeResult = await api('/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'setup.complete', payload: {} })
  });

  if (!completeResult.ok) {
    stepError = completeResult.data?.error?.includes('core_startup_failed')
      ? 'Services failed to start. Check that Docker is running and you have internet access, then click Retry.'
      : `Setup failed: ${completeResult.data?.error ?? 'unknown error'}. Click Retry to try again.`;
    return;  // do not advance wizard
  }

  setWizardStep(STEPS.length - 1);
}
```

Also add a Retry button in `CompleteStep.svelte` and a `degraded` mode: if `setup.complete` fails but the admin UI itself is still responding, mark `completed = true` with a `degraded` flag and land the user on the dashboard where they can use Health Status and logs to diagnose.

---

#### ISSUE-10: CompleteStep Timeout Has No Actionable Guidance (Severity: MEDIUM)

`CompleteStep.svelte:15-31` polls `setup/health-check` up to 120 times at one-second intervals. If services don't come healthy, it sets `statusText = 'Some services are still starting. You can continue anyway.'` and shows a secondary Continue button.

The health-check response from `setup/health-check/+server.ts:34-43` includes per-service status objects (`gateway`, `assistant`, `openmemory`, `admin`) but `CompleteStep.svelte:19-22` only checks `allOk` — individual service status is never displayed.

**Recommendation:** Change `CompleteStep.svelte` to display which specific services are not healthy on timeout:

```svelte
{#if timedOut}
  <p>Some services took too long to start:</p>
  <ul>
    {#each Object.entries(serviceStatus) as [name, s]}
      {#if !s.ok}
        <li style="color:var(--red)">{name} — not ready</li>
      {/if}
    {/each}
  </ul>
  <p class="muted">Check your API key is correct, then run <code>openpalm logs</code> for details.</p>
{/if}
```

---

#### ISSUE-11: No Admin UI Access if Caddy Fails to Start (Severity: MEDIUM)

If port 80 is occupied and Caddy exits, the health check loop at `install.ts:377-389` times out and the user sees: *"Setup did not come online within 3 minutes"*. The admin service at port 8100 is running and healthy, but the user has no way to reach it because all traffic goes through Caddy.

**Location:** The minimal compose at `install.ts:281-327` does not expose port 8100 on the host. Admin's `healthcheck` at `install.ts:317-322` tests `http://localhost:8100/health` from inside the container, which passes — but the host cannot reach it.

**Recommendation:** Add a direct host port mapping for admin in the minimal compose:

```yaml
admin:
  ports:
    - "127.0.0.1:8100:8100"  # direct bypass if Caddy fails
```

Also add to the failure message at `install.ts:441-456`:
```
  5. If the browser doesn't open automatically, try the direct admin URL:
     http://localhost:8100
```

---

#### ISSUE-12: Minimal Compose Declares Unused `channel_net` Network (Severity: LOW)

The minimal compose written at `install.ts:324-326` declares `channel_net` but no service uses it. Some Docker Compose versions emit a warning for declared but unused networks.

**Location:** `packages/cli/src/commands/install.ts:324-326`

**Recommendation:** Remove the `channel_net` entry from the minimal compose string. It is only needed in the full stack compose generated by `stack-generator.ts`.

---

## Additional Findings

---

### ISSUE-13: CORS Hardcoded to `http://localhost` Breaks LAN Access (Severity: MEDIUM)

`packages/ui/src/hooks.server.ts:5`:

```typescript
const ALLOWED_ORIGIN = 'http://localhost';
```

This constant is applied to every response at `hooks.server.ts:32` and every OPTIONS preflight at `hooks.server.ts:16`. When a user on the same network accesses the admin UI via IP address (e.g., `http://192.168.1.50`), their browser sends `Origin: http://192.168.1.50`. The response returns `Access-Control-Allow-Origin: http://localhost`, which does not match, causing browser CORS enforcement to block all API calls. **This breaks the LAN access scope feature entirely.**

The access scope is available in memory via `setupManager.getState().accessScope` (already used in `stack-generator.ts:84-86` for Caddy IP guards). The same information should drive CORS.

**Recommendation:** Replace the hardcoded constant with a dynamic origin check in `hooks.server.ts`:

```typescript
import { getSetupManager } from '$lib/server/init';

export const handle: Handle = async ({ event, resolve }) => {
  await ensureInitialized();

  const setupManager = await getSetupManager();
  const { accessScope } = setupManager.getState();
  const requestOrigin = event.request.headers.get('origin') ?? '';

  const allowedOrigin = computeAllowedOrigin(accessScope, requestOrigin);
  // ...
};

function computeAllowedOrigin(scope: string, requestOrigin: string): string {
  if (scope === 'public') return requestOrigin || '*';
  if (scope === 'lan') {
    // Reflect the origin if it is a private IP, otherwise fall back to localhost
    if (isPrivateOrigin(requestOrigin)) return requestOrigin;
    return 'http://localhost';
  }
  return 'http://localhost';  // host scope — localhost only
}

function isPrivateOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === '::1'
    );
  } catch { return false; }
}
```

---

### ISSUE-14: Channel Config Fields Show Raw Env Var Names (Severity: MEDIUM)

In `packages/ui/src/lib/components/ChannelsStep.svelte:79-89`, credential fields are labeled using the raw `field.key` value (which is the env var name, e.g. `DISCORD_BOT_TOKEN`):

```svelte
<label style="display:block;margin:0.4rem 0 0.2rem;font-size:13px">
  {field.key}{field.required ? ' *' : ''}
</label>
```

The `field.helpText` property (mapped from `e.description` in the channel YAML at `ChannelsStep.svelte:38`) is used only as `placeholder` on the input, not as the label.

**Recommendation:** Change the label to use `field.helpText` when available, falling back to a humanized version of the env var name:

```typescript
function humanizeKey(key: string): string {
  return key
    .replace(/^[A-Z]+_/, '')      // strip channel prefix e.g. DISCORD_
    .split('_')
    .map(w => w[0] + w.slice(1).toLowerCase())
    .join(' ');
}
```

```svelte
<label ...>
  {field.helpText || humanizeKey(field.key)}{field.required ? ' *' : ''}
</label>
```

---

### ISSUE-15: OpenMemory Images Not Version-Pinned (Severity: MEDIUM)

`packages/lib/src/embedded/state/docker-compose.yml:49` and `:70` use `mem0/openmemory-mcp:latest` and `mem0/openmemory-ui:latest` with a `# TODO: pin version` comment. Using `latest` makes installs non-reproducible and vulnerable to upstream breaking changes.

**Recommendation:** Pin to specific tested versions before v1. Update `docker-compose.yml` and the fallback at `packages/lib/src/embedded/state/docker-compose-fallback.yml`. Add a comment with the date pinned to make future upgrades deliberate.

---

### ISSUE-16: No Telemetry or Error Reporting for Install Failures (Severity: LOW)

When install fails (image pull timeout, compose error, disk full), there is no mechanism for the team to learn about failure patterns.

**Recommendation:** Add opt-in anonymous telemetry for install success/failure with clear disclosure and easy opt-out (`openpalm install --no-telemetry`). At minimum, add a "Report Issue" link in all error output blocks in `install.ts` that pre-fills a GitHub issue template with OS, arch, runtime, and error message.

---

### ISSUE-17: No Uninstall Path from Admin UI (Severity: LOW)

The admin dashboard has no uninstall option. Users must know to run `openpalm uninstall` from a terminal.

**Recommendation:** Add a "Danger Zone" section in the admin settings page with an Uninstall button that calls a CLI-backed endpoint. At minimum, add a link to the uninstall documentation.

---

## Test Coverage Summary

| Category | Status |
|---|---|
| Unit tests | 576 pass, 0 fail, 27 skip |
| TypeScript typecheck | Clean (0 errors) |
| UI build (SvelteKit) | Successful |
| CLI binary build | Working (`openpalm v0.3.4`) |
| Docker images (Docker Hub) | Published: admin, assistant, gateway, channel-chat, channel-discord, etc. (amd64 + arm64) |
| GitHub Release binaries | Published for linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64 |
| npm package | Published at v0.3.4 |
| E2E Playwright tests | Written (10 test files) but require running stack |
| Contract tests | Written but require running stack |

---

## Priority Matrix for v1 Release

### Must Fix (Blockers)

| Issue | Summary | Key Files | Effort |
|---|---|---|---|
| ISSUE-6 | "Open OpenCode" link broken — auth mismatch | `QuickLinks.svelte:5` | XS — change one URL |
| ISSUE-7 | SvelteKit proxy can't handle WebSocket/SSE | `routes/opencode/[...path]/+server.ts:27` | Resolved by ISSUE-6 fix |
| ISSUE-3 | Wizard allows skipping Anthropic API key | `SetupWizard.svelte:95-96` | S — add one validation check |

### Should Fix (High Priority)

| Issue | Summary | Key Files | Effort |
|---|---|---|---|
| ISSUE-2 | Admin password UX is fundamentally broken | `ProfileStep.svelte`, `SetupWizard.svelte:64-80`, `command/+server.ts:205-226`, `SecurityStep.svelte`, `install.ts:166-175` | M — touches 5 files but changes are clearly scoped |
| ISSUE-9 | Setup complete has no error handling or retry | `SetupWizard.svelte:168-203`, `command/+server.ts:288-298` | M — add error checks and retry UI |
| ISSUE-13 | CORS hardcoded to localhost breaks LAN access | `hooks.server.ts:5,32` | S — replace constant with dynamic logic |

### Nice to Have (Medium Priority)

| Issue | Summary | Key Files | Effort |
|---|---|---|---|
| ISSUE-4 | Port 80 conflict has no resolution path | `preflight.ts:46-82`, `install.ts:286-287` | M |
| ISSUE-8 | OpenCode web may need separate auth | `core/assistant/Dockerfile`, `CompleteStep.svelte` | Investigation needed |
| ISSUE-10 | Complete step timeout has no per-service details | `CompleteStep.svelte:15-31` | S |
| ISSUE-11 | No admin UI access if Caddy fails | `install.ts:281-327, 441-456` | S |
| ISSUE-14 | Channel config fields show raw env var names | `ChannelsStep.svelte:79-89` | S |
| ISSUE-15 | OpenMemory images not version-pinned | `docker-compose.yml:49,70` | S |

### Post-v1

| Issue | Summary |
|---|---|
| ISSUE-5 | Remove npx/bunx install path from docs |
| ISSUE-12 | Remove unused `channel_net` from minimal compose |
| ISSUE-16 | Install telemetry |
| ISSUE-17 | Uninstall from admin UI |

---

## Recommended v1 Release Checklist

1. **Fix ISSUE-6**: Change `QuickLinks.svelte:5` — `assistantUrl` from `${base}/opencode/` to `/services/opencode/`
2. **Fix ISSUE-3**: Add Anthropic API key validation guard in `SetupWizard.svelte` before advancing the `serviceInstances` step
3. **Fix ISSUE-13**: Replace hardcoded `ALLOWED_ORIGIN` in `hooks.server.ts` with dynamic origin based on `accessScope`
4. **Fix ISSUE-2**: Move password creation into the Profile step — add fields to `ProfileStep.svelte`, handle in `setup.profile` command, remove password-paste section from `SecurityStep.svelte`, call `setAdminToken()` client-side after save
5. **Fix ISSUE-9**: Add error handling and retry to `finishSetup()` in `SetupWizard.svelte`
6. **Pin OpenMemory image versions** (ISSUE-15) in `docker-compose.yml` and `docker-compose-fallback.yml`
7. **Manual smoke test**: Full install → setup → chat flow on macOS, Linux, and Windows

---

## Architecture Strengths

The following architectural decisions are well-executed and should be preserved:

1. **Two-phase install** (`install.ts:275-395`) — Caddy + Admin first, then full stack via wizard — ensures admin UI access even during partial failures
2. **Atomic stack apply** with staged `.next` artifacts and automatic rollback on failure
3. **Fallback bundle** (`caddy-fallback.json` + `docker-compose-fallback.yml`) as last-resort recovery
4. **LAN-restricted access** with Caddy IP guards (`stack-generator.ts:84-102`) and configurable scope
5. **Cryptographic HMAC verification** (`packages/lib/src/shared/crypto.ts`) for all channel messages, using timing-safe comparison
6. **Secret detection** in `core/assistant/extensions/plugins/policy-and-telemetry.ts` prevents credentials from being stored in memory
7. **Comprehensive health check** infrastructure across all services, polled by both the wizard and the admin dashboard
8. **Clean separation of concerns**: CLI (install/manage) → Admin (control plane) → Gateway (message routing) → Assistant (AI runtime) → Channels (adapters)
9. **Constant-time admin token comparison** (`auth.ts:10-13`) using HMAC to prevent timing side-channel attacks
10. **Setup endpoint IP restriction** (`auth.ts:38-64`, used in every setup route) — unauthenticated setup calls are restricted to local/private IPs, preventing remote exploitation of the unauthenticated setup window
