<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import {
    fetchOpenMemoryConfig,
    saveOpenMemoryConfig,
    fetchProviderModels
  } from '$lib/api.js';
  import type { OpenMemoryConfig } from '$lib/types.js';

  interface Props {
    connections: Record<string, string>;
    loading: boolean;
    onRefresh: () => void;
  }

  let { connections, loading, onRefresh }: Props = $props();

  // ── Form State ──────────────────────────────────────────────────────────
  // LLM Provider Keys (secrets — always empty on load; user types a new value to update)
  let openaiKey = $state('');
  let anthropicKey = $state('');
  let groqKey = $state('');
  let mistralKey = $state('');
  let googleKey = $state('');

  // Guardian LLM Config — pre-seeded from loaded data
  let guardianProvider: string = $state('');
  let guardianModel: string = $state('');

  // Sync plain-text config fields when connections data arrives
  let lastSyncedConnections: Record<string, string> | null = $state(null);
  $effect(() => {
    if (connections && connections !== lastSyncedConnections) {
      lastSyncedConnections = connections;
      guardianProvider = connections['GUARDIAN_LLM_PROVIDER'] ?? '';
      guardianModel = connections['GUARDIAN_LLM_MODEL'] ?? '';
    }
  });

  // ── UI State ────────────────────────────────────────────────────────────
  let saving = $state(false);
  let saveSuccess = $state(false);
  let saveError = $state('');

  // ── OpenMemory Config State ─────────────────────────────────────────────
  let omLlmProvider = $state('openai');
  let omLlmModel = $state('gpt-4o-mini');
  let omLlmBaseUrl = $state('');
  let omLlmApiKeyRef = $state('env:OPENAI_API_KEY');
  let omLlmTemperature = $state(0.1);
  let omLlmMaxTokens = $state(2000);

  let omEmbedProvider = $state('openai');
  let omEmbedModel = $state('text-embedding-3-small');
  let omEmbedBaseUrl = $state('');
  let omEmbedApiKeyRef = $state('env:OPENAI_API_KEY');
  let omEmbedDims = $state(1536);

  let omCustomInstructions = $state('');

  let omLoading = $state(false);
  let omSaving = $state(false);
  let omSaveSuccess = $state(false);
  let omSaveError = $state('');
  let omLoaded = $state(false);

  // ── Model Selection State ──────────────────────────────────────────────
  let llmModels: string[] = $state([]);
  let llmModelsLoading = $state(false);
  let llmModelsError = $state('');
  let llmModelCustom = $state(false);

  let embedModels: string[] = $state([]);
  let embedModelsLoading = $state(false);
  let embedModelsError = $state('');
  let embedModelCustom = $state(false);

  let llmProviders: string[] = $state([]);
  let embedProviders: string[] = $state([]);
  let embeddingDimsLookup: Record<string, number> = $state({});

  const API_KEY_REFS = [
    'env:OPENAI_API_KEY',
    'env:ANTHROPIC_API_KEY',
    'env:GROQ_API_KEY',
    'env:MISTRAL_API_KEY',
    'env:GOOGLE_API_KEY',
    'env:OPENMEMORY_OPENAI_API_KEY',
  ];

  // Auto-fill embedding dimensions when model changes
  $effect(() => {
    const lookupKey = `${omEmbedProvider}/${omEmbedModel}`;
    if (embeddingDimsLookup[lookupKey]) {
      omEmbedDims = embeddingDimsLookup[lookupKey];
    }
  });

  // Load OpenMemory config when tab is first shown
  $effect(() => {
    if (!loading && !omLoaded && !omLoading) {
      void loadOpenMemoryConfig();
    }
  });

  async function loadOpenMemoryConfig(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    omLoading = true;
    try {
      const data = await fetchOpenMemoryConfig(token);
      llmProviders = [...data.providers.llm];
      embedProviders = [...data.providers.embed];
      embeddingDimsLookup = { ...data.embeddingDims };

      const cfg = data.config;
      omLlmProvider = cfg.mem0.llm.provider ?? 'openai';
      omLlmModel = (cfg.mem0.llm.config.model as string) ?? 'gpt-4o-mini';
      omLlmBaseUrl = (cfg.mem0.llm.config.base_url as string) ?? '';
      omLlmApiKeyRef = (cfg.mem0.llm.config.api_key as string) ?? 'env:OPENAI_API_KEY';
      omLlmTemperature = (cfg.mem0.llm.config.temperature as number) ?? 0.1;
      omLlmMaxTokens = (cfg.mem0.llm.config.max_tokens as number) ?? 2000;

      omEmbedProvider = cfg.mem0.embedder.provider ?? 'openai';
      omEmbedModel = (cfg.mem0.embedder.config.model as string) ?? 'text-embedding-3-small';
      omEmbedBaseUrl = (cfg.mem0.embedder.config.base_url as string) ?? '';
      omEmbedApiKeyRef = (cfg.mem0.embedder.config.api_key as string) ?? 'env:OPENAI_API_KEY';
      omEmbedDims = cfg.mem0.vector_store.config.embedding_model_dims ?? 1536;

      omCustomInstructions = cfg.openmemory.custom_instructions ?? '';
      omLoaded = true;
    } catch {
      omSaveError = 'Failed to load OpenMemory config.';
    } finally {
      omLoading = false;
    }
  }

  // ── Model Loading ────────────────────────────────────────────────────
  async function loadLlmModels(): Promise<void> {
    const token = getAdminToken();
    if (!token || !omLlmProvider) return;

    llmModelsLoading = true;
    llmModelsError = '';
    try {
      const result = await fetchProviderModels(token, omLlmProvider, omLlmApiKeyRef, omLlmBaseUrl);
      llmModels = result.models;
      if (result.error) {
        llmModelsError = result.error;
        llmModelCustom = true;
      } else if (result.models.length > 0) {
        // If current model is in list, keep it; otherwise prepend it
        if (omLlmModel && !result.models.includes(omLlmModel)) {
          llmModels = [omLlmModel, ...result.models];
        }
        llmModelCustom = false;
      } else {
        llmModelCustom = true;
      }
    } catch {
      llmModelsError = 'Failed to fetch models.';
      llmModelCustom = true;
    } finally {
      llmModelsLoading = false;
    }
  }

  async function loadEmbedModels(): Promise<void> {
    const token = getAdminToken();
    if (!token || !omEmbedProvider) return;

    embedModelsLoading = true;
    embedModelsError = '';
    try {
      const result = await fetchProviderModels(token, omEmbedProvider, omEmbedApiKeyRef, omEmbedBaseUrl);
      embedModels = result.models;
      if (result.error) {
        embedModelsError = result.error;
        embedModelCustom = true;
      } else if (result.models.length > 0) {
        if (omEmbedModel && !result.models.includes(omEmbedModel)) {
          embedModels = [omEmbedModel, ...result.models];
        }
        embedModelCustom = false;
      } else {
        embedModelCustom = true;
      }
    } catch {
      embedModelsError = 'Failed to fetch models.';
      embedModelCustom = true;
    } finally {
      embedModelsLoading = false;
    }
  }

  // Debounced reactive model loading when provider/key/url changes
  let llmDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    // Track reactive dependencies
    void omLlmProvider;
    void omLlmApiKeyRef;
    void omLlmBaseUrl;

    if (!omLoaded) return;
    clearTimeout(llmDebounceTimer);
    llmDebounceTimer = setTimeout(() => void loadLlmModels(), 500);
    return () => clearTimeout(llmDebounceTimer);
  });

  let embedDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void omEmbedProvider;
    void omEmbedApiKeyRef;
    void omEmbedBaseUrl;

    if (!omLoaded) return;
    clearTimeout(embedDebounceTimer);
    embedDebounceTimer = setTimeout(() => void loadEmbedModels(), 500);
    return () => clearTimeout(embedDebounceTimer);
  });

  function handleLlmModelSelectChange(value: string): void {
    if (value === '__custom__') {
      llmModelCustom = true;
      omLlmModel = '';
    } else {
      omLlmModel = value;
    }
  }

  function handleEmbedModelSelectChange(value: string): void {
    if (value === '__custom__') {
      embedModelCustom = true;
      omEmbedModel = '';
    } else {
      omEmbedModel = value;
    }
  }

  function buildOpenMemoryConfig(): OpenMemoryConfig {
    const llmConfig: Record<string, unknown> = {
      model: omLlmModel,
      temperature: omLlmTemperature,
      max_tokens: omLlmMaxTokens,
      api_key: omLlmApiKeyRef,
    };
    if (omLlmBaseUrl.trim()) {
      llmConfig.base_url = omLlmBaseUrl.trim();
    }

    const embedConfig: Record<string, unknown> = {
      model: omEmbedModel,
      api_key: omEmbedApiKeyRef,
    };
    if (omEmbedBaseUrl.trim()) {
      embedConfig.base_url = omEmbedBaseUrl.trim();
    }

    return {
      mem0: {
        llm: { provider: omLlmProvider, config: llmConfig },
        embedder: { provider: omEmbedProvider, config: embedConfig },
        vector_store: {
          provider: 'qdrant',
          config: {
            collection_name: 'openmemory',
            host: 'qdrant',
            port: 6333,
            embedding_model_dims: omEmbedDims,
          },
        },
      },
      openmemory: { custom_instructions: omCustomInstructions },
    };
  }

  async function handleSaveOpenMemoryConfig(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      omSaveError = 'Admin token required.';
      return;
    }

    omSaving = true;
    omSaveError = '';
    omSaveSuccess = false;

    try {
      const config = buildOpenMemoryConfig();
      const result = await saveOpenMemoryConfig(token, config);
      if (result.ok) {
        omSaveSuccess = true;
        if (!result.pushed && result.pushError) {
          omSaveError = 'Config saved to file. Restart OpenMemory to apply changes.';
        }
      } else {
        omSaveError = 'Failed to save config.';
      }
    } catch {
      omSaveError = 'Unable to reach admin API.';
    } finally {
      omSaving = false;
    }
  }

  function buildPatches(): Record<string, string> {
    const patches: Record<string, string> = {};

    if (openaiKey.trim()) patches['OPENAI_API_KEY'] = openaiKey.trim();
    if (anthropicKey.trim()) patches['ANTHROPIC_API_KEY'] = anthropicKey.trim();
    if (groqKey.trim()) patches['GROQ_API_KEY'] = groqKey.trim();
    if (mistralKey.trim()) patches['MISTRAL_API_KEY'] = mistralKey.trim();
    if (googleKey.trim()) patches['GOOGLE_API_KEY'] = googleKey.trim();

    if (guardianProvider.trim()) patches['GUARDIAN_LLM_PROVIDER'] = guardianProvider.trim();
    if (guardianModel.trim()) patches['GUARDIAN_LLM_MODEL'] = guardianModel.trim();

    return patches;
  }

  async function saveConnections(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      saveError = 'Admin token required. Please sign in from the main console.';
      return;
    }

    const patches = buildPatches();
    if (Object.keys(patches).length === 0) {
      saveError = 'No values entered. Fill in at least one field to save.';
      return;
    }

    saving = true;
    saveError = '';
    saveSuccess = false;

    try {
      const res = await fetch('/admin/connections', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token,
          'x-requested-by': 'ui',
          'x-request-id': crypto.randomUUID()
        },
        body: JSON.stringify(patches)
      });

      if (res.status === 401) {
        saveError = 'Invalid admin token.';
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        saveError = body.message ?? 'Failed to save connections.';
        return;
      }

      saveSuccess = true;
      // Clear entered secret fields after successful save
      openaiKey = '';
      anthropicKey = '';
      groqKey = '';
      mistralKey = '';
      googleKey = '';
      // Refresh data to show updated masked values
      onRefresh();
    } catch {
      saveError = 'Unable to reach admin API.';
    } finally {
      saving = false;
    }
  }

  function handleSubmit(e: SubmitEvent): void {
    e.preventDefault();
    void saveConnections();
  }

  function dismissSuccess(): void {
    saveSuccess = false;
  }

  function dismissError(): void {
    saveError = '';
  }

  function dismissOmSuccess(): void {
    omSaveSuccess = false;
  }

  function dismissOmError(): void {
    omSaveError = '';
  }
</script>

<section class="connections-tab" aria-label="Connections configuration">
  <div class="tab-header">
    <div class="tab-header-text">
      <h2>Connections</h2>
      <p class="tab-subtitle">
        Configure LLM provider API keys and service connection settings.
        Keys are stored in <code>CONFIG_HOME/secrets.env</code> and never overwritten.
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
        <span>Connections saved successfully.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissSuccess}>
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
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissError}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    <form onsubmit={handleSubmit} novalidate>
      <!-- ── Section 1: LLM Provider API Keys ────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>LLM Provider API Keys</h3>
          <p class="section-desc">
            Enter a new value to update an existing key. Leave blank to keep the current value.
            Existing values are shown masked.
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-openai-key" class="form-label">
                OpenAI API Key
                {#if connections['OPENAI_API_KEY']}
                  <span class="current-value">Current: {connections['OPENAI_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-openai-key"
                type="password"
                class="form-input"
                bind:value={openaiKey}
                placeholder="sk-..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-anthropic-key" class="form-label">
                Anthropic API Key
                {#if connections['ANTHROPIC_API_KEY']}
                  <span class="current-value">Current: {connections['ANTHROPIC_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-anthropic-key"
                type="password"
                class="form-input"
                bind:value={anthropicKey}
                placeholder="sk-ant-..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-groq-key" class="form-label">
                Groq API Key
                {#if connections['GROQ_API_KEY']}
                  <span class="current-value">Current: {connections['GROQ_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-groq-key"
                type="password"
                class="form-input"
                bind:value={groqKey}
                placeholder="gsk_..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-mistral-key" class="form-label">
                Mistral API Key
                {#if connections['MISTRAL_API_KEY']}
                  <span class="current-value">Current: {connections['MISTRAL_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-mistral-key"
                type="password"
                class="form-input"
                bind:value={mistralKey}
                placeholder="..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-google-key" class="form-label">
                Google API Key
                {#if connections['GOOGLE_API_KEY']}
                  <span class="current-value">Current: {connections['GOOGLE_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-google-key"
                type="password"
                class="form-input"
                bind:value={googleKey}
                placeholder="AIza..."
                autocomplete="off"
              />
            </div>

          </div>
        </div>
      </section>

      <!-- ── Section 2: Guardian LLM Config ──────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>Guardian LLM Config</h3>
          <p class="section-desc">
            Configure which LLM provider and model the Guardian uses for message routing decisions.
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-guardian-provider" class="form-label">Guardian LLM Provider</label>
              <input
                id="conn-guardian-provider"
                type="text"
                class="form-input"
                bind:value={guardianProvider}
                placeholder="openai"
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-guardian-model" class="form-label">Guardian LLM Model</label>
              <input
                id="conn-guardian-model"
                type="text"
                class="form-input"
                bind:value={guardianModel}
                placeholder="gpt-4o-mini"
                autocomplete="off"
              />
            </div>

          </div>
        </div>
      </section>

      <!-- ── Save Connections Button ──────────────────────────────── -->
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {#if saving}
            <span class="spinner"></span>
          {/if}
          Save Connections
        </button>
      </div>
    </form>

    <!-- ── Section 3: OpenMemory Configuration ───────────────────── -->
    <section class="panel connections-section om-section" aria-label="OpenMemory configuration">
      <div class="panel-header">
        <h3>OpenMemory Configuration</h3>
        <p class="section-desc">
          Configure the LLM and embedding providers that OpenMemory uses for memory operations.
          API keys are referenced by environment variable name — actual values are managed above.
        </p>
      </div>

      {#if omLoading}
        <div class="panel-body">
          <div class="loading-state">
            <span class="spinner"></span>
            <span>Loading OpenMemory config...</span>
          </div>
        </div>
      {:else}
        <!-- ── OM Feedback Messages ──────────────────────────────── -->
        {#if omSaveSuccess}
          <div class="feedback feedback--success om-feedback" role="status" aria-live="polite">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>OpenMemory config saved.</span>
            <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissOmSuccess}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        {/if}

        {#if omSaveError}
          <div class="feedback feedback--warning om-feedback" role="status" aria-live="polite">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{omSaveError}</span>
            <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissOmError}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        {/if}

        <div class="panel-body">
          <!-- LLM Provider Panel -->
          <div class="om-panel">
            <h4 class="om-panel-title">LLM Provider</h4>
            <div class="form-grid">

              <div class="form-field">
                <label for="om-llm-provider" class="form-label">Provider</label>
                <select id="om-llm-provider" class="form-input" bind:value={omLlmProvider}>
                  {#each llmProviders as p}
                    <option value={p}>{p}</option>
                  {/each}
                </select>
              </div>

              <div class="form-field">
                <label for="om-llm-model" class="form-label">
                  Model
                  {#if llmModelsLoading}
                    <span class="spinner spinner-inline"></span>
                  {/if}
                </label>
                {#if !llmModelCustom && llmModels.length > 0}
                  <div class="model-select-row">
                    <select
                      id="om-llm-model"
                      class="form-input"
                      value={omLlmModel}
                      onchange={(e) => handleLlmModelSelectChange(e.currentTarget.value)}
                    >
                      {#each llmModels as m}
                        <option value={m}>{m}</option>
                      {/each}
                      <option value="__custom__">Custom...</option>
                    </select>
                    <button
                      class="btn-icon"
                      type="button"
                      title="Refresh models"
                      disabled={llmModelsLoading}
                      onclick={() => void loadLlmModels()}
                    >
                      <svg class:spin={llmModelsLoading} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                  </div>
                {:else}
                  <div class="model-select-row">
                    <input
                      id="om-llm-model"
                      type="text"
                      class="form-input"
                      bind:value={omLlmModel}
                      placeholder="gpt-4o-mini"
                      autocomplete="off"
                    />
                    <button
                      class="btn-icon"
                      type="button"
                      title="Load models from provider"
                      disabled={llmModelsLoading}
                      onclick={() => void loadLlmModels()}
                    >
                      <svg class:spin={llmModelsLoading} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                  </div>
                  {#if llmModelsError}
                    <span class="field-error">{llmModelsError}</span>
                  {/if}
                {/if}
              </div>

              <div class="form-field">
                <label for="om-llm-base-url" class="form-label">
                  Base URL
                  <span class="field-hint">(required for Ollama, LM Studio, etc.)</span>
                </label>
                <input
                  id="om-llm-base-url"
                  type="url"
                  class="form-input"
                  bind:value={omLlmBaseUrl}
                  placeholder="http://host.docker.internal:11434"
                  autocomplete="off"
                />
              </div>

              <div class="form-field">
                <label for="om-llm-apikey" class="form-label">API Key Reference</label>
                <select id="om-llm-apikey" class="form-input" bind:value={omLlmApiKeyRef}>
                  {#each API_KEY_REFS as ref}
                    <option value={ref}>{ref}</option>
                  {/each}
                </select>
              </div>

              <div class="form-field">
                <label for="om-llm-temp" class="form-label">Temperature</label>
                <input
                  id="om-llm-temp"
                  type="number"
                  class="form-input"
                  bind:value={omLlmTemperature}
                  min="0"
                  max="1"
                  step="0.1"
                />
              </div>

              <div class="form-field">
                <label for="om-llm-tokens" class="form-label">Max Tokens</label>
                <input
                  id="om-llm-tokens"
                  type="number"
                  class="form-input"
                  bind:value={omLlmMaxTokens}
                  min="1"
                  step="100"
                />
              </div>
            </div>
          </div>

          <!-- Embedding Provider Panel -->
          <div class="om-panel">
            <h4 class="om-panel-title">Embedding Provider</h4>
            <div class="form-grid">

              <div class="form-field">
                <label for="om-embed-provider" class="form-label">Provider</label>
                <select id="om-embed-provider" class="form-input" bind:value={omEmbedProvider}>
                  {#each embedProviders as p}
                    <option value={p}>{p}</option>
                  {/each}
                </select>
              </div>

              <div class="form-field">
                <label for="om-embed-model" class="form-label">
                  Model
                  {#if embedModelsLoading}
                    <span class="spinner spinner-inline"></span>
                  {/if}
                </label>
                {#if !embedModelCustom && embedModels.length > 0}
                  <div class="model-select-row">
                    <select
                      id="om-embed-model"
                      class="form-input"
                      value={omEmbedModel}
                      onchange={(e) => handleEmbedModelSelectChange(e.currentTarget.value)}
                    >
                      {#each embedModels as m}
                        <option value={m}>{m}</option>
                      {/each}
                      <option value="__custom__">Custom...</option>
                    </select>
                    <button
                      class="btn-icon"
                      type="button"
                      title="Refresh models"
                      disabled={embedModelsLoading}
                      onclick={() => void loadEmbedModels()}
                    >
                      <svg class:spin={embedModelsLoading} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                  </div>
                {:else}
                  <div class="model-select-row">
                    <input
                      id="om-embed-model"
                      type="text"
                      class="form-input"
                      bind:value={omEmbedModel}
                      placeholder="text-embedding-3-small"
                      autocomplete="off"
                    />
                    <button
                      class="btn-icon"
                      type="button"
                      title="Load models from provider"
                      disabled={embedModelsLoading}
                      onclick={() => void loadEmbedModels()}
                    >
                      <svg class:spin={embedModelsLoading} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                  </div>
                  {#if embedModelsError}
                    <span class="field-error">{embedModelsError}</span>
                  {/if}
                {/if}
              </div>

              <div class="form-field">
                <label for="om-embed-base-url" class="form-label">
                  Base URL
                  <span class="field-hint">(required for Ollama, LM Studio, etc.)</span>
                </label>
                <input
                  id="om-embed-base-url"
                  type="url"
                  class="form-input"
                  bind:value={omEmbedBaseUrl}
                  placeholder="http://host.docker.internal:11434"
                  autocomplete="off"
                />
              </div>

              <div class="form-field">
                <label for="om-embed-apikey" class="form-label">API Key Reference</label>
                <select id="om-embed-apikey" class="form-input" bind:value={omEmbedApiKeyRef}>
                  {#each API_KEY_REFS as ref}
                    <option value={ref}>{ref}</option>
                  {/each}
                </select>
              </div>

              <div class="form-field">
                <label for="om-embed-dims" class="form-label">Embedding Dimensions</label>
                <input
                  id="om-embed-dims"
                  type="number"
                  class="form-input"
                  bind:value={omEmbedDims}
                  min="1"
                  step="1"
                />
              </div>
            </div>
          </div>

          <!-- Custom Instructions -->
          <div class="om-panel">
            <h4 class="om-panel-title">Custom Instructions</h4>
            <div class="form-field">
              <textarea
                id="om-custom-instructions"
                class="form-input form-textarea"
                bind:value={omCustomInstructions}
                placeholder="Optional instructions for memory processing..."
                rows="3"
              ></textarea>
            </div>
          </div>

          <div class="info-note">
            Changing the embedding model after data has been stored requires resetting OpenMemory.
          </div>

          <!-- Save OpenMemory Config Button -->
          <div class="form-actions">
            <button
              class="btn btn-primary"
              type="button"
              disabled={omSaving}
              onclick={() => void handleSaveOpenMemoryConfig()}
            >
              {#if omSaving}
                <span class="spinner"></span>
              {/if}
              Save OpenMemory Config
            </button>
          </div>
        </div>
      {/if}
    </section>
  {/if}
</section>

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

  .tab-subtitle code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
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

  .feedback--success svg {
    color: var(--color-success, #40c057);
    flex-shrink: 0;
  }

  .feedback--error {
    background: var(--color-danger-bg, rgba(250, 82, 82, 0.1));
    border: 1px solid var(--color-danger, #fa5252);
    color: var(--color-text);
  }

  .feedback--error svg {
    color: var(--color-danger, #fa5252);
    flex-shrink: 0;
  }

  .feedback--warning {
    background: var(--color-warning-bg, rgba(255, 183, 77, 0.1));
    border: 1px solid var(--color-warning-border, rgba(255, 183, 77, 0.35));
    color: var(--color-text);
  }

  .feedback--warning svg {
    color: var(--color-warning, #ffb74d);
    flex-shrink: 0;
  }

  .om-feedback {
    margin: var(--space-3) var(--space-5) 0;
  }

  .btn-dismiss {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: var(--space-1);
    color: inherit;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }

  .btn-dismiss:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  /* ── Sections ────────────────────────────────────────────────── */

  .connections-section {
    margin-bottom: var(--space-4);
  }

  .om-section {
    margin-top: var(--space-6);
  }

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .panel-header {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }

  .panel-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .panel-body {
    padding: var(--space-5);
  }

  /* ── OpenMemory Sub-panels ─────────────────────────────────── */

  .om-panel {
    margin-bottom: var(--space-5);
    padding-bottom: var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .om-panel:last-of-type {
    border-bottom: none;
    margin-bottom: var(--space-3);
    padding-bottom: 0;
  }

  .om-panel-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-3);
  }

  .info-note {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);
  }

  /* ── Form Grid ───────────────────────────────────────────────── */

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .form-label {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    font-weight: 400;
  }

  .current-value {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
    font-weight: 400;
  }

  .form-input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-family: var(--font-sans);
    color: var(--color-text);
    background: var(--color-surface);
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
    outline: none;
  }

  .form-input:focus {
    border-color: var(--color-border-focus, #ff9d00);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .form-input::placeholder {
    color: var(--color-text-tertiary);
  }

  .form-textarea {
    resize: vertical;
    min-height: 60px;
    font-family: var(--font-sans);
  }

  select.form-input {
    cursor: pointer;
    appearance: auto;
  }

  /* ── Model Select Row ──────────────────────────────────────── */

  .model-select-row {
    display: flex;
    gap: var(--space-2);
    align-items: stretch;
  }

  .model-select-row .form-input {
    flex: 1;
    min-width: 0;
  }

  .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }

  .btn-icon:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-border-hover);
  }

  .btn-icon:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .spinner-inline {
    width: 12px;
    height: 12px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    display: inline-block;
    vertical-align: middle;
    margin-left: var(--space-1);
  }

  .field-error {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin-top: var(--space-1);
  }

  /* ── Actions ─────────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-top: var(--space-2);
  }

  /* ── Buttons ─────────────────────────────────────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    cursor: pointer;
    border: none;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary);
    color: var(--color-text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    padding: var(--space-2);
    border-radius: var(--radius-md);
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }

  /* ── Spinner ─────────────────────────────────────────────────── */

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .spin {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 768px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
