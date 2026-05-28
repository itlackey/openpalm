<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchUserVault, writeUserVaultKey, deleteUserVaultKey } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';

  interface Props {
    tokenStored: boolean;
  }

  let { tokenStored }: Props = $props();

  let keys = $state<string[]>([]);
  let vaultRef = $state('');
  let available = $state(false);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null); // key being acted on, or 'write' for new
  let deleteConfirmKey = $state<string | null>(null);

  let showWriteForm = $state(false);
  let writeKey = $state('');
  let writeValue = $state('');

  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  async function loadKeys(): Promise<void> {
    loading = true;
    error = '';
    try {
      const result = await fetchUserVault();
      keys = result.keys;
      vaultRef = result.vaultRef;
      available = result.available;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load vault keys.';
    } finally {
      loading = false;
    }
  }

  async function handleWrite(): Promise<void> {
    const k = writeKey.trim();
    if (!k || !writeValue) return;
    if (!KEY_RE.test(k)) {
      notifications.push('error', 'Key must match [A-Za-z_][A-Za-z0-9_]* (env var format).');
      return;
    }
    actionLoading = 'write';
    try {
      await writeUserVaultKey(k, writeValue);
      notifications.push('success', `Saved "${k}" to akm vault. Recreate the assistant container to pick up the new value.`);
      writeKey = '';
      writeValue = '';
      showWriteForm = false;
      await loadKeys();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to write to vault.');
    } finally {
      actionLoading = null;
    }
  }

  function requestDelete(key: string): void {
    deleteConfirmKey = key;
  }

  function cancelDelete(): void {
    deleteConfirmKey = null;
  }

  async function confirmDelete(key: string): Promise<void> {
    deleteConfirmKey = null;
    actionLoading = key;
    try {
      await deleteUserVaultKey(key);
      notifications.push('success', `Removed "${key}".`);
      await loadKeys();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to remove key.');
    } finally {
      actionLoading = null;
    }
  }

  onMount(() => {
    if (tokenStored) void loadKeys();
  });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>User Vault</h2>
      <p class="panel-subtitle">
        User-managed env secrets stored in akm (<code>{vaultRef || 'vault:user'}</code>). Sourced by the assistant
        container at startup — recreate it after changes.
      </p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => { showWriteForm = !showWriteForm; }} disabled={!available}>
        {showWriteForm ? 'Cancel' : 'Add / Update Key'}
      </button>
      <button class="btn btn-secondary btn-sm" onclick={() => void loadKeys()} disabled={loading || !tokenStored}>
        {#if loading}<span class="spinner"></span>{/if}
        Refresh
      </button>
    </div>
  </div>

  {#if !available && !loading && !error}
    <div class="error-banner">
      <span>akm vault is unavailable. Install akm and run <code>akm vault init user</code> to enable user-vault management.</span>
    </div>
  {/if}

  {#if showWriteForm}
    <div class="form-section">
      <h3>Write Key</h3>
      <div class="form-row">
        <div class="form-field">
          <label for="vault-key" class="form-label">Key</label>
          <input id="vault-key" class="form-input" type="text" bind:value={writeKey} placeholder="OPENAI_API_KEY" autocomplete="off" />
        </div>
        <div class="form-field">
          <label for="vault-value" class="form-label">Value</label>
          <input id="vault-value" class="form-input" type="password" bind:value={writeValue} placeholder="Secret value" autocomplete="off" />
        </div>
        <div class="form-field form-field--actions">
          <button class="btn btn-primary btn-sm" onclick={() => void handleWrite()} disabled={actionLoading === 'write' || !writeKey.trim() || !writeValue}>
            {#if actionLoading === 'write'}<span class="spinner"></span>{/if} Save
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="panel-body panel-body--flush">
    {#if error}
      <div class="error-banner"><span>{error}</span></div>
    {/if}

    {#if keys.length > 0}
      <div class="key-table">
        <div class="key-table-header">
          <span class="key-col key-col--name">Key</span>
          <span class="key-col key-col--actions">Actions</span>
        </div>
        {#each keys as key (key)}
          <div class="key-row">
            <span class="key-col key-col--name">
              <code>{key}</code>
            </span>
            <span class="key-col key-col--actions">
              {#if deleteConfirmKey === key}
                <span class="confirm-bar" role="alert">
                  <span class="confirm-text">Delete <strong>{key}</strong>?</span>
                  <button class="btn btn-sm btn-danger" onclick={() => void confirmDelete(key)} disabled={actionLoading === key}>
                    {#if actionLoading === key}<span class="spinner"></span>{/if} Confirm
                  </button>
                  <button class="btn btn-sm btn-secondary" onclick={cancelDelete}>Cancel</button>
                </span>
              {:else}
                <button class="btn btn-sm btn-danger" onclick={() => requestDelete(key)} disabled={actionLoading === key}>
                  {#if actionLoading === key}<span class="spinner"></span>{/if} Delete
                </button>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {:else if !loading && available}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <p>No keys in the user vault yet.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .form-section { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
  .form-section h3 { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-3); }
  .form-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; }
  .form-field { display: flex; flex-direction: column; gap: var(--space-1); flex: 1; min-width: 160px; }
  .form-field--actions { flex: 0 0 auto; display: flex; flex-direction: row; gap: var(--space-2); align-items: center; min-width: unset; }
  .form-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); }
  .form-input { width: 100%; height: 32px; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 var(--space-3); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; }
  .form-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }

  .key-table { display: flex; flex-direction: column; width: 100%; }
  .key-table-header { display: flex; align-items: center; padding: var(--space-2) var(--space-5); background: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border); font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .key-row { display: flex; align-items: center; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--color-bg-tertiary); gap: var(--space-3); }
  .confirm-bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .key-row:last-child { border-bottom: none; }
  .key-row:hover { background: var(--color-surface-hover); }
  .key-col { display: flex; align-items: center; }
  .key-col--name { flex: 1; min-width: 0; }
  .key-col--name code { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-text); }
  .key-col--actions { flex: 0 0 auto; }

  .error-banner { padding: var(--space-3) var(--space-5); background: var(--color-danger-bg); border-bottom: 1px solid var(--color-danger-border, rgba(255,107,107,0.25)); color: var(--color-danger); font-size: var(--text-sm); }
  .error-banner code { font-family: var(--font-mono); background: rgba(0,0,0,0.1); padding: 1px 6px; border-radius: var(--radius-sm); }

  @media (max-width: 768px) { .key-table-header { display: none; } .key-row { flex-wrap: wrap; gap: var(--space-2); } .form-row { flex-direction: column; } .form-field { min-width: unset; } }
</style>
