<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import {
    fetchCapabilitiesDto,
    fetchMemoryConfig,
    saveCapabilities,
    testCapability,
    resetMemoryCollection,
  } from '$lib/api.js';
  import { EMBEDDING_DIMS, PROVIDER_KEY_MAP } from '$lib/provider-constants.js';
  import { mapCapabilityTestError } from '$lib/model-discovery.js';
  import type { CapabilitiesSummary, SaveCapabilitiesPayload } from '$lib/types.js';
  import CapabilitiesForm from './CapabilitiesForm.svelte';
  import ManageModelsSheet from './opencode/ManageModelsSheet.svelte';
  import ConnectProviderSheet from './opencode/ConnectProviderSheet.svelte';

  interface Props {
    loading: boolean;
    onRefresh: () => void;
  }

  let { loading, onRefresh }: Props = $props();

  // ── Capabilities + secrets state ───────────────────────────────────
  let capabilities = $state<CapabilitiesSummary | null>(null);
  let secrets = $state<Record<string, string>>({});
  let listLoading = $state(false);
  let listError = $state('');

  // ── Form panel state ─────────────────────────────────────────────
  let formMode = $state<'hidden' | 'create'>('hidden');

  // ── Inline test state (lifted from CapabilitiesForm) ────────────────
  let testLoading = $state(false);
  let testError = $state('');
  let testModelList = $state<string[]>([]);
  let capabilityTested = $state(false);

  // ── Action feedback ───────────────────────────────────────────────
  let actionError = $state('');
  let actionSuccess = $state('');

  // ── Memory settings state ─────────────────────────────────────────
  let memoryUserId = $state('default_user');
  let customInstructions = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let memorySaving = $state(false);
  let memorySaveError = $state('');
  let memorySaveSuccess = $state(false);
  let dimensionMismatch = $state(false);
  let dimensionWarning = $state('');
  let resetting = $state(false);
  let resetSuccess = $state(false);
  let settingsTab = $state<'memory' | 'models'>('models');

  // ── OpenCode provider/model sheet state ─────────────────────────
  let showModelsSheet = $state(false);
  let showConnectSheet = $state(false);

  // ── Derived display values ─────────────────────────────────────────

  /** Parse "provider/model" capability string. */
  function parseCapString(cap: string): { provider: string; model: string } {
    const idx = cap.indexOf('/');
    if (idx < 0) return { provider: cap, model: '' };
    return { provider: cap.slice(0, idx), model: cap.slice(idx + 1) };
  }

  /** Derive a human-readable display name from the provider string. */
  function providerDisplayName(provider: string): string {
    if (!provider) return 'Unknown';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  let currentProvider = $derived(capabilities ? parseCapString(capabilities.llm).provider : '');
  let currentModel = $derived(capabilities ? parseCapString(capabilities.llm).model : '');
  let connDisplayName = $derived(providerDisplayName(currentProvider));
  let hasApiKey = $derived.by(() => {
    const keyField = PROVIDER_KEY_MAP[currentProvider];
    if (!keyField) return false;
    const val = secrets[keyField] ?? '';
    return val.startsWith('sk-') || (val.length > 4 && val.includes('****'));
  });

  // ── Load on mount ─────────────────────────────────────────────────
  $effect(() => {
    void loadConnections();
  });

  function readConfigValue(config: Record<string, unknown>, key: string): string {
    const value = config[key];
    return typeof value === 'string' ? value : '';
  }

  function handleEmbeddingModelChange(newModel: string): void {
    embeddingModel = newModel;
    if (!currentProvider) return;
    const dims = EMBEDDING_DIMS[`${currentProvider}/${newModel}`];
    if (dims) embeddingDims = dims;
  }

  async function loadConnections(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    listLoading = true;
    listError = '';
    try {
      const dto = await fetchCapabilitiesDto(token);
      capabilities = dto.capabilities;
      secrets = dto.secrets;

      if (capabilities) {
        memoryUserId = capabilities.memory?.userId ?? 'default_user';
        customInstructions = capabilities.memory?.customInstructions ?? '';
        embeddingModel = capabilities.embeddings?.model ?? '';
        embeddingDims = capabilities.embeddings?.dims ?? 1536;
      }

      try {
        const omData = await fetchMemoryConfig(token);
        customInstructions = omData.config.memory.custom_instructions ?? '';
        const persistedEmbeddingModel = readConfigValue(omData.config.mem0.embedder.config, 'model');
        if (persistedEmbeddingModel) embeddingModel = persistedEmbeddingModel;
        const persistedDims = omData.config.mem0.vector_store.config.embedding_model_dims;
        if (Number.isInteger(persistedDims) && persistedDims > 0) embeddingDims = persistedDims;
      } catch {
        // Memory config may not exist yet
      }
    } catch {
      listError = 'Failed to load capabilities.';
    } finally {
      listLoading = false;
    }
  }

  async function saveSettings(): Promise<void> {
    const token = getAdminToken();
    if (!token || !currentProvider) return;

    memorySaving = true;
    memorySaveError = '';
    memorySaveSuccess = false;
    dimensionWarning = '';
    dimensionMismatch = false;
    resetSuccess = false;

    try {
      const payload: SaveCapabilitiesPayload = {
        provider: currentProvider,
        systemModel: currentModel,
        embeddingModel,
        embeddingDims,
        memoryUserId,
        customInstructions,
      };
      const result = await saveCapabilities(token, payload);

      if (result.ok) {
        memorySaveSuccess = true;

        if (result.dimensionMismatch) {
          dimensionMismatch = true;
          dimensionWarning = result.dimensionWarning ?? 'Embedding dimensions changed. Reset the memory collection to apply.';
        }

        await loadConnections();
        onRefresh();
      } else {
        memorySaveError = 'Failed to save settings.';
      }
    } catch (e) {
      memorySaveError = e instanceof Error ? e.message : 'Unable to reach admin API.';
    } finally {
      memorySaving = false;
    }
  }

  // ── Form action handlers ──────────────────────────────────────────

  function handleAddNew(): void {
    formMode = 'create';
    clearFeedback();
    resetTestState();
  }

  async function handleFormSave(payload: { provider: string; baseUrl: string; apiKey?: string; name: string }): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    actionError = '';
    try {
      await saveCapabilities(token, {
        provider: payload.provider,
        apiKey: payload.apiKey,
        baseUrl: payload.baseUrl,
      });
      actionSuccess = `Connection "${payload.name}" added.`;
      formMode = 'hidden';
      resetTestState();
      await loadConnections();
      onRefresh();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to save.';
    }
  }

  function handleFormCancel(): void {
    formMode = 'hidden';
    resetTestState();
  }

  async function handleTest(draft: { baseUrl: string; apiKey: string; kind: string }): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    testLoading = true;
    testError = '';
    testModelList = [];
    capabilityTested = false;
    try {
      const result = await testCapability(token, draft);
      if (!result.ok) {
        testError = mapCapabilityTestError(result);
        return;
      }
      testModelList = result.models ?? [];
      capabilityTested = true;
    } catch (e) {
      testError = e instanceof Error ? e.message : 'Network error — unable to reach admin API.';
    } finally {
      testLoading = false;
    }
  }

  function clearFeedback(): void {
    actionError = '';
    actionSuccess = '';
  }

  function resetTestState(): void {
    testLoading = false;
    testError = '';
    testModelList = [];
    capabilityTested = false;
  }

  async function handleResetCollection(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    if (!confirm('This will delete all stored memories. The collection will be recreated with the correct dimensions on restart. Continue?')) {
      return;
    }

    resetting = true;
    try {
      await resetMemoryCollection(token);
      resetSuccess = true;
      dimensionMismatch = false;
      dimensionWarning = '';
    } catch (e) {
      memorySaveError = e instanceof Error ? e.message : 'Failed to reset memory collection.';
    } finally {
      resetting = false;
    }
  }
</script>

<section class="capabilities-tab" aria-label="Capabilities configuration">
  <div class="tab-header">
    <div class="tab-header-text">
      <h2>Capabilities</h2>
      <p class="tab-subtitle">
        Connections let you reuse the same endpoint (and credentials) across different
        model types. You can mix local and remote hosts.
      </p>
    </div>
    <button
      class="btn btn-ghost"
      type="button"
      disabled={loading}
      onclick={onRefresh}
      aria-label="Refresh capabilities"
    >
      <svg class:spin={loading} aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  </div>

  <!-- ── Feedback Messages ─────────────────────────────────────── -->
  {#if actionSuccess}
    <div class="feedback feedback--success" role="status" aria-live="polite">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <span>{actionSuccess}</span>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionSuccess = ''}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  {#if actionError}
    <div class="feedback feedback--error" role="alert" aria-live="assertive">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{actionError}</span>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionError = ''}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  {#if dimensionMismatch}
    <div class="feedback feedback--warning dim-warning" role="alert" aria-live="assertive">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div class="dim-warning-content">
        <span>{dimensionWarning}</span>
        <button
          class="btn btn-sm btn-danger"
          type="button"
          disabled={resetting}
          onclick={() => void handleResetCollection()}
        >
          {#if resetting}
            <span class="spinner"></span>
          {/if}
          Reset Collection
        </button>
      </div>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => { dimensionWarning = ''; dimensionMismatch = false; }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  {#if resetSuccess}
    <div class="feedback feedback--success" role="status" aria-live="polite">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <span>Memory collection reset. Restart Memory to recreate it with the new dimensions.</span>
      <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => resetSuccess = false}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  <!-- ── Connections list ────────────────────────────────────────── -->
  <section class="panel capabilities-section">
    <div class="panel-header">
      <h3>Capabilities</h3>
      {#if !listLoading}
        <button class="btn btn-sm btn-ghost" type="button" onclick={() => showModelsSheet = true}>
          Manage Models
        </button>
        <button class="btn btn-sm btn-ghost" type="button" onclick={() => showConnectSheet = true}>
          Connect Provider
        </button>
        <button class="btn btn-sm btn-outline" type="button" onclick={handleAddNew}>
          Add provider
        </button>
      {/if}
    </div>

    <div class="panel-body" style="padding: 0;">
      {#if listLoading}
        <div class="loading-state">
          <span class="spinner"></span>
          <span>Loading capabilities...</span>
        </div>
      {:else if listError}
        <div class="list-error">
          <span>{listError}</span>
          <button class="btn btn-sm btn-ghost" type="button" onclick={loadConnections}>
            Retry
          </button>
        </div>
      {:else if !capabilities}
        <div class="empty-state">
          <p class="empty-headline">No capabilities configured</p>
          <p class="empty-body">
            Add a connection to a local server (like LM Studio) or a remote
            OpenAI-compatible endpoint.
          </p>
          <button class="btn btn-primary btn-sm" type="button" onclick={handleAddNew}>
            Add your first connection
          </button>
        </div>
      {:else}
        <div class="conn-table">
          <div class="conn-table-head">
            <span class="conn-col conn-col--name">Name</span>
            <span class="conn-col conn-col--model">LLM</span>
            <span class="conn-col conn-col--embed">Embeddings</span>
            <span class="conn-col conn-col--auth">Auth</span>
          </div>
          <div class="conn-table-row">
            <span class="conn-col conn-col--name conn-name">{connDisplayName}</span>
            <span class="conn-col conn-col--model">{capabilities.llm}</span>
            <span class="conn-col conn-col--embed">{capabilities.embeddings.model}</span>
            <span class="conn-col conn-col--auth">{hasApiKey ? 'Key set' : 'No key'}</span>
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- ── CapabilitiesForm panel (create) ────────────────────────── -->
  {#if formMode !== 'hidden'}
    <section class="panel capabilities-section">
      <div class="panel-header">
        <h3>Add provider</h3>
      </div>
      <div class="panel-body">
        <CapabilitiesForm
          initial={null}
          {testLoading}
          modelList={testModelList}
          {testError}
          {capabilityTested}
          onSave={(payload) => void handleFormSave({ provider: payload.provider, baseUrl: payload.baseUrl, apiKey: payload.apiKey, name: payload.name })}
          onCancel={handleFormCancel}
          onTest={(draft) => void handleTest(draft)}
        />
      </div>
    </section>
  {/if}

  <!-- ── Settings (tabbed: Models / Memory) ────────────────────── -->
  <section class="panel capabilities-section">
    <div class="panel-header">
      <div class="settings-tabs" role="tablist">
        <button
          class="settings-tab"
          class:settings-tab--active={settingsTab === 'models'}
          role="tab"
          aria-selected={settingsTab === 'models'}
          aria-controls="settings-panel-models"
          type="button"
          onclick={() => settingsTab = 'models'}
        >Models</button>
        <button
          class="settings-tab"
          class:settings-tab--active={settingsTab === 'memory'}
          role="tab"
          aria-selected={settingsTab === 'memory'}
          aria-controls="settings-panel-memory"
          type="button"
          onclick={() => settingsTab = 'memory'}
        >Memory</button>
      </div>
      <div class="panel-header-actions">
        {#if memorySaveSuccess}
          <span class="header-save-status header-save-status--success">Saved</span>
        {/if}
        {#if memorySaveError}
          <span class="header-save-status header-save-status--error" title={memorySaveError}>Error</span>
        {/if}
        <button
          class="btn btn-primary btn-sm"
          type="button"
          disabled={memorySaving}
          onclick={() => void saveSettings()}
        >
          {#if memorySaving}<span class="spinner"></span>{/if}
          Save
        </button>
      </div>
    </div>

    <!-- ── Models tab ──────────────────────────────────────────── -->
    {#if settingsTab === 'models'}
      <div id="settings-panel-models" role="tabpanel" class="panel-body settings-stack">
        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">Current Configuration</span>
            <span class="settings-card-help">LLM and embedding settings derived from the active connection.</span>
          </div>
          {#if capabilities}
            <div class="field-group">
              <span class="field-label">LLM</span>
              <span class="field-value">{capabilities.llm}</span>
            </div>
            <div class="field-group">
              <span class="field-label">Embeddings</span>
              <span class="field-value">{capabilities.embeddings.provider}/{capabilities.embeddings.model} ({capabilities.embeddings.dims} dims)</span>
            </div>
          {:else}
            <p class="field-hint">No connection configured yet.</p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Memory tab ──────────────────────────────────────────── -->
    {#if settingsTab === 'memory'}
      <div id="settings-panel-memory" role="tabpanel" class="panel-body">
        <div class="form-grid">
          <div class="form-field">
            <label for="conn-memory-user-id" class="form-label">Memory User ID</label>
            <input
              id="conn-memory-user-id"
              type="text"
              class="form-input"
              bind:value={memoryUserId}
              placeholder="default_user"
              autocomplete="off"
            />
            <span class="field-hint">Identifies the memory owner.</span>
          </div>

          <div class="form-field">
            <label for="memory-embedding-model" class="form-label">Embedding model</label>
            <input
              id="memory-embedding-model"
              type="text"
              class="form-input"
              bind:value={embeddingModel}
              placeholder="text-embedding-3-small"
            />
            <span class="field-hint">Changing embeddings later requires a collection reset.</span>
          </div>

          <div class="form-field">
            <label for="memory-embedding-dims" class="form-label">Embedding dimensions</label>
            <input
              id="memory-embedding-dims"
              type="number"
              class="form-input"
              bind:value={embeddingDims}
              min="1"
              step="1"
            />
          </div>

          <div class="form-field form-field-full">
            <label for="conn-om-instructions" class="form-label">Custom Instructions</label>
            <textarea
              id="conn-om-instructions"
              class="form-input form-textarea"
              bind:value={customInstructions}
              placeholder="Optional instructions for memory processing..."
              rows="3"
            ></textarea>
          </div>
        </div>
      </div>
    {/if}
  </section>
</section>

<style>
  .capabilities-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .tab-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .tab-header-text h2 {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .tab-subtitle {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0;
  }

  /* ── Loading ──────────────────────────────────────────────────── */

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  /* ── Feedback Banners ────────────────────────────────────────── */

  .feedback {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .feedback span {
    flex: 1;
  }

  .feedback--success {
    background: var(--color-success-bg, rgba(64, 192, 87, 0.1));
    border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.25));
    color: var(--color-text);
  }

  .feedback--error {
    background: var(--color-danger-bg, rgba(255, 107, 107, 0.1));
    border: 1px solid var(--color-danger-border, rgba(255, 107, 107, 0.25));
    color: var(--color-text);
  }

  .feedback--warning {
    background: var(--color-warning-bg, rgba(255, 193, 7, 0.1));
    border: 1px solid var(--color-warning-border, rgba(255, 193, 7, 0.25));
    color: var(--color-text);
  }

  .btn-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    border-radius: var(--radius-sm);
  }

  .btn-dismiss:hover {
    opacity: 1;
    background: rgba(128, 128, 128, 0.1);
  }

  .dim-warning-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dim-warning-content .btn {
    align-self: flex-start;
  }

  /* ── Panels ──────────────────────────────────────────────────── */

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin: 0;
  }

  .panel-body {
    padding: var(--space-5);
  }

  .capabilities-section {
    margin-bottom: var(--space-4);
  }

  /* ── Form Grid ───────────────────────────────────────────────── */

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-field-full {
    grid-column: 1 / -1;
  }

  .form-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }

  .form-input {
    width: 100%;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 12px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: inherit;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle, rgba(80, 200, 120, 0.15));
  }

  .form-textarea {
    height: auto;
    padding: var(--space-2) 12px;
    resize: vertical;
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }

  .settings-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .settings-card {
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  .settings-card-header {
    margin-bottom: var(--space-4);
  }

  .settings-card-title {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .settings-card-help {
    display: block;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .field-group {
    margin-bottom: var(--space-4);
  }

  .field-group:last-child {
    margin-bottom: 0;
  }

  .field-label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .field-value {
    display: block;
    color: var(--color-text);
    font-size: var(--text-base);
    line-height: 1.5;
    word-break: break-word;
  }

  /* ── Settings Tabs ──────────────────────────────────────────── */

  .settings-tabs {
    display: flex;
    gap: 0;
  }

  .settings-tab {
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    font-family: inherit;
    color: var(--color-text-secondary);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .settings-tab:hover {
    color: var(--color-text);
  }

  .settings-tab--active {
    color: var(--color-text);
    font-weight: var(--font-semibold);
    border-bottom-color: var(--color-primary);
  }

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .header-save-status {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }

  .header-save-status--success {
    color: var(--color-success, #40c057);
  }

  .header-save-status--error {
    color: var(--color-danger);
  }

  /* ── Buttons ─────────────────────────────────────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 20px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
    justify-content: center;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary);
    color: #000;
    border-color: var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .btn-outline {
    background: transparent;
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08));
  }

  .btn-ghost {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    padding: 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .btn-sm {
    padding: 4px 12px;
    font-size: var(--text-xs);
  }

  .btn-danger {
    background: var(--color-danger);
    color: #fff;
    border-color: var(--color-danger);
  }

  .btn-danger:hover:not(:disabled) {
    opacity: 0.9;
  }

  /* ── Spinner ─────────────────────────────────────────────────── */

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

  .spin {
    animation: spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner, .spin {
      animation: none;
    }
  }

  /* ── Profiles table ─────────────────────────────────────────── */

  .conn-table {
    display: flex;
    flex-direction: column;
  }

  .conn-table-head,
  .conn-table-row {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    gap: var(--space-3);
    font-size: var(--text-sm);
  }

  .conn-table-head {
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--color-bg-secondary);
  }

  .conn-table-row {
    border-bottom: 1px solid var(--color-bg-tertiary);
  }

  .conn-table-row:last-child {
    border-bottom: none;
  }

  .conn-col--name { flex: 2; min-width: 0; }
  .conn-col--model,
  .conn-col--embed {
    flex: 3;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conn-col--auth { flex: 1; min-width: 0; }

  .conn-name {
    font-weight: var(--font-medium);
  }

  /* ── Empty state ─────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-8) var(--space-6);
    text-align: center;
  }

  .empty-headline {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin: 0;
  }

  .empty-body {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    max-width: 36ch;
    margin: 0;
  }

  /* ── List error ──────────────────────────────────────────────── */

  .list-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  @media (max-width: 640px) {
    .form-grid {
      grid-template-columns: 1fr;
    }

    .conn-col--embed,
    .conn-col--auth {
      display: none;
    }
  }
</style>

<ManageModelsSheet open={showModelsSheet} onClose={() => showModelsSheet = false} />
<ConnectProviderSheet
  open={showConnectSheet}
  onClose={() => showConnectSheet = false}
  onConnected={() => { showConnectSheet = false; void loadConnections(); }}
/>
