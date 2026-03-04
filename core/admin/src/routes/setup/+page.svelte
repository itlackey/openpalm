<script lang="ts">
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // ── Wizard state ────────────────────────────────────────────────────────
  type WizardStep = 'token' | 'connect' | 'local-models' | 'models' | 'review';
  let step: WizardStep = $state('token');
  let setupComplete = $state(false);
  let loading = $state(true);

  // Step ordering helpers
  const STEP_ORDER: WizardStep[] = ['token', 'connect', 'local-models', 'models', 'review'];
  function isAfter(a: WizardStep, b: WizardStep): boolean {
    return STEP_ORDER.indexOf(a) > STEP_ORDER.indexOf(b);
  }

  // ── Provider constants (duplicated from server to avoid import) ────────
  const LLM_PROVIDERS = [
    'openai', 'anthropic', 'ollama', 'groq', 'together',
    'mistral', 'deepseek', 'xai', 'lmstudio'
  ];

  const PROVIDER_DEFAULT_URLS: Record<string, string> = {
    openai: 'https://api.openai.com',
    groq: 'https://api.groq.com/openai',
    mistral: 'https://api.mistral.ai',
    together: 'https://api.together.xyz',
    deepseek: 'https://api.deepseek.com',
    xai: 'https://api.x.ai',
    lmstudio: 'http://host.docker.internal:1234',
    ollama: 'http://host.docker.internal:11434',
  };

  // Providers that don't need an API key
  const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio']);

  const EMBEDDING_DIMS: Record<string, number> = {
    'openai/text-embedding-3-small': 1536,
    'openai/text-embedding-3-large': 3072,
    'openai/text-embedding-ada-002': 1536,
    'ollama/nomic-embed-text': 768,
    'ollama/mxbai-embed-large': 1024,
    'ollama/all-minilm': 384,
    'ollama/snowflake-arctic-embed': 1024,
  };

  // ── Form fields ─────────────────────────────────────────────────────────
  let adminToken = $state('');
  let setupSessionToken = $state(untrack(() => data.setupToken ?? ''));

  // Step 2 — Connect
  let llmProvider = $state('openai');
  let llmApiKey = $state('');
  let llmBaseUrl = $state(PROVIDER_DEFAULT_URLS['openai'] ?? '');

  // Step 3 — Models
  let guardianModel = $state('');
  let memoryModel = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let openmemoryUserId = $state(untrack(() => data.detectedUserId ?? 'default_user'));

  // Model list state
  let modelList: string[] = $state([]);
  let modelListLoading = $state(false);
  let modelListError = $state('');

  // Step 3 — Local Models (Docker Model Runner)
  type SuggestedModel = { id: string; label: string; size: string; contextSize?: number; dimensions?: number };
  let localSystemModel = $state('');
  let localEmbeddingModel = $state('');
  let localEmbeddingDims = $state(384);
  let modelRunnerAvailable = $state(false);
  let modelRunnerChecking = $state(false);
  let modelRunnerChecked = $state(false);
  let suggestedSystemModels: SuggestedModel[] = $state([]);
  let suggestedEmbeddingModels: SuggestedModel[] = $state([]);
  let localEmbeddingDimsMap: Record<string, number> = $state({});
  let useCustomSystemModel = $state(false);
  let useCustomEmbeddingModel = $state(false);
  let customSystemModelUrl = $state('');
  let customEmbeddingModelUrl = $state('');

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

  // ── Event handlers for provider/model changes ─────────────────────────

  function handleProviderChange(newProvider: string): void {
    llmProvider = newProvider;
    // Auto-fill base URL if current URL is a provider default or empty
    if (!llmBaseUrl || Object.values(PROVIDER_DEFAULT_URLS).includes(llmBaseUrl)) {
      llmBaseUrl = PROVIDER_DEFAULT_URLS[newProvider] ?? '';
    }
    // Reset connection state for new provider
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
      : NO_KEY_PROVIDERS.has(llmProvider) ? '(not required)' : '(not set)'
  );

  let needsApiKey = $derived(!NO_KEY_PROVIDERS.has(llmProvider));

  // ── Local Model Runner detection ────────────────────────────────────

  async function checkModelRunner(): Promise<void> {
    if (modelRunnerChecked) return;
    modelRunnerChecking = true;
    try {
      const res = await fetch('/admin/models/local', {
        headers: buildHeaders(setupSessionToken)
      });
      if (res.ok) {
        const data = await res.json();
        modelRunnerAvailable = data.modelRunnerAvailable ?? false;
        suggestedSystemModels = data.suggestedSystemModels ?? [];
        suggestedEmbeddingModels = data.suggestedEmbeddingModels ?? [];
        localEmbeddingDimsMap = data.embeddingDims ?? {};
      }
    } catch {
      modelRunnerAvailable = false;
    } finally {
      modelRunnerChecking = false;
      modelRunnerChecked = true;
    }
  }

  function handleLocalEmbeddingChange(model: string): void {
    localEmbeddingModel = model;
    if (localEmbeddingDimsMap[model]) {
      localEmbeddingDims = localEmbeddingDimsMap[model];
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
      modelList = result.models ?? [];
      connectionTested = true;

      // Pre-select first model for each role if not already set
      if (modelList.length > 0) {
        if (!guardianModel) guardianModel = modelList[0];
        if (!memoryModel) memoryModel = modelList[0];
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
          guardianModel,
          memoryModel,
          embeddingModel,
          embeddingDims,
          openmemoryUserId,
          localSystemModel: useCustomSystemModel ? customSystemModelUrl : localSystemModel,
          localEmbeddingModel: useCustomEmbeddingModel ? customEmbeddingModelUrl : localEmbeddingModel,
          localEmbeddingDims
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
        <button
          class="step-dot"
          class:active={step === 'token'}
          class:completed={isAfter(step, 'token')}
          onclick={() => { step = 'token'; }}
          aria-label="Step 1: Admin Token"
          aria-current={step === 'token' ? 'step' : undefined}
        >1</button>
        <span class="step-line" class:active={isAfter(step, 'token')}></span>
        <button
          class="step-dot"
          class:active={step === 'connect'}
          class:completed={isAfter(step, 'connect')}
          onclick={() => { if (isAfter(step, 'connect')) step = 'connect'; }}
          aria-label="Step 2: System LLM Connection"
          aria-current={step === 'connect' ? 'step' : undefined}
        >2</button>
        <span class="step-line" class:active={isAfter(step, 'connect')}></span>
        <button
          class="step-dot"
          class:active={step === 'local-models'}
          class:completed={isAfter(step, 'local-models')}
          onclick={() => { if (isAfter(step, 'local-models')) step = 'local-models'; }}
          aria-label="Step 3: Local Models"
          aria-current={step === 'local-models' ? 'step' : undefined}
        >3</button>
        <span class="step-line" class:active={isAfter(step, 'local-models')}></span>
        <button
          class="step-dot"
          class:active={step === 'models'}
          class:completed={isAfter(step, 'models')}
          onclick={() => { if (isAfter(step, 'models')) step = 'models'; }}
          aria-label="Step 4: Models"
          aria-current={step === 'models' ? 'step' : undefined}
        >4</button>
        <span class="step-line" class:active={isAfter(step, 'models')}></span>
        <button
          class="step-dot"
          class:active={step === 'review'}
          aria-label="Step 5: Review & Install"
          aria-current={step === 'review' ? 'step' : undefined}
          disabled
        >5</button>
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
              step = 'connect';
            }}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 2: System LLM Connection -->
      {#if step === 'connect'}
        <div class="step-content" data-testid="step-connect">
          <h2>System LLM Connection</h2>
          <p class="step-description">Connect to an LLM provider for memory, embeddings, and guardian routing.</p>

          <div class="field-group">
            <label for="llm-provider">Provider</label>
            <select
              id="llm-provider"
              value={llmProvider}
              onchange={(e) => handleProviderChange(e.currentTarget.value)}
            >
              {#each LLM_PROVIDERS as p}
                <option value={p}>{p}</option>
              {/each}
            </select>
          </div>

          {#if needsApiKey}
            <div class="field-group">
              <label for="llm-api-key">API Key</label>
              <input
                id="llm-api-key"
                type="password"
                bind:value={llmApiKey}
                placeholder={llmProvider === 'openai' ? 'sk-...' : 'Enter API key'}
              />
            </div>
          {/if}

          <div class="field-group">
            <label for="llm-base-url">Base URL</label>
            <input
              id="llm-base-url"
              type="url"
              bind:value={llmBaseUrl}
              placeholder="Provider base URL"
            />
            <p class="field-hint">
              {#if llmProvider === 'ollama'}
                Default: <code>http://host.docker.internal:11434</code>
              {:else if llmProvider === 'lmstudio'}
                Default: <code>http://host.docker.internal:1234</code>
              {:else}
                Leave default unless using a custom endpoint.
              {/if}
            </p>
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
            <button class="btn btn-secondary" onclick={() => (step = 'token')}>Back</button>
            <button
              class="btn btn-outline"
              onclick={() => void testConnection()}
              disabled={testingConnection || (needsApiKey && !llmApiKey.trim())}
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
              onclick={() => { step = 'local-models'; void checkModelRunner(); }}
            >Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 3: Local Models (Docker Model Runner) -->
      {#if step === 'local-models'}
        <div class="step-content" data-testid="step-local-models">
          <h2>Local Models</h2>
          <p class="step-description">Optionally run AI models locally with Docker Model Runner. No API costs, full data privacy.</p>

          {#if modelRunnerChecking}
            <div class="loading-state" style="justify-content: flex-start; padding: var(--space-4) 0;">
              <span class="spinner"></span>
              <span style="font-size: var(--text-sm); color: var(--color-text-secondary); margin-left: var(--space-2);">Checking Docker Model Runner...</span>
            </div>
          {:else if !modelRunnerAvailable}
            <div class="info-banner" role="status">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div>
                <p>Docker Model Runner is not detected.</p>
                <p class="field-hint" style="margin-top: var(--space-1);">Enable it in Docker Desktop settings or install Docker Model Runner on your Linux host. You can configure local models later in the admin panel.</p>
              </div>
            </div>
          {:else}
            <div class="connection-success" role="status" style="margin-bottom: var(--space-4);">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span>Docker Model Runner detected.</span>
            </div>

            <!-- System Model -->
            <div class="field-group">
              <label for="local-system-model">System Model (Guardian + Memory)</label>
              {#if useCustomSystemModel}
                <input
                  id="local-system-model"
                  type="text"
                  bind:value={customSystemModelUrl}
                  placeholder="hf.co/username/model-name-GGUF"
                />
                <p class="field-hint">
                  Enter a HuggingFace GGUF model URL (must start with <code>hf.co/</code>).
                  <button class="link-btn" type="button" onclick={() => { useCustomSystemModel = false; customSystemModelUrl = ''; }}>Use suggested model</button>
                </p>
              {:else}
                <select
                  id="local-system-model"
                  value={localSystemModel}
                  onchange={(e) => { localSystemModel = e.currentTarget.value; }}
                >
                  <option value="">None (use cloud provider)</option>
                  {#each suggestedSystemModels as m}
                    <option value={m.id}>{m.label} — {m.size}</option>
                  {/each}
                  <option value="__custom__">Custom (HuggingFace)...</option>
                </select>
                {#if localSystemModel === '__custom__'}
                  <script>
                    // Switch to custom mode when selected
                  </script>
                {/if}
                <p class="field-hint">
                  Used for message routing, memory reasoning, and system tasks.
                </p>
              {/if}
            </div>

            <!-- Embedding Model -->
            <div class="field-group">
              <label for="local-embedding-model">Embedding Model (Memory)</label>
              {#if useCustomEmbeddingModel}
                <input
                  id="local-embedding-model"
                  type="text"
                  bind:value={customEmbeddingModelUrl}
                  placeholder="hf.co/username/model-name-GGUF"
                />
                <div class="field-group" style="margin-top: var(--space-2); margin-bottom: 0;">
                  <label for="local-embedding-dims-custom">Embedding Dimensions</label>
                  <input id="local-embedding-dims-custom" type="number" bind:value={localEmbeddingDims} min="1" step="1" />
                </div>
                <p class="field-hint">
                  Enter a HuggingFace GGUF embedding model URL.
                  <button class="link-btn" type="button" onclick={() => { useCustomEmbeddingModel = false; customEmbeddingModelUrl = ''; }}>Use suggested model</button>
                </p>
              {:else}
                <select
                  id="local-embedding-model"
                  value={localEmbeddingModel}
                  onchange={(e) => {
                    const val = e.currentTarget.value;
                    if (val === '__custom__') {
                      useCustomEmbeddingModel = true;
                      localEmbeddingModel = '';
                    } else {
                      handleLocalEmbeddingChange(val);
                    }
                  }}
                >
                  <option value="">None (use cloud provider)</option>
                  {#each suggestedEmbeddingModels as m}
                    <option value={m.id}>{m.label} — {m.size} ({m.dimensions}d)</option>
                  {/each}
                  <option value="__custom__">Custom (HuggingFace)...</option>
                </select>
                <p class="field-hint">
                  Used for memory vector embeddings. Changing this later requires a collection reset.
                </p>
              {/if}
            </div>
          {/if}

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'connect')}>Back</button>
            <button
              class="btn btn-primary"
              onclick={() => {
                // Handle __custom__ selection for system model
                if (localSystemModel === '__custom__') {
                  useCustomSystemModel = true;
                  localSystemModel = '';
                }
                step = 'models';
              }}
            >{modelRunnerAvailable && !modelRunnerChecking ? 'Next' : 'Skip'}</button>
          </div>
        </div>
      {/if}

      <!-- Step 4: Models -->
      {#if step === 'models'}
        <div class="step-content" data-testid="step-models">
          <h2>Select Models</h2>
          <p class="step-description">Choose which models to use for each role.{#if localSystemModel || localEmbeddingModel || customSystemModelUrl || customEmbeddingModelUrl} Local models will be pre-selected where configured.{/if}</p>

          <div class="field-group">
            <label for="guardian-model">Guardian Model</label>
            <select id="guardian-model" bind:value={guardianModel}>
              {#each modelList as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
            <p class="field-hint">Used for message routing and safety decisions.</p>
          </div>

          <div class="field-group">
            <label for="memory-model">Memory Model</label>
            <select id="memory-model" bind:value={memoryModel}>
              {#each modelList as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
            <p class="field-hint">Used by OpenMemory for memory reasoning (mem0 LLM).</p>
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
            <input
              id="embedding-dims"
              type="number"
              bind:value={embeddingDims}
              min="1"
              step="1"
            />
            <p class="field-hint">Auto-filled for known models. Edit if using a custom model.</p>
          </div>

          <div class="field-group">
            <label for="openmemory-user-id">OpenMemory User ID</label>
            <input
              id="openmemory-user-id"
              type="text"
              bind:value={openmemoryUserId}
              placeholder="default_user"
            />
            <p class="field-hint">Identifies the memory owner. Use a unique name if running multiple instances.</p>
          </div>

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'local-models')}>Back</button>
            <button class="btn btn-primary" onclick={() => (step = 'review')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 5: Review & Install -->
      {#if step === 'review'}
        <div class="step-content" data-testid="step-review">
          <h2>Review & Install</h2>
          <div class="review-grid">
            <div class="review-item">
              <span class="review-label">Admin Token</span>
              <span class="review-value mono">Set</span>
            </div>
            <div class="review-item">
              <span class="review-label">LLM Provider</span>
              <span class="review-value">{llmProvider}</span>
            </div>
            <div class="review-item">
              <span class="review-label">API Key</span>
              <span class="review-value mono">{maskedApiKey}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Base URL</span>
              <span class="review-value mono">{llmBaseUrl || '(default)'}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Guardian Model</span>
              <span class="review-value mono">{guardianModel}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Memory Model</span>
              <span class="review-value mono">{memoryModel}</span>
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
            {#if localSystemModel || customSystemModelUrl}
              <div class="review-item">
                <span class="review-label">Local System Model</span>
                <span class="review-value mono">{useCustomSystemModel ? customSystemModelUrl : localSystemModel}</span>
              </div>
            {/if}
            {#if localEmbeddingModel || customEmbeddingModelUrl}
              <div class="review-item">
                <span class="review-label">Local Embedding Model</span>
                <span class="review-value mono">{useCustomEmbeddingModel ? customEmbeddingModelUrl : localEmbeddingModel}</span>
              </div>
            {/if}
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

  .field-hint code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .field-error {
    margin: 0 0 var(--space-2);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  /* ── Info Banner ────────────────────────────────────────────────────── */
  .info-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-4);
  }

  .info-banner p {
    margin: 0;
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--color-primary);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }

  .link-btn:hover {
    color: var(--color-primary-hover);
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
</style>
