<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import {
    fetchConnections,
    fetchOpenMemoryConfig,
    fetchProviderModels,
    saveSystemConnection,
    fetchLocalModels,
    saveLocalModels,
    deleteLocalModel,
    fetchLocalModelStatus
  } from '$lib/api.js';
  import {
    LLM_PROVIDERS,
    PROVIDER_DEFAULT_URLS,
    PROVIDER_KEY_MAP,
    NO_KEY_PROVIDERS,
    EMBEDDING_DIMS
  } from '$lib/provider-constants.js';
  import type { SuggestedModel, LocalModelSelection } from '$lib/types.js';

  interface Props {
    connections: Record<string, string>;
    loading: boolean;
    onRefresh: () => void;
  }

  let { connections, loading, onRefresh }: Props = $props();

  // ── Form State ────────────────────────────────────────────────────
  let provider = $state('openai');
  let apiKey = $state('');
  let baseUrl = $state(PROVIDER_DEFAULT_URLS['openai'] ?? '');
  let guardianModel = $state('');
  let memoryModel = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let openmemoryUserId = $state('default_user');
  let customInstructions = $state('');

  // ── Model List State ──────────────────────────────────────────────
  let modelList: string[] = $state([]);
  let modelListLoading = $state(false);
  let modelListError = $state('');
  let connectionTested = $state(false);

  // ── Save State ────────────────────────────────────────────────────
  let saving = $state(false);
  let saveError = $state('');
  let saveSuccess = $state(false);

  // ── Dimension Mismatch State ──────────────────────────────────────
  let dimensionWarning = $state('');
  let dimensionMismatch = $state(false);
  let resetting = $state(false);
  let resetSuccess = $state(false);

  // ── Loaded flag ───────────────────────────────────────────────────
  let loaded = $state(false);

  // ── Local Models State ──────────────────────────────────────────
  let localModelRunnerAvailable = $state(false);
  let localConfig: LocalModelSelection | null = $state(null);
  let localSuggestedSystem: SuggestedModel[] = $state([]);
  let localSuggestedEmbedding: SuggestedModel[] = $state([]);
  let localEmbeddingDimsMap: Record<string, number> = $state({});
  let localLoading = $state(false);
  let localSaving = $state(false);
  let localError = $state('');
  let localSuccess = $state(false);
  let localEditing = $state(false);
  let editSystemModel = $state('');
  let editEmbeddingModel = $state('');
  let editEmbeddingDims = $state(384);
  let useCustomEditSystem = $state(false);
  let useCustomEditEmbedding = $state(false);
  let customEditSystemUrl = $state('');
  let customEditEmbeddingUrl = $state('');
  // Toast state
  let toastVisible = $state(false);
  let toastMessage = $state('');
  let toastModelType = $state<'system' | 'embedding' | ''>('');
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Derived ───────────────────────────────────────────────────────
  let needsApiKey = $derived(!NO_KEY_PROVIDERS.has(provider));

  let maskedCurrentKey = $derived.by(() => {
    const envVar = PROVIDER_KEY_MAP[provider];
    return envVar ? (connections[envVar] ?? '') : '';
  });

  // ── Initialize from connections prop ──────────────────────────────
  void loadCurrentState();

  async function loadCurrentState(): Promise<void> {
    const token = getAdminToken();
    if (!token || loaded) return;

    try {
      const conns = await fetchConnections(token);
      // Pre-fill from saved system connection fields
      if (conns.SYSTEM_LLM_PROVIDER) provider = conns.SYSTEM_LLM_PROVIDER;
      if (conns.SYSTEM_LLM_BASE_URL) {
        baseUrl = conns.SYSTEM_LLM_BASE_URL;
      } else if (conns.SYSTEM_LLM_PROVIDER) {
        baseUrl = PROVIDER_DEFAULT_URLS[conns.SYSTEM_LLM_PROVIDER] ?? '';
      }
      if (conns.GUARDIAN_LLM_MODEL) guardianModel = conns.GUARDIAN_LLM_MODEL;
      if (conns.MEMORY_LLM_MODEL) memoryModel = conns.MEMORY_LLM_MODEL;
      if (conns.EMBEDDING_MODEL) embeddingModel = conns.EMBEDDING_MODEL;
      if (conns.EMBEDDING_DIMS) embeddingDims = Number(conns.EMBEDDING_DIMS) || 1536;
      if (conns.OPENMEMORY_USER_ID) openmemoryUserId = conns.OPENMEMORY_USER_ID;

      // Load custom instructions from OpenMemory config
      try {
        const omData = await fetchOpenMemoryConfig(token);
        customInstructions = omData.config.openmemory.custom_instructions ?? '';
      } catch {
        // OpenMemory config may not exist yet
      }

      loaded = true;
    } catch {
      // Fall back to defaults
      loaded = true;
    }
  }

  // ── Event Handlers ────────────────────────────────────────────────

  function handleProviderChange(newProvider: string): void {
    provider = newProvider;
    if (!baseUrl || Object.values(PROVIDER_DEFAULT_URLS).includes(baseUrl)) {
      baseUrl = PROVIDER_DEFAULT_URLS[newProvider] ?? '';
    }
    connectionTested = false;
    modelList = [];
    modelListError = '';
    apiKey = '';
  }

  function handleEmbeddingModelChange(newModel: string): void {
    embeddingModel = newModel;
    const key = `${provider}/${newModel}`;
    if (EMBEDDING_DIMS[key]) {
      embeddingDims = EMBEDDING_DIMS[key];
    }
  }

  async function testConnection(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    modelListLoading = true;
    modelListError = '';

    try {
      // If user typed a new key, pass it raw; otherwise use the env ref
      const envVar = PROVIDER_KEY_MAP[provider];
      const apiKeyRef = apiKey.trim()
        ? apiKey.trim()
        : envVar ? `env:${envVar}` : '';

      const result = await fetchProviderModels(token, provider, apiKeyRef, baseUrl);
      if (result.error) {
        modelListError = result.error;
        return;
      }
      modelList = result.models ?? [];
      connectionTested = true;

      // Pre-select models if not already set
      if (modelList.length > 0) {
        if (!guardianModel) guardianModel = modelList[0];
        if (!memoryModel) memoryModel = modelList[0];
        if (!embeddingModel) {
          const embedCandidate = modelList.find(m =>
            m.includes('embed') || m.includes('ada')
          );
          embeddingModel = embedCandidate ?? modelList[0];
          handleEmbeddingModelChange(embeddingModel);
        }
      }
    } catch {
      modelListError = 'Network error — unable to reach admin API.';
    } finally {
      modelListLoading = false;
    }
  }

  async function handleSave(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      saveError = 'Admin token required.';
      return;
    }

    saving = true;
    saveError = '';
    saveSuccess = false;
    dimensionWarning = '';
    dimensionMismatch = false;
    resetSuccess = false;

    try {
      const result = await saveSystemConnection(token, {
        provider,
        apiKey,
        baseUrl,
        guardianModel,
        memoryModel,
        embeddingModel,
        embeddingDims,
        openmemoryUserId,
        customInstructions,
      });

      if (result.ok) {
        saveSuccess = true;
        apiKey = '';  // Clear secret after save

        if (!result.pushed && result.pushError) {
          saveError = 'Config saved. Restart OpenMemory to apply changes.';
        }
        if (result.dimensionMismatch) {
          dimensionMismatch = true;
          dimensionWarning = result.dimensionWarning ?? 'Embedding dimensions changed. Reset the memory collection to apply.';
        }

        onRefresh();
      } else {
        saveError = 'Failed to save.';
      }
    } catch {
      saveError = 'Unable to reach admin API.';
    } finally {
      saving = false;
    }
  }

  async function handleResetCollection(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    if (!confirm('This will delete all stored memories. The collection will be recreated with the correct dimensions on restart. Continue?')) {
      return;
    }

    resetting = true;
    try {
      const res = await fetch('/admin/openmemory/reset-collection', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token,
          'x-requested-by': 'ui',
          'x-request-id': crypto.randomUUID()
        }
      });
      if (res.ok) {
        resetSuccess = true;
        dimensionMismatch = false;
        dimensionWarning = '';
      } else {
        const data = await res.json().catch(() => ({})) as { message?: string };
        saveError = data.message ?? 'Failed to reset memory collection.';
      }
    } catch {
      saveError = 'Unable to reach admin API.';
    } finally {
      resetting = false;
    }
  }

  function handleSubmit(e: SubmitEvent): void {
    e.preventDefault();
    void handleSave();
  }

  // ── Local Models Functions ─────────────────────────────────────────

  async function loadLocalModels(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    localLoading = true;
    localError = '';
    try {
      const data = await fetchLocalModels(token);
      localModelRunnerAvailable = data.modelRunnerAvailable;
      localConfig = data.config;
      localSuggestedSystem = data.suggestedSystemModels;
      localSuggestedEmbedding = data.suggestedEmbeddingModels;
      localEmbeddingDimsMap = data.embeddingDims ?? {};
    } catch {
      localError = 'Failed to load local model info.';
    } finally {
      localLoading = false;
    }
  }

  void loadLocalModels();

  function startEditing(): void {
    localEditing = true;
    localSuccess = false;
    localError = '';
    editSystemModel = localConfig?.systemModel?.model ?? '';
    editEmbeddingModel = localConfig?.embeddingModel?.model ?? '';
    editEmbeddingDims = localConfig?.embeddingModel?.dimensions ?? 384;
    useCustomEditSystem = false;
    useCustomEditEmbedding = false;
    customEditSystemUrl = '';
    customEditEmbeddingUrl = '';
  }

  function cancelEditing(): void {
    localEditing = false;
  }

  function handleEditSystemChange(value: string): void {
    if (value === '__custom__') {
      useCustomEditSystem = true;
      editSystemModel = '';
    } else {
      useCustomEditSystem = false;
      editSystemModel = value;
    }
  }

  function handleEditEmbeddingChange(value: string): void {
    if (value === '__custom__') {
      useCustomEditEmbedding = true;
      editEmbeddingModel = '';
    } else {
      useCustomEditEmbedding = false;
      editEmbeddingModel = value;
      const dims = localEmbeddingDimsMap[value];
      if (dims) editEmbeddingDims = dims;
    }
  }

  async function handleLocalModelSave(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    const sysModel = useCustomEditSystem ? customEditSystemUrl.trim() : editSystemModel;
    const embModel = useCustomEditEmbedding ? customEditEmbeddingUrl.trim() : editEmbeddingModel;

    if (!sysModel && !embModel) {
      localError = 'Select at least one model.';
      return;
    }

    localSaving = true;
    localError = '';
    localSuccess = false;

    try {
      const payload: { systemModel?: { model: string; contextSize?: number }; embeddingModel?: { model: string; dimensions?: number }; applyToGuardian?: boolean; applyToMemory?: boolean } = {};
      if (sysModel) {
        payload.systemModel = { model: sysModel, contextSize: 4096 };
        payload.applyToGuardian = true;
      }
      if (embModel) {
        payload.embeddingModel = { model: embModel, dimensions: editEmbeddingDims };
        payload.applyToMemory = true;
      }

      const result = await saveLocalModels(token, payload);
      if (result.ok) {
        localSuccess = true;
        localEditing = false;
        await loadLocalModels();
        if (result.pulling) {
          startStatusPolling();
        }
      }
    } catch (err) {
      localError = err instanceof Error ? err.message : 'Failed to save local models.';
    } finally {
      localSaving = false;
    }
  }

  async function handleLocalModelDelete(target: string): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    if (!confirm(`Remove local model "${target}"? This will update the compose configuration.`)) {
      return;
    }

    localSaving = true;
    localError = '';
    try {
      await deleteLocalModel(token, target);
      localSuccess = false;
      await loadLocalModels();
    } catch (err) {
      localError = err instanceof Error ? err.message : 'Failed to delete local model.';
    } finally {
      localSaving = false;
    }
  }

  function startStatusPolling(): void {
    stopStatusPolling();
    statusPollTimer = setInterval(() => void pollModelStatus(), 5000);
  }

  function stopStatusPolling(): void {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  async function pollModelStatus(): Promise<void> {
    const token = getAdminToken();
    if (!token) { stopStatusPolling(); return; }

    try {
      const status = await fetchLocalModelStatus(token);
      if (status.systemModelReady && status.embeddingModelReady && status.configured) {
        stopStatusPolling();
        toastMessage = 'Local models are ready and applied.';
        toastVisible = true;
        toastModelType = '';
        await loadLocalModels();
      } else if (status.systemModelReady && !status.embeddingModelReady && localConfig?.embeddingModel) {
        // System ready, embedding still pulling
      } else if (!status.systemModelReady && status.embeddingModelReady && localConfig?.systemModel) {
        // Embedding ready, system still pulling
      }
    } catch {
      // Polling error — keep trying
    }
  }

  function dismissToast(): void {
    toastVisible = false;
    toastMessage = '';
    toastModelType = '';
  }

  // Clean up status polling on component teardown
  $effect(() => {
    return () => stopStatusPolling();
  });
</script>

<section class="connections-tab" aria-label="Connections configuration">
  <div class="tab-header">
    <div class="tab-header-text">
      <h2>Connections</h2>
      <p class="tab-subtitle">
        Configure the system LLM connection used by the Guardian and OpenMemory.
      </p>
    </div>
    <button
      class="btn btn-ghost"
      type="button"
      disabled={loading}
      onclick={onRefresh}
      aria-label="Refresh connections"
    >
      <svg class:spin={loading} aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  </div>

  {#if loading}
    <div class="loading-state">
      <span class="spinner"></span>
      <span>Loading connections...</span>
    </div>
  {:else}
    <!-- ── Feedback Messages ─────────────────────────────────────── -->
    {#if saveSuccess}
      <div class="feedback feedback--success" role="status" aria-live="polite">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Connection saved successfully.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveSuccess = false}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    {#if saveError}
      <div class="feedback feedback--error" role="alert" aria-live="assertive">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{saveError}</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => saveError = ''}>
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
        <span>Memory collection reset. Restart OpenMemory to recreate it with the new dimensions.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => resetSuccess = false}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    <form onsubmit={handleSubmit} novalidate>
      <!-- ── Section 1: System LLM Connection ──────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>System LLM Connection</h3>
          <p class="section-desc">
            One connection shared by the Guardian (message routing) and OpenMemory (memory + embeddings).
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-provider" class="form-label">Provider</label>
              <select
                id="conn-provider"
                class="form-input"
                value={provider}
                onchange={(e) => handleProviderChange(e.currentTarget.value)}
              >
                {#each LLM_PROVIDERS as p}
                  <option value={p}>{p}</option>
                {/each}
              </select>
            </div>

            {#if needsApiKey}
              <div class="form-field">
                <label for="conn-api-key" class="form-label">
                  API Key
                  {#if maskedCurrentKey}
                    <span class="current-value">Current: {maskedCurrentKey}</span>
                  {/if}
                </label>
                <input
                  id="conn-api-key"
                  type="password"
                  class="form-input"
                  bind:value={apiKey}
                  placeholder={provider === 'openai' ? 'sk-...' : 'Enter API key'}
                  autocomplete="off"
                />
                <span class="field-hint">Leave blank to keep the current key.</span>
              </div>
            {/if}

            <div class="form-field">
              <label for="conn-base-url" class="form-label">Base URL</label>
              <input
                id="conn-base-url"
                type="url"
                class="form-input"
                bind:value={baseUrl}
                placeholder="Provider base URL"
                autocomplete="off"
              />
              <span class="field-hint">
                {#if provider === 'ollama'}
                  Default: <code>http://host.docker.internal:11434</code>
                {:else if provider === 'lmstudio'}
                  Default: <code>http://host.docker.internal:1234</code>
                {:else}
                  Leave default unless using a custom endpoint.
                {/if}
              </span>
            </div>

          </div>

          <!-- Test Connection -->
          <div class="test-connection-row">
            <button
              class="btn btn-outline"
              type="button"
              onclick={() => void testConnection()}
              disabled={modelListLoading || (needsApiKey && !apiKey.trim() && !maskedCurrentKey)}
            >
              {#if modelListLoading}
                <span class="spinner"></span>
                Testing...
              {:else}
                Test Connection
              {/if}
            </button>
            {#if connectionTested}
              <span class="connection-success" role="status">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Connected — {modelList.length} model{modelList.length !== 1 ? 's' : ''} found.
              </span>
            {/if}
            {#if modelListError}
              <span class="field-error">{modelListError}</span>
            {/if}
          </div>

          <!-- Model Selection -->
          <div class="form-grid model-grid">

            <div class="form-field">
              <label for="conn-guardian-model" class="form-label">Guardian Model</label>
              {#if modelList.length > 0}
                <select id="conn-guardian-model" class="form-input" bind:value={guardianModel}>
                  {#each modelList as m}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
              {:else}
                <input id="conn-guardian-model" type="text" class="form-input" bind:value={guardianModel} placeholder="gpt-4o-mini" />
              {/if}
              <span class="field-hint">Used for message routing and safety decisions.</span>
            </div>

            <div class="form-field">
              <label for="conn-memory-model" class="form-label">Memory Model</label>
              {#if modelList.length > 0}
                <select id="conn-memory-model" class="form-input" bind:value={memoryModel}>
                  {#each modelList as m}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
              {:else}
                <input id="conn-memory-model" type="text" class="form-input" bind:value={memoryModel} placeholder="gpt-4o-mini" />
              {/if}
              <span class="field-hint">Used by OpenMemory for memory reasoning.</span>
            </div>

            <div class="form-field">
              <label for="conn-embedding-model" class="form-label">Embedding Model</label>
              {#if modelList.length > 0}
                <select
                  id="conn-embedding-model"
                  class="form-input"
                  value={embeddingModel}
                  onchange={(e) => handleEmbeddingModelChange(e.currentTarget.value)}
                >
                  {#each modelList as m}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
              {:else}
                <input id="conn-embedding-model" type="text" class="form-input" bind:value={embeddingModel} placeholder="text-embedding-3-small" />
              {/if}
              <span class="field-hint">Changing this after data is stored requires a collection reset.</span>
            </div>

            <div class="form-field">
              <label for="conn-embedding-dims" class="form-label">Embedding Dimensions</label>
              <input
                id="conn-embedding-dims"
                type="number"
                class="form-input"
                bind:value={embeddingDims}
                min="1"
                step="1"
              />
              <span class="field-hint">Auto-filled for known models. Use Test Connection to populate dropdowns.</span>
            </div>

          </div>
        </div>
      </section>

      <!-- ── Section 2: OpenMemory Settings ────────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>OpenMemory Settings</h3>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-om-user-id" class="form-label">OpenMemory User ID</label>
              <input
                id="conn-om-user-id"
                type="text"
                class="form-input"
                bind:value={openmemoryUserId}
                placeholder="default_user"
                autocomplete="off"
              />
              <span class="field-hint">Identifies the memory owner.</span>
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
      </section>

      <!-- ── Save Button ──────────────────────────────────────────── -->
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {#if saving}
            <span class="spinner"></span>
          {/if}
          Save
        </button>
      </div>
    </form>

    <!-- ── Section 3: Local Models ──────────────────────────────── -->
    <section class="panel connections-section local-models-section">
      <div class="panel-header">
        <h3>Local Models</h3>
        <p class="section-desc">
          Run models locally with Docker Model Runner — zero API costs, full privacy.
        </p>
      </div>
      <div class="panel-body">
        {#if localLoading}
          <div class="loading-state">
            <span class="spinner"></span>
            <span>Detecting Docker Model Runner...</span>
          </div>
        {:else if !localModelRunnerAvailable}
          <div class="local-unavailable">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div>
              <p>Docker Model Runner is not detected.</p>
              <p class="field-hint">Enable Model Runner in Docker Desktop settings or install it on Linux to use local models.</p>
            </div>
            <button class="btn btn-outline btn-sm" type="button" onclick={() => void loadLocalModels()}>
              Retry
            </button>
          </div>
        {:else}
          <div class="local-status">
            <span class="status-dot status-dot--ok"></span>
            <span>Docker Model Runner available</span>
          </div>

          {#if localError}
            <div class="feedback feedback--error local-feedback" role="alert">
              <span>{localError}</span>
              <button class="btn-dismiss" type="button" onclick={() => localError = ''}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}

          {#if localSuccess}
            <div class="feedback feedback--success local-feedback" role="status">
              <span>Local models saved. Models are being pulled in the background.</span>
              <button class="btn-dismiss" type="button" onclick={() => localSuccess = false}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          {/if}

          {#if localEditing}
            <!-- ── Editing Mode ────────────────────────────────────── -->
            <div class="local-edit-form">
              <div class="form-grid">
                <div class="form-field">
                  <label for="local-sys-model" class="form-label">System Model</label>
                  {#if useCustomEditSystem}
                    <input
                      id="local-sys-model"
                      type="text"
                      class="form-input"
                      bind:value={customEditSystemUrl}
                      placeholder="hf.co/username/model"
                    />
                    <button class="btn-link" type="button" onclick={() => { useCustomEditSystem = false; editSystemModel = ''; }}>
                      Back to suggested models
                    </button>
                  {:else}
                    <select
                      id="local-sys-model"
                      class="form-input"
                      value={editSystemModel}
                      onchange={(e) => handleEditSystemChange(e.currentTarget.value)}
                    >
                      <option value="">None</option>
                      {#each localSuggestedSystem as m}
                        <option value={m.id}>{m.label} ({m.size})</option>
                      {/each}
                      <option value="__custom__">Custom (HuggingFace)...</option>
                    </select>
                  {/if}
                  <span class="field-hint">Used by Guardian and OpenMemory for reasoning.</span>
                </div>

                <div class="form-field">
                  <label for="local-emb-model" class="form-label">Embedding Model</label>
                  {#if useCustomEditEmbedding}
                    <input
                      id="local-emb-model"
                      type="text"
                      class="form-input"
                      bind:value={customEditEmbeddingUrl}
                      placeholder="hf.co/username/model"
                    />
                    <button class="btn-link" type="button" onclick={() => { useCustomEditEmbedding = false; editEmbeddingModel = ''; }}>
                      Back to suggested models
                    </button>
                  {:else}
                    <select
                      id="local-emb-model"
                      class="form-input"
                      value={editEmbeddingModel}
                      onchange={(e) => handleEditEmbeddingChange(e.currentTarget.value)}
                    >
                      <option value="">None</option>
                      {#each localSuggestedEmbedding as m}
                        <option value={m.id}>{m.label} ({m.size}) — {m.dimensions}d</option>
                      {/each}
                      <option value="__custom__">Custom (HuggingFace)...</option>
                    </select>
                  {/if}
                  <span class="field-hint">Used by OpenMemory for embeddings.</span>
                </div>

                {#if editEmbeddingModel || useCustomEditEmbedding}
                  <div class="form-field">
                    <label for="local-emb-dims" class="form-label">Embedding Dimensions</label>
                    <input
                      id="local-emb-dims"
                      type="number"
                      class="form-input"
                      bind:value={editEmbeddingDims}
                      min="1"
                      step="1"
                    />
                    <span class="field-hint">Auto-filled for known models.</span>
                  </div>
                {/if}
              </div>

              <div class="local-edit-actions">
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  disabled={localSaving}
                  onclick={() => void handleLocalModelSave()}
                >
                  {#if localSaving}
                    <span class="spinner"></span>
                  {/if}
                  Save Local Models
                </button>
                <button class="btn btn-outline btn-sm" type="button" onclick={cancelEditing}>
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <!-- ── Display Mode ────────────────────────────────────── -->
            {#if localConfig && (localConfig.systemModel || localConfig.embeddingModel)}
              <div class="local-models-list">
                {#if localConfig.systemModel}
                  <div class="local-model-item">
                    <div class="local-model-info">
                      <span class="local-model-role">System Model</span>
                      <code class="local-model-id">{localConfig.systemModel.model}</code>
                    </div>
                    <button
                      class="btn btn-ghost btn-sm"
                      type="button"
                      disabled={localSaving}
                      onclick={() => void handleLocalModelDelete('system')}
                      aria-label="Remove system model"
                    >
                      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14H7L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </div>
                {/if}
                {#if localConfig.embeddingModel}
                  <div class="local-model-item">
                    <div class="local-model-info">
                      <span class="local-model-role">Embedding Model</span>
                      <code class="local-model-id">{localConfig.embeddingModel.model}</code>
                      <span class="local-model-dims">{localConfig.embeddingModel.dimensions}d</span>
                    </div>
                    <button
                      class="btn btn-ghost btn-sm"
                      type="button"
                      disabled={localSaving}
                      onclick={() => void handleLocalModelDelete('embedding')}
                      aria-label="Remove embedding model"
                    >
                      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14H7L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  </div>
                {/if}
              </div>
              <button class="btn btn-outline btn-sm" type="button" onclick={startEditing}>
                Change Models
              </button>
            {:else}
              <p class="local-empty">No local models configured.</p>
              <button class="btn btn-outline btn-sm" type="button" onclick={startEditing}>
                Add Local Model
              </button>
            {/if}
          {/if}
        {/if}
      </div>
    </section>
  {/if}
</section>

<!-- ── Toast Notification ───────────────────────────────────────── -->
{#if toastVisible}
  <div class="toast" role="status" aria-live="polite">
    <div class="toast-content">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <span>{toastMessage}</span>
    </div>
    <button class="btn-dismiss" type="button" onclick={dismissToast} aria-label="Dismiss">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
{/if}

<style>
  .connections-tab {
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
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .section-desc {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0;
  }

  .panel-body {
    padding: var(--space-5);
  }

  .connections-section {
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

  .current-value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin-left: var(--space-2);
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

  .field-hint code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .field-error {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  /* ── Test Connection ─────────────────────────────────────────── */

  .test-connection-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
    flex-wrap: wrap;
  }

  .connection-success {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  /* ── Model Grid ──────────────────────────────────────────────── */

  .model-grid {
    margin-top: var(--space-5);
    padding-top: var(--space-5);
    border-top: 1px solid var(--color-border);
  }

  /* ── Form Actions ────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
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

  /* ── Local Models ─────────────────────────────────────────── */

  .local-unavailable {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--color-bg-secondary, rgba(128, 128, 128, 0.06));
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .local-unavailable p {
    margin: 0;
  }

  .local-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-4);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot--ok {
    background: var(--color-success, #40c057);
  }

  .local-feedback {
    margin-bottom: var(--space-4);
  }

  .local-edit-form {
    margin-top: var(--space-2);
  }

  .local-edit-actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .btn-link {
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: var(--text-xs);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  .btn-link:hover {
    opacity: 0.8;
  }

  .local-models-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .local-model-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-secondary, rgba(128, 128, 128, 0.06));
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
  }

  .local-model-info {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
  }

  .local-model-role {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
    width: 110px;
  }

  .local-model-id {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .local-model-dims {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  .local-empty {
    color: var(--color-text-tertiary);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }

  /* ── Toast Notification ─────────────────────────────────────── */

  .toast {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.4));
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-size: var(--text-sm);
    z-index: 1000;
    max-width: 420px;
    animation: slideUp 0.3s ease-out;
  }

  .toast-content {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @media (max-width: 640px) {
    .form-grid {
      grid-template-columns: 1fr;
    }

    .toast {
      left: var(--space-4);
      right: var(--space-4);
      max-width: none;
    }
  }
</style>
