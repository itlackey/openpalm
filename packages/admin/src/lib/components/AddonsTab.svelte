<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchAddons, toggleAddon } from '$lib/api.js';
  import { getAdminToken } from '$lib/auth.js';

  interface Props {
    onAuthError: () => void;
  }

  let { onAuthError }: Props = $props();

  type AddonEntry = { name: string; enabled: boolean; available: boolean };

  let addons = $state<AddonEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null);

  async function loadAddons(): Promise<void> {
    const token = getAdminToken();
    if (!token) { onAuthError(); return; }
    loading = true;
    error = '';
    try {
      addons = await fetchAddons(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    const token = getAdminToken();
    if (!token) { onAuthError(); return; }
    actionLoading = name;
    try {
      await toggleAddon(token, name, enabled);
      await loadAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      actionLoading = null;
    }
  }

  onMount(() => { void loadAddons(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Addons</h2>
      <p class="panel-subtitle">Catalog lives in <code>registry/addons/</code>. Put addon values in <code>vault/user/user.env</code>.</p>
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

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
