# ISSUE-8: OpenCode Web Interface May Prompt for Separate Authentication

**Severity:** MEDIUM  
**Priority:** Nice to Have  
**Effort:** S — investigation + small config or UI change

## Problem Summary

After ISSUE-6 redirects users to `/services/opencode/` (Caddy proxy to `assistant:4096`), OpenCode's web UI may present its own login screen. A user who just completed the setup wizard would be confused by a second authentication prompt from a differently-styled UI.

## Investigation Findings

OpenCode web (`opencode-ai` npm package, v1.2.10) serves a web interface at `opencode web --hostname 0.0.0.0 --port 4096`. The relevant files:

- `core/assistant/Dockerfile:4` — installs `opencode-ai@${OPENCODE_VERSION}` globally via bun
- `core/assistant/entrypoint.sh:25` — runs `opencode web --hostname 0.0.0.0 --port "$PORT" --print-logs`
- `core/assistant/extensions/opencode.jsonc` — OpenCode configuration (model, provider, plugins)

OpenCode's web UI authentication is controlled by the `auth` config key in its JSON config. When no `auth` key is set, OpenCode defaults to requiring GitHub OAuth or a token for web access.

## Implementation Steps

### Step 1: Investigate OpenCode auth configuration options

**File:** `core/assistant/extensions/opencode.jsonc`

Check the OpenCode docs/schema at `https://opencode.ai/config.json` for auth-related config keys. The config file currently has no `auth` section. OpenCode supports:
- `"auth": false` or `"auth": { "enabled": false }` — disables auth entirely
- Environment variable `OPENCODE_AUTH=false` — disables auth at runtime

Since the assistant container is already LAN-restricted by Caddy IP guards (stack-generator.ts), disabling OpenCode's own auth is acceptable for the v1 deployment model.

### Step 2: Disable OpenCode web auth via environment variable

**File:** `packages/lib/src/embedded/state/docker-compose.yml:88-89`

Add `OPENCODE_AUTH=false` to the assistant service environment block. Currently the environment section starts at line 88. Add the new variable:

```yaml
assistant:
  environment:
    - OPENCODE_CONFIG_DIR=/opt/opencode
    - OPENCODE_PORT=4096
    - OPENCODE_AUTH=false
    - OPENCODE_ENABLE_SSH=${OPENCODE_ENABLE_SSH:-0}
    # ... rest unchanged
```

### Step 3: Also update the opencode.jsonc config (belt and suspenders)

**File:** `core/assistant/extensions/opencode.jsonc`

Add auth configuration alongside the existing config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "auth": false,
  "model": "anthropic/claude-sonnet-4-5",
  // ... rest unchanged
}
```

### Step 4: Fallback — Add a guidance callout in CompleteStep.svelte

**File:** `packages/ui/src/lib/components/CompleteStep.svelte`

If disabling auth via config is not possible or not reliable across OpenCode versions, add a note after the "Everything is ready!" message:

After line 23 (where `statusText = 'Everything is ready!'`), add logic to show a note when ready:

```svelte
{#if ready}
  <p class="muted" style="font-size:13px; margin-top:0.5rem">
    When the chat window opens, you may need to allow browser access if prompted.
  </p>
  <button onclick={oncontinue}>Continue to Admin</button>
{:else if timedOut}
```

This is a defensive fallback only needed if Steps 2-3 don't fully suppress the auth prompt.

### Step 5: Verify behavior

Manual testing required:
1. Start the full stack via setup wizard
2. Click "Open OpenCode" from admin dashboard
3. Verify the chat interface loads directly without an auth prompt
4. If an auth screen still appears, check OpenCode logs: `docker compose logs assistant`

## Files Changed

| File | Change |
|---|---|
| `packages/lib/src/embedded/state/docker-compose.yml` | Add `OPENCODE_AUTH=false` to assistant environment |
| `core/assistant/extensions/opencode.jsonc` | Add `"auth": false` config key |
| `packages/ui/src/lib/components/CompleteStep.svelte` | (Fallback) Add guidance note about possible auth prompt |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: full install → setup → click "Open OpenCode" → verify no auth prompt
3. Verify OpenCode web still functions correctly with auth disabled (chat works, file editing works)
4. Verify Caddy IP guard still restricts access appropriately (auth disabled is safe because network-level protection exists)

## Dependencies

- ISSUE-6 must be fixed first (the link must point to `/services/opencode/` for this to matter)
