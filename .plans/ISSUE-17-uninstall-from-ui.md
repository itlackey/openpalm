# ISSUE-17: No Uninstall Path from Admin UI

**Severity:** LOW  
**Priority:** Post-v1  
**Effort:** M — add settings page, API endpoint, and UI component

## Problem Summary

The admin dashboard has no uninstall option. Users must know to run `openpalm uninstall` from a terminal. Non-technical users who installed via the one-click installer have no discoverable way to remove OpenPalm.

## Implementation Steps

### Step 1: Add an uninstall documentation link as minimum viable change

**File:** `packages/ui/src/lib/components/QuickLinks.svelte`

As the simplest possible fix, add a help link to the QuickLinks section. After the existing cards (after line 25), add:

```svelte
<a class="card" href="https://github.com/itlackey/openpalm/blob/main/docs/maintenance.md#uninstalling" target="_blank" rel="noopener">
  <strong>Uninstall Guide</strong>
  <p class="muted">How to remove OpenPalm from your system</p>
</a>
```

This gives users a discoverable path without any backend changes.

### Step 2: (Post-v1) Add an admin API endpoint for uninstall

**File:** `packages/ui/src/routes/command/+server.ts`

Add a new authenticated command handler `system.uninstall`:

```typescript
if (type === 'system.uninstall') {
  // Require explicit confirmation token to prevent accidental uninstalls
  if (payload.confirm !== 'UNINSTALL') {
    return json(400, { ok: false, error: 'Confirmation required. Send confirm: "UNINSTALL"' });
  }

  try {
    // Stop all services
    await composeAction('down');
    return json(200, { ok: true, message: 'All services stopped. Run "openpalm uninstall" from terminal to remove data.' });
  } catch (err) {
    return json(500, { ok: false, error: String(err) });
  }
}
```

Note: Full uninstall (removing data directories, .env files, compose files) should NOT be done from within a running container — the admin service would be deleting its own state. The API endpoint can stop all services, but data removal must be done from the host CLI.

### Step 3: (Post-v1) Add a Danger Zone section in the admin UI

**File:** New route or component in `packages/ui/`

Create a settings page (if one doesn't exist) or add to the dashboard. The UI would:

1. Show a "Danger Zone" section with a red border
2. Include a "Stop All Services" button (calls `compose down`)
3. Include uninstall instructions: "To fully remove OpenPalm and all data, run `openpalm uninstall` in your terminal"
4. Include a confirmation dialog before the stop action

### Step 4: (Post-v1) Add a link to the settings/danger zone from the dashboard

**File:** `packages/ui/src/lib/components/QuickLinks.svelte` or navigation

Add navigation to the settings page from the main dashboard.

## Files Changed

| File | Change |
|---|---|
| `packages/ui/src/lib/components/QuickLinks.svelte` | Add uninstall documentation link (minimum viable) |
| `packages/ui/src/routes/command/+server.ts` | (Post-v1) Add `system.uninstall` command handler |

## Testing

1. Run `bun test` — ensure no regressions
2. Manual test: verify the "Uninstall Guide" link appears in QuickLinks and opens the correct documentation page
3. (Post-v1) Verify: `system.uninstall` requires authentication
4. (Post-v1) Verify: `system.uninstall` requires the `confirm: "UNINSTALL"` payload
5. (Post-v1) Verify: the endpoint stops containers but does not delete data directories

## Dependencies

None — standalone feature. The minimum viable change (Step 1) has no dependencies.

## Design Decision

Full uninstall cannot be performed from within the admin container because:
1. The admin container is a service being managed — it can't delete itself
2. Host-level file deletion requires host-level access (not available from within Docker)
3. The `openpalm uninstall` CLI command runs on the host and can properly clean up

The admin UI should therefore provide a "soft uninstall" (stop services) and direct users to the CLI for full removal.
