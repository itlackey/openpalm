<script lang="ts">
  import { goto } from '$app/navigation';
  import { LLM_PROVIDERS, PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, LOCAL_PROVIDER_HELP, EMBEDDING_DIMS, OLLAMA_DEFAULT_MODELS } from '$lib/provider-constants.js';
  import type { LocalProviderDetection } from '$lib/api.js';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  // svelte-ignore state_referenced_locally
  const { setupToken = '', detectedUserId = 'default_user' } = data;

  // ── Wizard state ────────────────────────────────────────────────────────
  type WizardStep = 'token' | 'provider' | 'models' | 'review';
  let step: WizardStep = $state('token');
  let setupComplete = $state(false);
  let loading = $state(true);

  // Step ordering helpers
  const STEP_ORDER: WizardStep[] = ['token', 'provider', 'models', 'review'];
  function isAfter(a: WizardStep, b: WizardStep): boolean {
    return STEP_ORDER.indexOf(a) > STEP_ORDER.indexOf(b);
  }

  // ── Form fields ─────────────────────────────────────────────────────────
  let adminToken = $state('');
  let setupSessionToken = $state(setupToken);

  // Step 2 — Connection Type picker
  type ConnectionType = 'cloud' | 'local' | null;
  let connectionType: ConnectionType = $state(null);

  // Step 2 — Provider (unified: cloud + local detection)
  let llmProvider = $state('openai');
  let llmApiKey = $state('');
  let llmBaseUrl = $state(PROVIDER_DEFAULT_URLS['openai'] ?? '');

  // Cloud provider quick-picks
  const CLOUD_PROVIDERS = ['openai', 'groq', 'together', 'mistral', 'deepseek', 'xai', 'anthropic'] as const;

  // Local provider detection
  let detectedProviders: LocalProviderDetection[] = $state([]);
  let detectingProviders = $state(false);
  let providersDetected = $state(false);

  // Ollama enable state
  let ollamaEnabled = $state(false);
  let enablingOllama = $state(false);
  let ollamaEnableError = $state('');
  let ollamaEnableProgress = $state('');

  // Step 3 — Models
  let systemModel = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let openmemoryUserId = $state(detectedUserId);

  // Model list state
  let modelList: string[] = $state([]);
  let modelListLoading = $state(false);
  let modelListError = $state('');

  // ── Install state ───────────────────────────────────────────────────────
  let installing = $state(false);
  let installError = $state('');
  let startedServices: string[] = $state([]);

  // ── Validation ──────────────────────────────────────────────────────────
  let tokenError = $state('');
  let connectError = $state('');
  let testingConnection = $state(false);
  let connectionTested = $state(false);

  // ── API helpers ─────────────────────────────────────────────────────────

  function buildHeaders(token = ''): HeadersInit {
    return {
      'x-requested-by': 'ui',
      'x-request-id': crypto.randomUUID(),
      ...(token ? { 'x-admin-token': token } : {})
    };
  }

  // ── Connection Type selection ──────────────────────────────────────────

  function selectConnectionType(type: ConnectionType): void {
    connectionType = type;
    connectionTested = false;
    modelList = [];
    connectError = '';

    if (type === 'cloud') {
      llmProvider = 'openai';
      llmBaseUrl = PROVIDER_DEFAULT_URLS['openai'] ?? '';
      llmApiKey = '';
    } else if (type === 'local') {
      llmProvider = 'ollama';
      llmBaseUrl = PROVIDER_DEFAULT_URLS['ollama'] ?? '';
      llmApiKey = '';
      void detectLocalProviders();
    }
  }

  // ── Event handlers for provider/model changes ─────────────────────────

  function handleProviderChange(newProvider: string): void {
    llmProvider = newProvider;
    // Auto-fill base URL from detected provider or defaults
    const detected = detectedProviders.find(p => p.provider === newProvider && p.available);
    if (detected) {
      llmBaseUrl = detected.url;
    } else if (!llmBaseUrl || Object.values(PROVIDER_DEFAULT_URLS).includes(llmBaseUrl)) {
      llmBaseUrl = PROVIDER_DEFAULT_URLS[newProvider] ?? '';
    }
    connectionTested = false;
    modelList = [];
    connectError = '';
  }

  function handleEmbeddingModelChange(newModel: string): void {
    embeddingModel = newModel;
    // Auto-fill dimensions for known models
    const key = `${llmProvider}/${newModel}`;
    if (EMBEDDING_DIMS[key]) {
      embeddingDims = EMBEDDING_DIMS[key];
    }
  }

  // ── Review display values ────────────────────────────────────────────

  let maskedApiKey = $derived(
    llmApiKey
      ? llmApiKey.slice(0, 3) + '...' + llmApiKey.slice(-4)
      : '(not set)'
  );

  // ── Local Provider detection ──────────────────────────────────────────

  async function detectLocalProviders(): Promise<void> {
    detectingProviders = true;
    try {
      const res = await fetch('/admin/providers/local', {
        headers: buildHeaders(setupSessionToken)
      });
      if (res.ok) {
        const data = await res.json();
        detectedProviders = data.providers ?? [];

        // If Ollama was detected, auto-select it
        const ollamaDetected = detectedProviders.find(p => p.provider === 'ollama' && p.available);
        if (ollamaDetected) {
          handleProviderChange('ollama');
        }
      }
    } catch {
      // Detection failed — continue with manual config
    }
    detectingProviders = false;
    providersDetected = true;
  }

  // ── Enable Ollama handler ─────────────────────────────────────────────

  async function enableOllama(): Promise<void> {
    if (enablingOllama) return;
    enablingOllama = true;
    ollamaEnableError = '';
    ollamaEnableProgress = 'Adding Ollama to the stack...';

    try {
      const res = await fetch('/admin/setup/ollama', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders(setupSessionToken)
        }
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        ollamaEnableError = data.message ?? `Failed to enable Ollama (HTTP ${res.status})`;
        return;
      }

      const result = await res.json();
      ollamaEnabled = true;
      llmProvider = 'ollama';
      llmBaseUrl = result.ollamaUrl ?? 'http://ollama:11434';

      // Ollama is reachable — mark connection as tested regardless of model pull status
      connectionTested = true;

      // Pre-populate model list with the pulled defaults
      const pulledModels: string[] = [];
      const failedModels: string[] = [];
      if (result.models) {
        for (const [name, status] of Object.entries(result.models)) {
          if ((status as { ok: boolean }).ok) {
            pulledModels.push(name);
          } else {
            failedModels.push(name);
          }
        }
      }
      if (pulledModels.length > 0) {
        modelList = pulledModels.sort();
        systemModel = result.defaultChatModel ?? OLLAMA_DEFAULT_MODELS.chat;
        embeddingModel = result.defaultEmbeddingModel ?? OLLAMA_DEFAULT_MODELS.embedding;
        // Set dims for nomic-embed-text
        const dimsKey = `ollama/${embeddingModel}`;
        embeddingDims = EMBEDDING_DIMS[dimsKey] ?? 768;
      }
      if (failedModels.length > 0) {
        ollamaEnableError = `Ollama is running but failed to pull: ${failedModels.join(', ')}. You can pull them manually or use "Test Connection" to retry.`;
      }

      // Re-detect local providers to show Ollama as detected
      await detectLocalProviders();

    } catch {
      ollamaEnableError = 'Network error — unable to reach admin API.';
    } finally {
      enablingOllama = false;
      ollamaEnableProgress = '';
    }
  }

  // ── Test Connection handler ──────────────────────────────────────────

  async function testConnection(): Promise<void> {
    testingConnection = true;
    connectError = '';
    modelListError = '';
    try {
      const res = await fetch('/admin/setup/models', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders(setupSessionToken)
        },
        body: JSON.stringify({
          provider: llmProvider,
          apiKey: llmApiKey,
          baseUrl: llmBaseUrl,
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        connectError = data.message ?? `Connection test failed (HTTP ${res.status})`;
        return;
      }
      const result = await res.json();
      if (result.error) {
        connectError = result.error;
        return;
      }
      const apiModels: string[] = result.models ?? [];

      // Merge API results with any currently-configured models so dropdowns
      // don't lose the user's selection (models may still be pulling).
      const merged = new Set<string>(apiModels);
      if (systemModel) merged.add(systemModel);
      if (embeddingModel) merged.add(embeddingModel);
      modelList = [...merged].sort();
      connectionTested = true;

      // Pre-select first model for each role if not already set
      if (modelList.length > 0) {
        if (!systemModel) systemModel = modelList[0];
        if (!embeddingModel) {
          // Try to find an embedding model
          const embedCandidate = modelList.find(m =>
            m.includes('embed') || m.includes('ada')
          );
          embeddingModel = embedCandidate ?? modelList[0];
        }
      }
    } catch {
      connectError = 'Network error — unable to reach admin API.';
    } finally {
      testingConnection = false;
    }
  }

  // ── Install handler ─────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    if (installing) return;
    installing = true;
    installError = '';
    try {
      const res = await fetch('/admin/setup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders(setupSessionToken)
        },
        body: JSON.stringify({
          adminToken,
          llmProvider,
          llmApiKey,
          llmBaseUrl,
          systemModel,
          embeddingModel,
          embeddingDims,
          openmemoryUserId,
          ollamaEnabled,
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        installError = data.message ?? `Install failed (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      startedServices = data.started ?? [];
      await goto('/');
    } catch {
      installError = 'Network error — unable to reach admin API.';
    } finally {
      installing = false;
    }
  }

  loading = false;
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
</svelte:head>

{#if loading}
  <main class="setup-page" aria-label="Loading">
    <section class="wizard-card">
      <div class="loading-state">
        <span class="spinner"></span>
      </div>
    </section>
  </main>

{:else if setupComplete}
  <!-- Done state -->
  <main class="setup-page" aria-label="Setup complete">
    <section class="wizard-card">
      <div class="done-state">
        <span class="done-icon" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </span>
        <h2>Stack Installed</h2>
        <p class="done-subtitle">All services are up and running.</p>

        {#if startedServices.length > 0}
          <ul class="service-list" aria-label="Started services">
            {#each startedServices as service}
              <li>{service}</li>
            {/each}
          </ul>
        {/if}

        <a href="/" class="btn btn-primary console-link">Go to Console</a>
      </div>
    </section>
  </main>

{:else}
  <!-- Wizard -->
  <main class="setup-page" aria-label="Setup wizard">
    <section class="wizard-card">
      <div class="wizard-header">
        <h1>OpenPalm Setup Wizard</h1>
        <p class="wizard-subtitle">Configure your OpenPalm stack in a few steps.</p>
      </div>

      <!-- Step indicators -->
      <nav class="step-indicators" aria-label="Wizard steps">
        <button class="step-dot" class:active={step === 'token'} class:completed={isAfter(step, 'token')} onclick={() => { step = 'token'; }} aria-label="Step 1: Admin Token" aria-current={step === 'token' ? 'step' : undefined}>1</button>
        <span class="step-line" class:active={isAfter(step, 'token')}></span>
        <button class="step-dot" class:active={step === 'provider'} class:completed={isAfter(step, 'provider')} onclick={() => { if (isAfter(step, 'provider')) { step = 'provider'; } }} aria-label="Step 2: Connection" aria-current={step === 'provider' ? 'step' : undefined}>2</button>
        <span class="step-line" class:active={isAfter(step, 'provider')}></span>
        <button class="step-dot" class:active={step === 'models'} class:completed={isAfter(step, 'models')} onclick={() => { if (isAfter(step, 'models')) step = 'models'; }} aria-label="Step 3: Models" aria-current={step === 'models' ? 'step' : undefined}>3</button>
        <span class="step-line" class:active={isAfter(step, 'models')}></span>
        <button class="step-dot" class:active={step === 'review'} aria-label="Step 4: Review & Install" aria-current={step === 'review' ? 'step' : undefined} disabled>4</button>
      </nav>

      <!-- Step 1: Admin Token -->
      {#if step === 'token'}
        <div class="step-content" data-testid="step-token">
          <h2>Admin Token</h2>
          <div class="field-group">
            <label for="admin-token">Choose an admin token</label>
            <input
              id="admin-token"
              type="password"
              bind:value={adminToken}
              placeholder="Enter a secure admin token"
            />
            <p class="field-hint">This token protects your admin console. Keep it safe — you'll need it to log in.</p>
          </div>
          {#if tokenError}
            <p class="field-error" role="alert">{tokenError}</p>
          {/if}
          <div class="step-actions">
            <button class="btn btn-primary" onclick={() => {
              if (!adminToken.trim()) {
                tokenError = 'Admin token is required.';
                return;
              }
              tokenError = '';
              step = 'provider';
            }}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 2: LLM Connection -->
      {#if step === 'provider'}
        <div class="step-content" data-testid="step-provider">

          <!-- Sub-step 2a: Connection type picker (shown when no type selected) -->
          {#if connectionType === null}
            <h2>Connection Type</h2>
            <p class="step-description">How do you want to connect to an LLM?</p>

            <button
              class="connection-type-card"
              type="button"
              onclick={() => selectConnectionType('cloud')}
            >
              <div class="connection-type-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
              </div>
              <div class="connection-type-text">
                <span class="connection-type-label">OpenAI-Compatible (Remote)</span>
                <span class="connection-type-desc">API key + optional custom base URL. Works with OpenAI, Groq, Together, OpenRouter, and more.</span>
              </div>
            </button>

            <button
              class="connection-type-card"
              type="button"
              onclick={() => selectConnectionType('local')}
            >
              <div class="connection-type-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="2" width="20" height="8" rx="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" />
                  <circle cx="6" cy="6" r="1" />
                  <circle cx="6" cy="18" r="1" />
                </svg>
              </div>
              <div class="connection-type-text">
                <span class="connection-type-label">Local (Ollama / LM Studio)</span>
                <span class="connection-type-desc">Run models on your own hardware. No API key needed. We can set up Ollama for you.</span>
              </div>
            </button>

            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => (step = 'token')}>Back</button>
            </div>

          <!-- Sub-step 2b: Cloud provider details -->
          {:else if connectionType === 'cloud'}
            <h2>Cloud Provider</h2>
            <p class="step-description">Pick a provider or enter custom connection details.</p>

            <!-- Quick-pick provider buttons -->
            <div class="provider-quick-picks">
              {#each CLOUD_PROVIDERS as p}
                <button
                  class="provider-chip"
                  class:selected={llmProvider === p}
                  type="button"
                  onclick={() => handleProviderChange(p)}
                >
                  {PROVIDER_LABELS[p] ?? p}
                </button>
              {/each}
            </div>

            <div class="field-group">
              <label for="llm-api-key">API Key</label>
              <input
                id="llm-api-key"
                type="password"
                bind:value={llmApiKey}
                placeholder="Enter your API key"
              />
            </div>

            <div class="field-group">
              <label for="llm-base-url">Base URL <span style="color: var(--color-text-tertiary); font-weight: normal;">(optional)</span></label>
              <input
                id="llm-base-url"
                type="url"
                bind:value={llmBaseUrl}
                placeholder="Provider base URL"
              />
              <p class="field-hint">Leave default unless using a custom endpoint or proxy.</p>
            </div>

            {#if connectError}
              <p class="field-error" role="alert">{connectError}</p>
            {/if}

            {#if connectionTested}
              <div class="connection-success" role="status">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Connected — {modelList.length} model{modelList.length !== 1 ? 's' : ''} found.</span>
              </div>
            {/if}

            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => { connectionType = null; }}>Back</button>
              <button
                class="btn btn-outline"
                onclick={() => void testConnection()}
                disabled={testingConnection}
              >
                {#if testingConnection}
                  <span class="spinner"></span>
                  Testing...
                {:else}
                  Test Connection
                {/if}
              </button>
              <button
                class="btn btn-primary"
                disabled={!connectionTested}
                onclick={() => { step = 'models'; }}
              >Next</button>
            </div>

          <!-- Sub-step 2b: Local provider details -->
          {:else if connectionType === 'local'}
            <h2>Local Provider</h2>
            <p class="step-description">Connect to a local LLM running on your machine.</p>

            {#if detectingProviders}
              <div class="loading-state" style="justify-content: flex-start; padding: var(--space-4) 0;">
                <span class="spinner"></span>
                <span style="font-size: var(--text-sm); color: var(--color-text-secondary); margin-left: var(--space-2);">Detecting local providers...</span>
              </div>
            {/if}

            {#if providersDetected}
              <!-- Show detected providers -->
              {#each detectedProviders.filter(p => p.available) as dp}
                <button
                  class="provider-option"
                  class:selected={llmProvider === dp.provider}
                  type="button"
                  onclick={() => handleProviderChange(dp.provider)}
                >
                  <span class="provider-option-status">
                    <span class="status-dot status-dot--ok"></span>
                  </span>
                  <span class="provider-option-label">{PROVIDER_LABELS[dp.provider] ?? dp.provider}</span>
                  <span class="provider-option-hint">Detected at {dp.url}</span>
                </button>
              {/each}

              <!-- Enable Ollama button (only if not already detected) -->
              {#if !detectedProviders.some(p => p.provider === 'ollama' && p.available) && !ollamaEnabled}
                <div class="enable-ollama-section">
                  <div class="enable-ollama-info">
                    <p class="enable-ollama-title">Ollama not detected</p>
                    <p class="enable-ollama-desc">
                      We can add Ollama to your stack and pull two small default models
                      ({OLLAMA_DEFAULT_MODELS.chat} + {OLLAMA_DEFAULT_MODELS.embedding}).
                    </p>
                  </div>

                  {#if ollamaEnableError}
                    <p class="field-error" role="alert">{ollamaEnableError}</p>
                  {/if}

                  {#if enablingOllama}
                    <div class="ollama-progress">
                      <span class="spinner"></span>
                      <span>{ollamaEnableProgress}</span>
                    </div>
                  {:else}
                    <button
                      class="btn btn-outline enable-ollama-btn"
                      type="button"
                      onclick={() => void enableOllama()}
                    >
                      Enable Ollama
                    </button>
                  {/if}
                </div>
              {/if}

              {#if ollamaEnabled}
                <div class="connection-success" role="status">
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span>Ollama enabled — default models pulled.</span>
                </div>
              {/if}

              <!-- Show provider selector for non-detected local providers -->
              {#if !detectedProviders.some(p => p.available)}
                <div class="field-group">
                  <label for="local-provider">Provider</label>
                  <select
                    id="local-provider"
                    value={llmProvider}
                    onchange={(e) => handleProviderChange(e.currentTarget.value)}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="model-runner">Docker Model Runner</option>
                  </select>
                </div>
              {/if}
            {/if}

            <div class="field-group">
              <label for="llm-base-url-local">Base URL</label>
              <input
                id="llm-base-url-local"
                type="url"
                bind:value={llmBaseUrl}
                placeholder="Provider base URL"
              />
              {#if LOCAL_PROVIDER_HELP[llmProvider]}
                <p class="field-hint">{LOCAL_PROVIDER_HELP[llmProvider]}</p>
              {:else}
                <p class="field-hint">Auto-detected from your running provider.</p>
              {/if}
            </div>

            {#if connectError}
              <p class="field-error" role="alert">{connectError}</p>
            {/if}

            {#if connectionTested && !ollamaEnabled}
              <div class="connection-success" role="status">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Connected — {modelList.length} model{modelList.length !== 1 ? 's' : ''} found.</span>
              </div>
            {/if}

            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => { connectionType = null; }}>Back</button>
              {#if !ollamaEnabled}
                <button
                  class="btn btn-outline"
                  onclick={() => void testConnection()}
                  disabled={testingConnection}
                >
                  {#if testingConnection}
                    <span class="spinner"></span>
                    Testing...
                  {:else}
                    Test Connection
                  {/if}
                </button>
              {/if}
              <button
                class="btn btn-primary"
                disabled={!connectionTested}
                onclick={() => { step = 'models'; }}
              >Next</button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Step 3: Models -->
      {#if step === 'models'}
        <div class="step-content" data-testid="step-models">
          <h2>Select Models</h2>
          <p class="step-description">Choose which models to use for each role.</p>

          <div class="field-group">
            <label for="system-model">System Model</label>
            <select id="system-model" bind:value={systemModel}>
              {#each modelList as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
            <p class="field-hint">Used for message routing, safety, and memory reasoning.</p>
          </div>

          <div class="field-group">
            <label for="embedding-model">Embedding Model</label>
            <select
              id="embedding-model"
              value={embeddingModel}
              onchange={(e) => handleEmbeddingModelChange(e.currentTarget.value)}
            >
              {#each modelList as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
            <p class="field-hint">Used for memory vector embeddings. Changing this later requires a collection reset.</p>
          </div>

          <div class="field-group">
            <label for="embedding-dims">Embedding Dimensions</label>
            <input id="embedding-dims" type="number" bind:value={embeddingDims} min="1" step="1" />
            <p class="field-hint">Auto-filled for known models. Edit if using a custom model.</p>
          </div>

          <div class="field-group">
            <label for="openmemory-user-id">OpenMemory User ID</label>
            <input id="openmemory-user-id" type="text" bind:value={openmemoryUserId} placeholder="default_user" />
            <p class="field-hint">Identifies the memory owner. Use a unique name if running multiple instances.</p>
          </div>

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'provider')}>Back</button>
            <button class="btn btn-primary" onclick={() => (step = 'review')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 4: Review & Install -->
      {#if step === 'review'}
        <div class="step-content" data-testid="step-review">
          <h2>Review & Install</h2>
          <div class="review-grid">
            <div class="review-item">
              <span class="review-label">Admin Token</span>
              <span class="review-value mono">Set</span>
            </div>
            <div class="review-item">
              <span class="review-label">Connection</span>
              <span class="review-value">{connectionType === 'local' ? 'Local' : 'Cloud'} — {PROVIDER_LABELS[llmProvider] ?? llmProvider}</span>
            </div>
            {#if llmApiKey}
              <div class="review-item">
                <span class="review-label">API Key</span>
                <span class="review-value mono">{maskedApiKey}</span>
              </div>
            {/if}
            <div class="review-item">
              <span class="review-label">Base URL</span>
              <span class="review-value mono">{llmBaseUrl || '(default)'}</span>
            </div>
            {#if ollamaEnabled}
              <div class="review-item">
                <span class="review-label">Ollama</span>
                <span class="review-value">Enabled (in-stack)</span>
              </div>
            {/if}
            <div class="review-item">
              <span class="review-label">System Model</span>
              <span class="review-value mono">{systemModel}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Embedding Model</span>
              <span class="review-value mono">{embeddingModel}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Embedding Dimensions</span>
              <span class="review-value mono">{embeddingDims}</span>
            </div>
            <div class="review-item">
              <span class="review-label">OpenMemory User ID</span>
              <span class="review-value">{openmemoryUserId}</span>
            </div>
          </div>

          {#if installError}
            <p class="install-error" role="alert">{installError}</p>
          {/if}

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'models')} disabled={installing}>Back</button>
            <button class="btn btn-primary" onclick={handleInstall} disabled={installing}>
              {#if installing}
                <span class="spinner"></span>
                Installing...
              {:else}
                Install Stack
              {/if}
            </button>
          </div>

          {#if installing}
            <p class="install-progress">Pulling container images and starting services...</p>
          {/if}
        </div>
      {/if}
    </section>
  </main>
{/if}

<style>
  /* ── Setup Page ──────────────────────────────────────────────────────── */
  .setup-page {
    min-height: 100vh;
    max-width: none;
    margin: 0;
    display: grid;
    padding: var(--space-6);
    background: var(--color-bg-secondary);
    align-content: start;

    background-image: url('/wizard.png');
    background-size: contain;
    background-position: bottom left;
    background-repeat: no-repeat;
    padding: var(--space-4);
    border-radius: var(--radius-md);
  }

  .wizard-card {
    width: stretch;
    max-width: 560px;
    height: min-content;
    place-self: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    padding: var(--space-8);
  }

  .wizard-header {
    margin-bottom: var(--space-6);
  }

  .wizard-header h1 {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
  }

  .wizard-subtitle {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ── Loading ─────────────────────────────────────────────────────────── */
  .loading-state {
    display: flex;
    justify-content: center;
    padding: var(--space-8);
  }

  /* ── Step Indicators ─────────────────────────────────────────────────── */
  .step-indicators {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: var(--space-6);
  }

  .step-dot {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: default;
    transition: all var(--transition-fast);
  }

  .step-dot.active {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #000;
  }

  .step-dot.completed {
    border-color: var(--color-success);
    background: var(--color-success);
    color: #fff;
    cursor: pointer;
  }

  .step-line {
    width: 36px;
    height: 2px;
    background: var(--color-border);
    transition: background var(--transition-fast);
  }

  .step-line.active {
    background: var(--color-success);
  }

  /* ── Step Content ────────────────────────────────────────────────────── */
  .step-content h2 {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .step-description {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-4);
  }

  .field-group {
    margin-bottom: var(--space-4);
  }

  .field-group label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-1);
  }

  .field-group input,
  .field-group select {
    width: 100%;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 12px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .field-group input:focus,
  .field-group select:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .field-hint {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }


  .field-error {
    margin: 0 0 var(--space-2);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  /* ── Connection Type Cards ───────────────────────────────────────────── */
  .connection-type-card {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-4) var(--space-5);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    margin-bottom: var(--space-3);
    transition: all var(--transition-fast);
  }

  .connection-type-card:hover {
    border-color: var(--color-primary);
    background: var(--color-bg-secondary);
  }

  .connection-type-icon {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-secondary);
    border-radius: var(--radius-md);
    color: var(--color-primary);
  }

  .connection-type-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .connection-type-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .connection-type-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  /* ── Provider Quick Picks ────────────────────────────────────────────── */
  .provider-quick-picks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .provider-chip {
    padding: 6px 14px;
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-bg);
    color: var(--color-text);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .provider-chip:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .provider-chip.selected {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #000;
  }

  /* ── Enable Ollama Section ───────────────────────────────────────────── */
  .enable-ollama-section {
    padding: var(--space-4);
    background: var(--color-bg-secondary);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);
  }

  .enable-ollama-info {
    margin-bottom: var(--space-3);
  }

  .enable-ollama-title {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
    margin: 0 0 var(--space-1);
  }

  .enable-ollama-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin: 0;
    line-height: 1.4;
  }

  .enable-ollama-btn {
    width: 100%;
  }

  .ollama-progress {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    padding: var(--space-2) 0;
  }

  /* ── Connection Success ──────────────────────────────────────────────── */
  .connection-success {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-success-bg, rgba(64, 192, 87, 0.1));
    border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.25));
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  /* ── Step Actions ────────────────────────────────────────────────────── */
  .step-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  /* ── Review Grid ─────────────────────────────────────────────────────── */
  .review-grid {
    display: grid;
    gap: var(--space-3);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .review-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }

  .review-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .review-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    text-align: right;
    word-break: break-all;
  }

  .review-value.mono {
    font-family: var(--font-mono);
  }

  /* ── Install State ───────────────────────────────────────────────────── */
  .install-error {
    margin-top: var(--space-3);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  .install-progress {
    margin-top: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-align: center;
  }

  /* ── Done State ──────────────────────────────────────────────────────── */
  .done-state {
    text-align: center;
    padding: var(--space-4) 0;
  }

  .done-icon {
    display: inline-block;
    margin-bottom: var(--space-4);
  }

  .done-state h2 {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .done-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-5);
  }

  .service-list {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    margin-bottom: var(--space-6);
  }

  .service-list li {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-success-bg);
    color: var(--color-success);
    border: 1px solid var(--color-success-border);
    padding: 2px 10px;
    border-radius: var(--radius-full);
  }

  .console-link {
    display: inline-flex;
    text-decoration: none;
  }

  /* ── Shared Button Styles ────────────────────────────────────────────── */
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

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
    border-color: var(--color-border-hover);
  }

  .btn-outline {
    background: transparent;
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08));
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

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  @media (max-width: 480px) {
    .wizard-card {
      padding: var(--space-5);
    }

    .review-item {
      flex-direction: column;
      align-items: flex-start;
    }

    .review-value {
      text-align: left;
    }
  }

  /* ── Provider Option Buttons ─────────────────────────────────────────── */
  .provider-option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text);
    margin-bottom: var(--space-2);
    transition: all var(--transition-fast);
  }

  .provider-option:hover {
    border-color: var(--color-primary);
    background: var(--color-bg-secondary);
  }

  .provider-option.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08));
  }

  .provider-option-status {
    display: flex;
    align-items: center;
  }

  .status-dot--ok {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-success);
  }

  .provider-option-label {
    flex: 1;
    font-weight: var(--font-medium);
  }

  .provider-option-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }
</style>
