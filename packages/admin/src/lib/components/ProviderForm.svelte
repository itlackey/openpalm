<script lang="ts">
  import { PROVIDERS, KNOWN_EMB_DIMS, type ProviderDefinition } from '$lib/provider-registry.js';

  interface Props {
    mode: 'add' | 'edit';
    /** Pre-populated provider ID for edit mode */
    initialProvider?: string;
    initialBaseUrl?: string;
    initialLlmModel?: string;
    initialEmbModel?: string;
    initialEmbDims?: number;
    initialHasKey?: boolean;
    /** Detected local providers */
    detectedLocal?: Array<{ provider: string; url: string; available: boolean }>;
    onSave: (data: {
      provider: string;
      baseUrl: string;
      apiKey: string;
      llmModel: string;
      embModel: string;
      embDims: number;
    }) => void;
    onCancel: () => void;
    onTest: (data: { provider: string; baseUrl: string; apiKey: string }) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
  }

  let {
    mode,
    initialProvider = '',
    initialBaseUrl = '',
    initialLlmModel = '',
    initialEmbModel = '',
    initialEmbDims = 0,
    initialHasKey = false,
    detectedLocal = [],
    onSave,
    onCancel,
    onTest,
  }: Props = $props();

  // ── Form state ──────────────────────────────────────────────
  let selectedProviderId = $state('');
  let baseUrl = $state('');
  let apiKey = $state('');
  let showApiKey = $state(false);
  let llmModel = $state('');
  let embModel = $state('');
  let embDims = $state(0);

  // Sync initial values when props change (handles edit mode)
  $effect(() => {
    selectedProviderId = initialProvider;
    baseUrl = initialBaseUrl;
    showApiKey = initialHasKey;
    llmModel = initialLlmModel;
    embModel = initialEmbModel;
    embDims = initialEmbDims;
    apiKey = '';
    tested = false;
    testedModels = [];
    testError = '';
  });

  // ── Test state ──────────────────────────────────────────────
  let testing = $state(false);
  let testError = $state('');
  let testedModels = $state<string[]>([]);
  let tested = $state(false);

  // ── Derived ─────────────────────────────────────────────────
  let providerDef = $derived(PROVIDERS.find((p) => p.id === selectedProviderId));
  let needsKey = $derived(providerDef?.needsKey ?? false);
  let needsUrl = $derived(providerDef?.needsUrl ?? false);
  let canTest = $derived(selectedProviderId !== '' && (baseUrl !== '' || !needsUrl));
  let canSave = $derived(tested && llmModel !== '');

  // Group providers for the dropdown
  const groups = [
    { id: 'recommended', label: 'Recommended' },
    { id: 'local', label: 'Local' },
    { id: 'cloud', label: 'Cloud' },
    { id: 'advanced', label: 'Advanced' },
  ] as const;

  function handleProviderChange(): void {
    const def = PROVIDERS.find((p) => p.id === selectedProviderId);
    if (!def) return;
    // Auto-fill defaults
    const detected = detectedLocal.find((d) => d.provider === def.id && d.available);
    baseUrl = detected?.url || def.baseUrl;
    showApiKey = def.needsKey || false;
    apiKey = '';
    llmModel = def.llmModel;
    embModel = def.embModel;
    embDims = def.embDims;
    tested = false;
    testedModels = [];
    testError = '';
  }

  async function handleTest(): Promise<void> {
    testing = true;
    testError = '';
    try {
      const result = await onTest({ provider: selectedProviderId, baseUrl, apiKey });
      if (result.ok && result.models) {
        testedModels = result.models;
        tested = true;
        // Auto-select defaults if not set
        if (!llmModel && testedModels.length > 0) {
          llmModel = providerDef?.llmModel && testedModels.includes(providerDef.llmModel)
            ? providerDef.llmModel
            : testedModels[0];
        }
        if (!embModel && providerDef?.embModel && testedModels.includes(providerDef.embModel)) {
          embModel = providerDef.embModel;
        }
      } else {
        testError = result.error || 'Connection failed.';
        tested = false;
      }
    } catch (e) {
      testError = e instanceof Error ? e.message : 'Connection failed.';
      tested = false;
    } finally {
      testing = false;
    }
  }

  function handleEmbModelChange(): void {
    const dims = KNOWN_EMB_DIMS[embModel];
    if (dims) embDims = dims;
  }

  function handleSave(): void {
    onSave({
      provider: selectedProviderId,
      baseUrl,
      apiKey,
      llmModel,
      embModel,
      embDims,
    });
  }
</script>

<div class="form-panel">
  <h3>{mode === 'edit' ? 'Edit Provider' : 'Add Provider'}</h3>

  <div class="form-grid">
    <!-- Provider selector -->
    <div class="field">
      <label for="pf-provider">Provider</label>
      <select id="pf-provider" bind:value={selectedProviderId} onchange={handleProviderChange} disabled={mode === 'edit'}>
        <option value="">Select a provider...</option>
        {#each groups as group}
          <optgroup label={group.label}>
            {#each PROVIDERS.filter((p) => p.group === group.id) as p}
              <option value={p.id}>{p.name}{p.kind === 'local' ? ' (local)' : ''}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </div>

    <!-- Base URL -->
    {#if selectedProviderId}
      <div class="field">
        <label for="pf-url">Base URL</label>
        <input id="pf-url" type="text" bind:value={baseUrl} placeholder="https://api.example.com" />
        {#if !needsUrl && providerDef}
          <span class="hint">Default: {providerDef.baseUrl}</span>
        {/if}
      </div>
    {/if}

    <!-- API Key -->
    {#if selectedProviderId && (needsKey || showApiKey)}
      <div class="field">
        <label for="pf-key">API Key</label>
        <input id="pf-key" type="password" bind:value={apiKey} placeholder={providerDef?.placeholder || 'Enter API key'} autocomplete="off" />
        {#if mode === 'edit' && initialHasKey}
          <span class="hint">Leave empty to keep current key.</span>
        {/if}
      </div>
    {/if}

    <!-- Test Connection -->
    {#if selectedProviderId}
      <div class="field field-actions">
        <button class="btn btn-outline btn-sm" onclick={() => void handleTest()} disabled={!canTest || testing}>
          {#if testing}
            <span class="spinner"></span> Testing...
          {:else}
            Test Connection
          {/if}
        </button>
        {#if tested}
          <span class="test-ok">{testedModels.length} models discovered</span>
        {/if}
        {#if testError}
          <span class="test-err">{testError}</span>
        {/if}
      </div>
    {/if}

    <!-- Model selection (after test) -->
    {#if tested && testedModels.length > 0}
      <div class="field">
        <label for="pf-llm">LLM Model</label>
        <select id="pf-llm" bind:value={llmModel}>
          <option value="">Select model...</option>
          {#each testedModels as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label for="pf-emb">Embedding Model</label>
        <select id="pf-emb" bind:value={embModel} onchange={handleEmbModelChange}>
          <option value="">(none / use another provider)</option>
          {#each testedModels as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
      </div>

      {#if embModel}
        <div class="field field-short">
          <label for="pf-dims">Embedding Dims</label>
          <input id="pf-dims" type="number" bind:value={embDims} min="1" max="8192" />
        </div>
      {/if}
    {/if}

    <!-- If tested but no models, allow manual entry -->
    {#if tested && testedModels.length === 0}
      <div class="field">
        <label for="pf-llm-manual">LLM Model</label>
        <input id="pf-llm-manual" type="text" bind:value={llmModel} placeholder="e.g. gpt-4o" />
        <span class="hint">No models discovered. Enter model ID manually.</span>
      </div>
      <div class="field">
        <label for="pf-emb-manual">Embedding Model</label>
        <input id="pf-emb-manual" type="text" bind:value={embModel} placeholder="e.g. text-embedding-3-small" onchange={handleEmbModelChange} />
      </div>
      {#if embModel}
        <div class="field field-short">
          <label for="pf-dims-manual">Embedding Dims</label>
          <input id="pf-dims-manual" type="number" bind:value={embDims} min="1" max="8192" />
        </div>
      {/if}
    {/if}
  </div>

  <div class="form-footer">
    <button class="btn btn-primary btn-sm" onclick={handleSave} disabled={!canSave}>
      Save
    </button>
    <button class="btn btn-ghost btn-sm" onclick={onCancel}>
      Cancel
    </button>
  </div>
</div>

<style>
  .form-panel { padding: var(--space-5); border-top: 1px solid var(--color-border); background: var(--color-bg-secondary); }
  .form-panel h3 { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-4); }
  .form-grid { display: flex; flex-direction: column; gap: var(--space-4); max-width: 600px; }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  .field label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .field select, .field input[type="text"], .field input[type="password"], .field input[type="number"] {
    height: 36px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md);
    background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit;
  }
  .field select:focus, .field input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }
  .field-short { max-width: 160px; }
  .field-actions { flex-direction: row; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .hint { font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .test-ok { font-size: var(--text-xs); color: var(--color-success); font-weight: var(--font-medium); }
  .test-err { font-size: var(--text-xs); color: var(--color-danger); }
  .form-footer { display: flex; gap: var(--space-3); margin-top: var(--space-5); }

  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 8px 16px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); line-height: 1.4; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition-fast); white-space: nowrap; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary { background: var(--color-primary); color: #000; border-color: var(--color-primary); }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); }
  .btn-outline { background: transparent; color: var(--color-primary); border-color: var(--color-primary); }
  .btn-outline:hover:not(:disabled) { background: var(--color-primary-subtle); }
  .btn-ghost { background: none; border: none; color: var(--color-text-secondary); padding: 8px 12px; cursor: pointer; }
  .btn-ghost:hover:not(:disabled) { color: var(--color-text); }
  .btn-sm { padding: 5px 12px; font-size: var(--text-xs); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
