<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAddons,
    toggleAddon,
    fetchAddonCredentials,
    saveAddonCredentials,
    type AddonCredentialField,
  } from '$lib/api.js';

  interface Props {
    onAuthError: () => void;
  }

  let { onAuthError }: Props = $props();

  type AddonEntry = { name: string; enabled: boolean; available: boolean };

  let addons = $state<AddonEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null);

  // Per-addon credentials editor state (lazy — populated when expanded).
  let expanded = $state<string | null>(null);
  let credFields = $state<Record<string, AddonCredentialField[]>>({});
  let credValues = $state<Record<string, Record<string, string>>>({});
  let credLoading = $state<string | null>(null);
  let credSaving = $state<string | null>(null);
  let credMessage = $state<{ addon: string; type: 'ok' | 'err'; text: string } | null>(null);

  async function loadAddons(): Promise<void> {
    loading = true;
    error = '';
    try {
      addons = await fetchAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    actionLoading = name;
    try {
      await toggleAddon(name, enabled);
      await loadAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      actionLoading = null;
    }
  }

  async function toggleExpanded(name: string): Promise<void> {
    if (expanded === name) {
      expanded = null;
      return;
    }
    expanded = name;
    credMessage = null;
    if (!credFields[name]) {
      credLoading = name;
      try {
        const fields = await fetchAddonCredentials(name);
        credFields[name] = fields;
        const seed: Record<string, string> = {};
        for (const f of fields) seed[f.key] = f.sensitive ? '' : f.value;
        credValues[name] = seed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
        credMessage = { addon: name, type: 'err', text: `Could not load credentials: ${msg}` };
      } finally {
        credLoading = null;
      }
    }
  }

  async function saveCredentials(name: string): Promise<void> {
    credSaving = name;
    credMessage = null;
    try {
      // Drop empty values for sensitive fields (user didn't change them);
      // leave non-sensitive empties so the user can clear a value.
      const fields = credFields[name] ?? [];
      const sensitiveKeys = new Set(fields.filter((f) => f.sensitive).map((f) => f.key));
      const submitted: Record<string, string> = {};
      const current = credValues[name] ?? {};
      for (const [k, v] of Object.entries(current)) {
        if (sensitiveKeys.has(k) && v === '') continue;
        submitted[k] = v;
      }
      if (Object.keys(submitted).length === 0) {
        credMessage = { addon: name, type: 'err', text: 'Nothing to save.' };
        return;
      }
      const { updated } = await saveAddonCredentials(name, submitted);
      credMessage = { addon: name, type: 'ok', text: `Saved ${updated.length} field(s). Recreate the addon container to apply.` };
      // Re-fetch to refresh `set` flags
      const fresh = await fetchAddonCredentials(name);
      credFields[name] = fresh;
      const reset = { ...current };
      for (const f of fresh) if (f.sensitive) reset[f.key] = '';
      credValues[name] = reset;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      credMessage = { addon: name, type: 'err', text: `Save failed: ${msg}` };
    } finally {
      credSaving = null;
    }
  }

  onMount(() => { void loadAddons(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Addons</h2>
      <p class="panel-subtitle">Catalog lives in <code>state/registry/addons/</code>. Put addon values in <code>stash/vaults/user.env</code>.</p>
    </div>
    <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()} disabled={loading}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body panel-body--flush">
    {#if loading && addons.length === 0}
      <div class="loading-state">
        <span class="spinner"></span>
        <span>Loading addons...</span>
      </div>
    {:else if error}
      <div class="error-state">
        <span>{error}</span>
        <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()}>Retry</button>
      </div>
    {:else if addons.length === 0}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
        <p>No addons found in registry/addons/.</p>
      </div>
    {:else}
      <div class="addon-table">
        <div class="addon-table-header">
          <span class="addon-col addon-col--name">Addon</span>
          <span class="addon-col addon-col--status">Status</span>
          <span class="addon-col addon-col--actions"></span>
        </div>
        {#each addons as addon (addon.name)}
          <div class="addon-row">
            <span class="addon-col addon-col--name addon-name">{addon.name}</span>
            <span class="addon-col addon-col--status">
              <span class="badge" class:badge-enabled={addon.enabled} class:badge-disabled={!addon.enabled}>
                {addon.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <span class="addon-col addon-col--actions">
              <button
                class="btn btn-sm btn-ghost"
                onclick={() => void toggleExpanded(addon.name)}
                disabled={!addon.available}
                aria-expanded={expanded === addon.name}
              >
                {expanded === addon.name ? 'Hide' : 'Configure'}
              </button>
              <button
                class="btn btn-sm"
                class:btn-danger={addon.enabled}
                class:btn-outline={!addon.enabled}
                disabled={actionLoading === addon.name || !addon.available}
                onclick={() => toggle(addon.name, !addon.enabled)}
              >
                {#if actionLoading === addon.name}
                  <span class="spinner"></span>
                {:else}
                  {addon.enabled ? 'Disable' : 'Enable'}
                {/if}
              </button>
            </span>
          </div>
          {#if expanded === addon.name}
            <div class="addon-creds">
              {#if credLoading === addon.name}
                <div class="creds-loading"><span class="spinner"></span> Loading credentials...</div>
              {:else if (credFields[addon.name]?.length ?? 0) === 0}
                <p class="creds-empty">This addon has no configurable env vars (compose overlay only).</p>
              {:else}
                <p class="creds-hint">Values are written to <code>config/stack/stack.env</code> and read by the addon container on next recreate.</p>
                {#each credFields[addon.name] ?? [] as field (field.key)}
                  <div class="creds-row">
                    <label class="creds-label" for="cred-{addon.name}-{field.key}">
                      <code>{field.key}</code>
                      {#if field.sensitive}<span class="creds-tag">sensitive</span>{/if}
                      {#if field.sensitive && field.set}<span class="creds-tag creds-tag--set">set</span>{/if}
                    </label>
                    {#if field.description}<p class="creds-desc">{field.description}</p>{/if}
                    <input
                      id="cred-{addon.name}-{field.key}"
                      type={field.sensitive ? 'password' : 'text'}
                      class="form-input"
                      placeholder={field.sensitive ? (field.set ? '••••••• (leave empty to keep current)' : field.default) : field.default}
                      bind:value={credValues[addon.name][field.key]}
                      autocomplete="off"
                    />
                  </div>
                {/each}
                {#if credMessage && credMessage.addon === addon.name}
                  <div class="creds-message" class:creds-message--err={credMessage.type === 'err'} class:creds-message--ok={credMessage.type === 'ok'}>
                    {credMessage.text}
                  </div>
                {/if}
                <div class="creds-actions">
                  <button class="btn btn-primary btn-sm" disabled={credSaving === addon.name} onclick={() => void saveCredentials(addon.name)}>
                    {#if credSaving === addon.name}<span class="spinner"></span>{/if} Save
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h2 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .panel-subtitle {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
  }

  .panel-subtitle code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .panel-body--flush {
    padding: 0;
  }

  /* ── Table ────────────────────────────────────────────────────── */

  .addon-table {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .addon-table-header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-5);
    background: var(--color-bg-tertiary);
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .addon-row {
    display: flex;
    align-items: center;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--color-bg-tertiary);
    transition: background var(--transition-fast);
  }

  .addon-row:last-child {
    border-bottom: none;
  }

  .addon-row:hover {
    background: var(--color-surface-hover);
  }

  .addon-col {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .addon-col--name {
    flex: 3;
    min-width: 0;
  }

  .addon-col--status {
    flex: 1;
    min-width: 0;
  }

  .addon-col--actions {
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  .addon-name {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  /* ── Badge ────────────────────────────────────────────────────── */

  .badge {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    font-weight: var(--font-semibold);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-enabled {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .badge-disabled {
    background: var(--color-bg-tertiary);
    color: var(--color-text-tertiary);
  }

  /* ── States ───────────────────────────────────────────────────── */

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .error-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-10) var(--space-4);
    color: var(--color-text-tertiary);
    text-align: center;
    gap: var(--space-4);
  }

  .empty-state p {
    font-size: var(--text-sm);
  }

  /* ── Buttons ──────────────────────────────────────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .btn-outline {
    background: transparent;
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--color-primary-subtle);
  }

  .btn-danger {
    background: var(--color-danger);
    color: #fff;
    border-color: var(--color-danger);
  }

  .btn-danger:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 768px) {
    .addon-table-header {
      display: none;
    }

    .addon-row {
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .addon-col--status {
      flex: 0 0 auto;
    }
  }

  /* ── Inline credentials editor ───────────────────────────────── */

  .addon-creds {
    padding: var(--space-4) var(--space-5);
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .creds-loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .creds-empty,
  .creds-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin: 0;
  }

  .creds-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .creds-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text);
  }

  .creds-label code {
    font-family: var(--font-mono);
    background: var(--color-bg-tertiary);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .creds-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--color-bg-tertiary);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .creds-tag--set {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .creds-desc {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin: 0;
  }

  .form-input {
    width: 100%;
    height: 32px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-3);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: inherit;
  }
  .form-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }

  .creds-message {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
  }
  .creds-message--ok { background: var(--color-success-bg); color: var(--color-text); }
  .creds-message--err { background: var(--color-danger-bg); color: var(--color-text); }

  .creds-actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
