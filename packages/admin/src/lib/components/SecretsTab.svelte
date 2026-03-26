<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import { fetchSecrets, writeSecret, deleteSecret, generateSecret, type SecretEntry } from '$lib/api.js';

  interface Props {
    tokenStored: boolean;
  }

  let { tokenStored }: Props = $props();

  let entries = $state<SecretEntry[]>([]);
  let provider = $state('');
  let capabilities = $state<Record<string, boolean>>({});
  let loading = $state(false);
  let error = $state('');
  let actionSuccess = $state('');
  let actionError = $state('');
  let actionLoading = $state(false);

  // Write form
  let showWriteForm = $state(false);
  let writeKey = $state('');
  let writeValue = $state('');

  // Generate form
  let showGenerateForm = $state(false);
  let genKey = $state('');
  let genLength = $state(32);

  async function loadSecrets(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    loading = true;
    error = '';
    try {
      const result = await fetchSecrets(token);
      entries = result.entries;
      provider = result.provider;
      capabilities = result.capabilities;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load secrets.';
    } finally {
      loading = false;
    }
  }

  async function handleWrite(): Promise<void> {
    const token = getAdminToken();
    if (!token || !writeKey.trim() || !writeValue.trim()) return;
    actionLoading = true;
    actionError = '';
    actionSuccess = '';
    try {
      await writeSecret(token, writeKey.trim(), writeValue);
      actionSuccess = `Secret "${writeKey.trim()}" saved.`;
      writeKey = '';
      writeValue = '';
      showWriteForm = false;
      await loadSecrets();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to write secret.';
    } finally {
      actionLoading = false;
    }
  }

  async function handleGenerate(): Promise<void> {
    const token = getAdminToken();
    if (!token || !genKey.trim()) return;
    actionLoading = true;
    actionError = '';
    actionSuccess = '';
    try {
      await generateSecret(token, genKey.trim(), genLength);
      actionSuccess = `Secret "${genKey.trim()}" generated (${genLength} bytes).`;
      genKey = '';
      genLength = 32;
      showGenerateForm = false;
      await loadSecrets();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to generate secret.';
    } finally {
      actionLoading = false;
    }
  }

  async function handleDelete(key: string): Promise<void> {
    if (!confirm(`Delete secret "${key}"? This cannot be undone.`)) return;
    const token = getAdminToken();
    if (!token) return;
    actionLoading = true;
    actionError = '';
    actionSuccess = '';
    try {
      await deleteSecret(token, key);
      actionSuccess = `Secret "${key}" deleted.`;
      await loadSecrets();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to delete secret.';
    } finally {
      actionLoading = false;
    }
  }

  $effect(() => {
    if (tokenStored) void loadSecrets();
  });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Secrets</h2>
      {#if provider}
        <span class="panel-subtitle">Backend: {provider}</span>
      {/if}
    </div>
    <div class="panel-header-actions">
      {#if capabilities.generate}
        <button class="btn btn-secondary btn-sm" onclick={() => { showGenerateForm = !showGenerateForm; showWriteForm = false; }}>
          Generate
        </button>
      {/if}
      <button class="btn btn-secondary btn-sm" onclick={() => { showWriteForm = !showWriteForm; showGenerateForm = false; }}>
        Write Secret
      </button>
      <button class="btn btn-secondary btn-sm" onclick={() => void loadSecrets()} disabled={loading || !tokenStored}>
        {#if loading}<span class="spinner"></span>{/if}
        Refresh
      </button>
    </div>
  </div>

  <!-- Feedback -->
  {#if actionSuccess}
    <div class="feedback feedback--success">
      <span>{actionSuccess}</span>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionSuccess = ''}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  {/if}
  {#if actionError}
    <div class="feedback feedback--error">
      <span>{actionError}</span>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionError = ''}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  {/if}

  <!-- Write form -->
  {#if showWriteForm}
    <div class="form-section">
      <h3>Write Secret</h3>
      <div class="form-row">
        <div class="form-field">
          <label for="write-key" class="form-label">Key</label>
          <input id="write-key" class="form-input" type="text" bind:value={writeKey} placeholder="openpalm/my-secret" autocomplete="off" />
        </div>
        <div class="form-field">
          <label for="write-value" class="form-label">Value</label>
          <input id="write-value" class="form-input" type="password" bind:value={writeValue} placeholder="Secret value" autocomplete="off" />
        </div>
        <div class="form-field form-field--actions">
          <button class="btn btn-primary btn-sm" onclick={() => void handleWrite()} disabled={actionLoading || !writeKey.trim() || !writeValue.trim()}>
            {#if actionLoading}<span class="spinner"></span>{/if} Save
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => showWriteForm = false}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Generate form -->
  {#if showGenerateForm}
    <div class="form-section">
      <h3>Generate Secret</h3>
      <div class="form-row">
        <div class="form-field">
          <label for="gen-key" class="form-label">Key</label>
          <input id="gen-key" class="form-input" type="text" bind:value={genKey} placeholder="openpalm/hmac-key" autocomplete="off" />
        </div>
        <div class="form-field">
          <label for="gen-length" class="form-label">Length (bytes)</label>
          <input id="gen-length" class="form-input" type="number" bind:value={genLength} min="16" max="4096" />
        </div>
        <div class="form-field form-field--actions">
          <button class="btn btn-primary btn-sm" onclick={() => void handleGenerate()} disabled={actionLoading || !genKey.trim()}>
            {#if actionLoading}<span class="spinner"></span>{/if} Generate
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => showGenerateForm = false}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Entries list -->
  <div class="panel-body panel-body--flush">
    {#if error}
      <div class="error-banner"><span>{error}</span></div>
    {/if}

    {#if entries.length > 0}
      <div class="secret-table">
        <div class="secret-table-header">
          <span class="secret-col secret-col--key">Key</span>
          <span class="secret-col secret-col--scope">Scope</span>
          <span class="secret-col secret-col--kind">Kind</span>
          <span class="secret-col secret-col--actions"></span>
        </div>
        {#each entries as entry (entry.key)}
          <div class="secret-row">
            <span class="secret-col secret-col--key secret-key">{entry.key}</span>
            <span class="secret-col secret-col--scope">{entry.scope ?? ''}</span>
            <span class="secret-col secret-col--kind">{entry.kind ?? ''}</span>
            <span class="secret-col secret-col--actions">
              <button class="btn btn-sm btn-danger" onclick={() => void handleDelete(entry.key)} disabled={actionLoading}>
                Delete
              </button>
            </span>
          </div>
        {/each}
      </div>
    {:else if !loading}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <p>No secrets found.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .panel-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); }
  .panel-header h2 { font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text); }
  .panel-subtitle { font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .panel-header-actions { display: flex; align-items: center; gap: var(--space-2); }
  .panel-body--flush { padding: 0; }

  .form-section { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
  .form-section h3 { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-3); }
  .form-row { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; }
  .form-field { display: flex; flex-direction: column; gap: var(--space-1); flex: 1; min-width: 160px; }
  .form-field--actions { flex: 0 0 auto; display: flex; flex-direction: row; gap: var(--space-2); align-items: center; min-width: unset; }
  .form-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); }
  .form-input { width: 100%; height: 32px; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 var(--space-3); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; }
  .form-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }

  .secret-table { display: flex; flex-direction: column; width: 100%; }
  .secret-table-header { display: flex; align-items: center; padding: var(--space-2) var(--space-5); background: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border); font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .secret-row { display: flex; align-items: center; padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--color-bg-tertiary); }
  .secret-row:last-child { border-bottom: none; }
  .secret-row:hover { background: var(--color-surface-hover); }

  .secret-col { display: flex; align-items: center; }
  .secret-col--key { flex: 3; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .secret-col--scope { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .secret-col--kind { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--color-text-secondary); }
  .secret-col--actions { flex: 0 0 auto; }
  .secret-key { font-family: var(--font-mono); font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }

  .feedback { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-5); font-size: var(--text-sm); }
  .feedback span { flex: 1; }
  .feedback--success { background: var(--color-success-bg); border-bottom: 1px solid var(--color-success-border); color: var(--color-text); }
  .feedback--error { background: var(--color-danger-bg); border-bottom: 1px solid var(--color-danger-border, rgba(255,107,107,0.25)); color: var(--color-text); }
  .btn-dismiss { display: inline-flex; align-items: center; justify-content: center; padding: 4px; background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6; border-radius: var(--radius-sm); }
  .btn-dismiss:hover { opacity: 1; background: rgba(128,128,128,0.1); }

  .error-banner { padding: var(--space-3) var(--space-5); background: var(--color-danger-bg); border-bottom: 1px solid var(--color-danger-border, rgba(255,107,107,0.25)); color: var(--color-danger); font-size: var(--text-sm); }
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--space-10) var(--space-4); color: var(--color-text-tertiary); text-align: center; gap: var(--space-4); }
  .empty-state p { font-size: var(--text-sm); }

  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 8px 16px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); line-height: 1.4; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition-fast); white-space: nowrap; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary { background: var(--color-primary); color: #000; border-color: var(--color-primary); }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }
  .btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border); }
  .btn-secondary:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-hover); }
  .btn-danger { background: var(--color-danger); color: #fff; border-color: var(--color-danger); }
  .btn-danger:hover:not(:disabled) { opacity: 0.9; }
  .btn-ghost { background: none; border: none; color: var(--color-text-secondary); padding: 6px 12px; border-radius: var(--radius-sm); cursor: pointer; }
  .btn-ghost:hover:not(:disabled) { color: var(--color-text); background: var(--color-bg-secondary); }
  .btn-sm { padding: 5px 12px; font-size: var(--text-xs); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 768px) { .secret-table-header { display: none; } .secret-row { flex-wrap: wrap; gap: var(--space-2); } .form-row { flex-direction: column; } .form-field { min-width: unset; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
