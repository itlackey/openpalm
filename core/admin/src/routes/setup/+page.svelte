<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { LLM_PROVIDERS, PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, LOCAL_PROVIDER_HELP, EMBEDDING_DIMS, OLLAMA_DEFAULT_MODELS } from '$lib/provider-constants.js';
  import { SETUP_WIZARD_COPY } from '$lib/setup-wizard/copy.js';
  import { mapModelDiscoveryError } from '$lib/model-discovery.js';
  import WizardShell from '$lib/components/setup-wizard/WizardShell.svelte';
  import ConnectionPicker from '$lib/components/setup-wizard/ConnectionPicker.svelte';
  import ModelSelector from '$lib/components/setup-wizard/ModelSelector.svelte';
  import {
    createInitialDraft,
    createConnectionDraft,
    isAfterScreen,
    parseWizardScreen,
    type WizardScreen,
    type WizardConnectionDraft,
  } from '$lib/setup-wizard/state.js';
  import type { LocalProviderDetection } from '$lib/api.js';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  // svelte-ignore state_referenced_locally
  const { setupToken = '', detectedUserId = 'default_user' } = data;

  // ── Wizard state ────────────────────────────────────────────────────────
  const initialDraft = createInitialDraft(detectedUserId);
  let screen: WizardScreen = $state(initialDraft.screen);
  let setupComplete = $state(false);
  let loading = $state(true);

  // ── Form fields ─────────────────────────────────────────────────────────
  let ownerName = $state('');
  let ownerEmail = $state('');
  let adminToken = $state('');
  let setupSessionToken = $state(setupToken);

  // ── Multi-connection state ──────────────────────────────────────────────
  let connections: WizardConnectionDraft[] = $state([]);
  let editingConnectionIndex = $state(-1);
  let addingNewConnection = $state(false);

  // Derived: the connection currently being edited
  let editingConnection = $derived(
    editingConnectionIndex >= 0 && editingConnectionIndex < connections.length
      ? connections[editingConnectionIndex]
      : null
  );

  // ── Capability assignments ──────────────────────────────────────────────
  let llmConnectionId = $state('');
  let llmModel = $state('');
  let llmSmallModel = $state('');
  let embeddingConnectionId = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let memoryUserId = $state(initialDraft.memoryUserId);

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

  // ── Install state ───────────────────────────────────────────────────────
  let installing = $state(false);
  let installError = $state('');
  let startedServices: string[] = $state([]);

  // ── Deploy progress state ─────────────────────────────────────────────
  type ServiceDeployInfo = {
    service: string;
    label: string;
    imageReady: boolean;
    containerRunning: boolean;
    error?: string;
  };
  let deployPhase: 'pulling' | 'starting' | 'ready' | 'error' | null = $state(null);
  let deployMessage = $state('');
  let deployServices: ServiceDeployInfo[] = $state([]);
  let deployError = $state('');
  let deployPollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Validation ──────────────────────────────────────────────────────────
  let tokenError = $state('');
  let connectError = $state('');
  let testingConnection = $state(false);

  // ── Derived helpers ─────────────────────────────────────────────────────

  function getConnectionById(id: string): WizardConnectionDraft | undefined {
    return connections.find(c => c.id === id);
  }

  let llmConnection = $derived(getConnectionById(llmConnectionId));
  let embConnection = $derived(getConnectionById(embeddingConnectionId));

  let llmModelList = $derived(llmConnection?.modelList ?? []);
  let embModelList = $derived(embConnection?.modelList ?? []);

  function maskedKey(key: string): string {
    return key ? key.slice(0, 3) + '...' + key.slice(-4) : '(not set)';
  }

  function validateConnectionFields(): string {
    if (!editingConnection) return 'No connection being edited.';
    if (!editingConnection.provider) return 'Select a provider before continuing.';
    if (editingConnection.connectionType === 'cloud' && !editingConnection.apiKey.trim() && editingConnection.provider !== 'anthropic') {
      return 'API key is required for cloud providers.';
    }
    if (editingConnection.connectionType === 'local' && !editingConnection.baseUrl.trim()) {
      return 'Base URL is required for local providers.';
    }
    return '';
  }

  // ── API helpers ─────────────────────────────────────────────────────────

  function buildHeaders(token = ''): HeadersInit {
    return {
      'x-requested-by': 'ui',
      'x-request-id': crypto.randomUUID(),
      ...(token ? { 'x-admin-token': token } : {})
    };
  }

  function goToScreen(next: WizardScreen): void {
    screen = next;
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('screen', next);
    try {
      replaceState(url, {});
    } catch {
      window.history.replaceState({}, '', url);
    }
  }

  onMount(() => {
    const parsed = parseWizardScreen(new URL(window.location.href).searchParams.get('screen'));
    if (parsed) {
      screen = parsed;
    }
  });

  // ── Connection management ───────────────────────────────────────────────

  function startNewConnection(): void {
    const id = connections.length === 0 ? 'primary' : crypto.randomUUID().slice(0, 8);
    const draft = createConnectionDraft(id);
    connections = [...connections, draft];
    editingConnectionIndex = connections.length - 1;
    addingNewConnection = connections.length > 1;
    connectError = '';
    goToScreen('connection-type');
  }

  function selectConnectionType(type: 'cloud' | 'local'): void {
    if (!editingConnection) return;
    const idx = editingConnectionIndex;
    const updated = { ...editingConnection, connectionType: type, tested: false, modelList: [] as string[] };

    if (type === 'cloud') {
      updated.provider = 'openai';
      updated.baseUrl = PROVIDER_DEFAULT_URLS['openai'] ?? '';
      updated.apiKey = '';
      connections = connections.map((c, i) => i === idx ? updated : c);
      goToScreen('cloud-provider');
    } else {
      updated.provider = 'ollama';
      updated.baseUrl = PROVIDER_DEFAULT_URLS['ollama'] ?? '';
      updated.apiKey = '';
      connections = connections.map((c, i) => i === idx ? updated : c);
      void detectLocalProviders();
      goToScreen('local-provider');
    }
  }

  function handleProviderChange(newProvider: string): void {
    if (!editingConnection) return;
    const idx = editingConnectionIndex;
    const detected = detectedProviders.find(p => p.provider === newProvider && p.available);
    let baseUrl = editingConnection.baseUrl;
    if (detected) {
      baseUrl = detected.url;
    } else if (!baseUrl || Object.values(PROVIDER_DEFAULT_URLS).includes(baseUrl)) {
      baseUrl = PROVIDER_DEFAULT_URLS[newProvider] ?? '';
    }
    const updated: WizardConnectionDraft = {
      ...editingConnection,
      provider: newProvider,
      baseUrl,
      name: PROVIDER_LABELS[newProvider] ?? newProvider,
      tested: false,
      modelList: [],
    };
    connections = connections.map((c, i) => i === idx ? updated : c);
    connectError = '';
  }

  function updateEditingField(field: keyof WizardConnectionDraft, value: string): void {
    if (!editingConnection) return;
    const idx = editingConnectionIndex;
    connections = connections.map((c, i) =>
      i === idx ? { ...c, [field]: value } : c
    );
  }

  function finalizeConnection(): void {
    if (!editingConnection) return;
    const idx = editingConnectionIndex;
    // Auto-name if empty
    if (!editingConnection.name) {
      connections = connections.map((c, i) =>
        i === idx ? { ...c, name: PROVIDER_LABELS[c.provider] ?? c.provider } : c
      );
    }

    // Set default assignments if this is the first connection
    if (connections.length === 1) {
      llmConnectionId = editingConnection.id;
      embeddingConnectionId = editingConnection.id;
    }

    addingNewConnection = false;
    goToScreen('models');
  }


  // ── Embedding model change handler ──────────────────────────────────────

  function handleEmbeddingModelChange(newModel: string): void {
    embeddingModel = newModel;
    const conn = getConnectionById(embeddingConnectionId);
    if (conn) {
      const key = `${conn.provider}/${newModel}`;
      if (EMBEDDING_DIMS[key]) {
        embeddingDims = EMBEDDING_DIMS[key];
      }
    }
  }

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

  // ── Enable Ollama handler (async with polling) ──────────────────────

  let ollamaPollTimer: ReturnType<typeof setInterval> | null = null;

  function stopOllamaPolling(): void {
    if (ollamaPollTimer) {
      clearInterval(ollamaPollTimer);
      ollamaPollTimer = null;
    }
  }

  function applyOllamaResult(result: Record<string, unknown>): void {
    if (!editingConnection) return;
    const idx = editingConnectionIndex;
    ollamaEnabled = true;
    const ollamaUrl = (result.ollamaUrl as string) ?? 'http://ollama:11434';

    const pulledModels: string[] = [];
    const failedModels: string[] = [];
    const models = result.models as Record<string, { ok: boolean }> | undefined;
    if (models) {
      for (const [name, status] of Object.entries(models)) {
        if (status.ok) pulledModels.push(name);
        else failedModels.push(name);
      }
    }

    const updated: WizardConnectionDraft = {
      ...editingConnection,
      provider: 'ollama',
      baseUrl: ollamaUrl,
      tested: true,
      modelList: pulledModels.sort(),
      name: 'Ollama',
    };
    connections = connections.map((c, i) => i === idx ? updated : c);

    if (pulledModels.length > 0) {
      llmModel = (result.defaultChatModel as string) ?? OLLAMA_DEFAULT_MODELS.chat;
      embeddingModel = (result.defaultEmbeddingModel as string) ?? OLLAMA_DEFAULT_MODELS.embedding;
      const dimsKey = `ollama/${embeddingModel}`;
      embeddingDims = EMBEDDING_DIMS[dimsKey] ?? 768;
    }
    if (failedModels.length > 0) {
      ollamaEnableError = `Ollama is running but failed to pull: ${failedModels.join(', ')}. You can pull them manually.`;
    }
  }

  async function pollOllamaStatus(): Promise<void> {
    try {
      const res = await fetch('/admin/setup/ollama', {
        headers: buildHeaders(setupSessionToken)
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.active) return;
      ollamaEnableProgress = data.message ?? 'Enabling Ollama...';

      if (data.phase === 'done') {
        stopOllamaPolling();
        applyOllamaResult(data);
        enablingOllama = false;
        ollamaEnableProgress = '';
        // Set assignments and skip to review
        if (editingConnection) {
          llmConnectionId = editingConnection.id;
          embeddingConnectionId = editingConnection.id;
        }
        goToScreen('review');
      } else if (data.phase === 'error') {
        stopOllamaPolling();
        ollamaEnableError = data.message ?? 'Ollama enable failed.';
        enablingOllama = false;
        ollamaEnableProgress = '';
      }
    } catch {
      // Network error during poll — keep trying
    }
  }

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
        enablingOllama = false;
        ollamaEnableProgress = '';
        return;
      }

      const result = await res.json();
      ollamaEnableProgress = result.message ?? 'Enabling Ollama in background...';
      stopOllamaPolling();
      ollamaPollTimer = setInterval(() => void pollOllamaStatus(), 3000);
    } catch {
      ollamaEnableError = 'Network error — unable to reach admin API.';
      enablingOllama = false;
      ollamaEnableProgress = '';
    }
  }

  // ── Test Connection handler ──────────────────────────────────────────

  async function testConnection(conn?: WizardConnectionDraft): Promise<void> {
    const target = conn ?? editingConnection;
    if (!target) return;
    testingConnection = true;
    connectError = '';
    try {
      const res = await fetch('/admin/setup/models', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders(setupSessionToken)
        },
        body: JSON.stringify({
          provider: target.provider,
          apiKey: target.apiKey,
          baseUrl: target.baseUrl,
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        connectError = data.message ?? `Connection test failed (HTTP ${res.status})`;
        return;
      }
      const result = await res.json();
      if (result.error) {
        connectError = mapModelDiscoveryError(result);
        return;
      }
      const apiModels: string[] = result.models ?? [];

      // Update the target connection with results
      const idx = connections.findIndex(c => c.id === target.id);
      if (idx >= 0) {
        const merged = new Set<string>(apiModels);
        if (llmModel && target.id === llmConnectionId) merged.add(llmModel);
        if (embeddingModel && target.id === embeddingConnectionId) merged.add(embeddingModel);
        const sorted = [...merged].sort();
        connections = connections.map((c, i) =>
          i === idx ? { ...c, tested: true, modelList: sorted } : c
        );

        // Pre-select models if not already set
        if (sorted.length > 0) {
          if (!llmModel && target.id === llmConnectionId) {
            llmModel = sorted[0];
          }
          if (!embeddingModel && target.id === embeddingConnectionId) {
            const embedCandidate = sorted.find(m =>
              m.includes('embed') || m.includes('ada')
            );
            embeddingModel = embedCandidate ?? sorted[0];
          }
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
          ownerName,
          ownerEmail,
          connections: connections.map(c => ({
            id: c.id,
            name: c.name,
            provider: c.provider,
            baseUrl: c.baseUrl,
            apiKey: c.apiKey,
          })),
          assignments: {
            llm: {
              connectionId: llmConnectionId,
              model: llmModel,
              ...(llmSmallModel ? { smallModel: llmSmallModel } : {}),
            },
            embeddings: {
              connectionId: embeddingConnectionId,
              model: embeddingModel,
              embeddingDims,
            },
          },
          memoryUserId,
          ollamaEnabled,
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        installError = data.message ?? `Install failed (HTTP ${res.status})`;
        installing = false;
        return;
      }
      const data = await res.json();
      startedServices = data.started ?? [];
      goToScreen('deploying');
      startDeployPolling();
    } catch {
      installError = 'Network error — unable to reach admin API.';
      installing = false;
    }
  }

  // ── Deploy status polling ─────────────────────────────────────────────

  function startDeployPolling(): void {
    stopDeployPolling();
    void pollDeployStatus();
    deployPollTimer = setInterval(() => void pollDeployStatus(), 2000);
  }

  function stopDeployPolling(): void {
    if (deployPollTimer) {
      clearInterval(deployPollTimer);
      deployPollTimer = null;
    }
  }

  async function pollDeployStatus(): Promise<void> {
    try {
      const res = await fetch('/admin/setup/deploy-status', {
        headers: buildHeaders(setupSessionToken)
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.active) return;
      deployPhase = data.phase;
      deployMessage = data.message ?? '';
      deployServices = data.services ?? [];

      if (data.phase === 'ready') {
        stopDeployPolling();
        installing = false;
      } else if (data.phase === 'error') {
        stopDeployPolling();
        deployError = data.error ?? data.message ?? 'Deployment failed.';
        installing = false;
      }
    } catch {
      // Network error — keep polling
    }
  }

  onDestroy(() => {
    stopDeployPolling();
    stopOllamaPolling();
  });

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
  <main class="setup-page" aria-label="Setup wizard">
    <WizardShell title={SETUP_WIZARD_COPY.wizardHeaderTitle} subtitle={SETUP_WIZARD_COPY.wizardHeaderSubtitle}>

      {#if screen !== 'deploying'}
        <nav class="step-indicators" aria-label="Wizard steps">
          <button class="step-dot" class:active={screen === 'token'} class:completed={isAfterScreen(screen, 'token')} onclick={() => goToScreen('token')} aria-label="Step 1: Admin Token" aria-current={screen === 'token' ? 'step' : undefined}>1</button>
          <span class="step-line" class:active={isAfterScreen(screen, 'token')}></span>
          <button class="step-dot" class:active={screen === 'connection-type' || screen === 'cloud-provider' || screen === 'local-provider'} class:completed={isAfterScreen(screen, 'connection-type')} onclick={() => { if (isAfterScreen(screen, 'connection-type')) goToScreen('connection-type'); }} aria-label="Step 2: Connection" aria-current={screen === 'connection-type' || screen === 'cloud-provider' || screen === 'local-provider' ? 'step' : undefined}>2</button>
          <span class="step-line" class:active={isAfterScreen(screen, 'connection-type')}></span>
          <button class="step-dot" class:active={screen === 'models'} class:completed={isAfterScreen(screen, 'models')} onclick={() => { if (isAfterScreen(screen, 'models')) goToScreen('models'); }} aria-label="Step 3: Models" aria-current={screen === 'models' ? 'step' : undefined}>3</button>
          <span class="step-line" class:active={isAfterScreen(screen, 'models')}></span>
          <button class="step-dot" class:active={screen === 'review' || screen === 'install'} aria-label="Step 4: Review & Install" aria-current={screen === 'review' || screen === 'install' ? 'step' : undefined} disabled>4</button>
        </nav>
      {/if}

      <!-- Step 1: Welcome -->
      {#if screen === 'token'}
        <div class="step-content" data-testid="step-token">
          <h2>Welcome</h2>
          <p class="step-description">Tell us a bit about yourself and set a secure admin token.</p>
          <div class="field-group">
            <label for="owner-name">Your Name</label>
            <input id="owner-name" type="text" bind:value={ownerName} placeholder="Jane Doe" />
            <p class="field-hint">Used as the default Memory user ID.</p>
          </div>
          <div class="field-group">
            <label for="owner-email">Email</label>
            <input id="owner-email" type="email" bind:value={ownerEmail} placeholder="jane@example.com" />
            <p class="field-hint">For account identification. Not shared externally.</p>
          </div>
          <div class="field-group">
            <label for="admin-token">Admin Token</label>
            <input id="admin-token" type="password" bind:value={adminToken} placeholder="Enter a secure admin token" />
            <p class="field-hint">This token protects your admin console. Keep it safe — you'll need it to log in.</p>
          </div>
          {#if tokenError}
            <p class="field-error" role="alert">{tokenError}</p>
          {/if}
          <div class="step-actions">
            <button class="btn btn-primary" onclick={() => {
              if (!ownerName.trim()) { tokenError = 'Name is required.'; return; }
              if (!adminToken.trim()) { tokenError = 'Admin token is required.'; return; }
              tokenError = '';
              if (!memoryUserId || memoryUserId === detectedUserId || memoryUserId === 'default_user') {
                memoryUserId = ownerName.trim().toLowerCase().replace(/\s+/g, '_');
              }
              startNewConnection();
            }}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 2: Connection -->
      {#if screen === 'connection-type' || screen === 'cloud-provider' || screen === 'local-provider'}
        <div class="step-content" data-testid="step-provider">

          {#if addingNewConnection && connections.length > 1}
            <div class="connections-summary">
              <h3 class="connections-summary-title">{SETUP_WIZARD_COPY.connectionSummaryTitle}</h3>
              {#each connections.slice(0, -1) as conn}
                <div class="connection-card">
                  <span class="connection-card-name">{conn.name || conn.provider}</span>
                  <span class="connection-card-detail">{conn.baseUrl || '(default URL)'}</span>
                </div>
              {/each}
            </div>
          {/if}

          {#if screen === 'connection-type'}
            <h2>{addingNewConnection ? 'Add Connection' : 'Connection Type'}</h2>
            <p class="step-description">{SETUP_WIZARD_COPY.connectionTypePrompt}</p>
            <ConnectionPicker onSelectCloud={() => selectConnectionType('cloud')} onSelectLocal={() => selectConnectionType('local')} />
            <div class="step-actions">
              {#if addingNewConnection}
                <button class="btn btn-secondary" onclick={() => {
                  connections = connections.slice(0, -1);
                  addingNewConnection = false;
                  goToScreen('models');
                }}>Cancel</button>
              {:else}
                <button class="btn btn-secondary" onclick={() => goToScreen('token')}>Back</button>
              {/if}
            </div>

          {:else if screen === 'cloud-provider' && editingConnection}
            <h2>Cloud Provider</h2>
            <p class="step-description">Pick a provider or enter custom connection details.</p>
            <div class="provider-quick-picks">
              {#each CLOUD_PROVIDERS as p}
                <button class="provider-chip" class:selected={editingConnection.provider === p} type="button" onclick={() => handleProviderChange(p)}>
                  {PROVIDER_LABELS[p] ?? p}
                </button>
              {/each}
            </div>
            <div class="field-group">
              <label for="llm-api-key">API Key</label>
              <input id="llm-api-key" type="password" value={editingConnection.apiKey} oninput={(e) => updateEditingField('apiKey', e.currentTarget.value)} placeholder="Enter your API key" />
            </div>
            <div class="field-group">
              <label for="llm-base-url">Base URL <span style="color: var(--color-text-tertiary); font-weight: normal;">(optional)</span></label>
              <input id="llm-base-url" type="url" value={editingConnection.baseUrl} oninput={(e) => updateEditingField('baseUrl', e.currentTarget.value)} placeholder="Provider base URL" />
              <p class="field-hint">Leave default unless using a custom endpoint or proxy.</p>
            </div>
            {#if connectError}
              <p class="field-error" role="alert">{connectError}</p>
            {/if}
            {#if editingConnection.tested}
              <div class="connection-success" role="status">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Connected — {editingConnection.modelList.length} model{editingConnection.modelList.length !== 1 ? 's' : ''} found.</span>
              </div>
            {/if}
            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => goToScreen('connection-type')}>Back</button>
              <button class="btn btn-outline" onclick={() => void testConnection()} disabled={testingConnection}>
                {#if testingConnection}<span class="spinner"></span> Testing...{:else}Test Connection{/if}
              </button>
              <button class="btn btn-primary" disabled={testingConnection} onclick={() => {
                const err = validateConnectionFields();
                if (err) { connectError = err; return; }
                finalizeConnection();
              }}>Next</button>
            </div>

          {:else if screen === 'local-provider' && editingConnection}
            <h2>Local Provider</h2>
            <p class="step-description">Connect to a local LLM running on your machine.</p>
            {#if detectingProviders}
              <div class="loading-state" style="justify-content: flex-start; padding: var(--space-4) 0;">
                <span class="spinner"></span>
                <span style="font-size: var(--text-sm); color: var(--color-text-secondary); margin-left: var(--space-2);">Detecting local providers...</span>
              </div>
            {/if}
            {#if providersDetected}
              {#each detectedProviders.filter(p => p.available) as dp}
                <button class="provider-option" class:selected={editingConnection.provider === dp.provider} type="button" onclick={() => handleProviderChange(dp.provider)}>
                  <span class="provider-option-status"><span class="status-dot status-dot--ok"></span></span>
                  <span class="provider-option-label">{PROVIDER_LABELS[dp.provider] ?? dp.provider}</span>
                  <span class="provider-option-hint">Detected at {dp.url}</span>
                </button>
              {/each}
              {#if !detectedProviders.some(p => p.provider === 'ollama' && p.available) && !ollamaEnabled}
                <div class="enable-ollama-section">
                  <div class="enable-ollama-info">
                    <p class="enable-ollama-title">Ollama not detected</p>
                    <p class="enable-ollama-desc">We can add Ollama to your stack and pull two small default models ({OLLAMA_DEFAULT_MODELS.chat} + {OLLAMA_DEFAULT_MODELS.embedding}).</p>
                  </div>
                  {#if ollamaEnableError}<p class="field-error" role="alert">{ollamaEnableError}</p>{/if}
                  {#if enablingOllama}
                    <div class="ollama-progress"><span class="spinner"></span><span>{ollamaEnableProgress}</span></div>
                  {:else}
                    <button class="btn btn-outline enable-ollama-btn" type="button" onclick={() => void enableOllama()}>Enable Ollama</button>
                  {/if}
                </div>
              {/if}
              {#if ollamaEnabled}
                <div class="connection-success" role="status">
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span>Ollama enabled — default models pulled.</span>
                </div>
              {/if}
              {#if !detectedProviders.some(p => p.available)}
                <div class="field-group">
                  <label for="local-provider">Provider</label>
                  <select id="local-provider" value={editingConnection.provider} onchange={(e) => handleProviderChange(e.currentTarget.value)}>
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="model-runner">Docker Model Runner</option>
                  </select>
                </div>
              {/if}
            {/if}
            <div class="field-group">
              <label for="llm-base-url-local">Base URL</label>
              <input id="llm-base-url-local" type="url" value={editingConnection.baseUrl} oninput={(e) => updateEditingField('baseUrl', e.currentTarget.value)} placeholder="Provider base URL" />
              {#if LOCAL_PROVIDER_HELP[editingConnection.provider]}
                <p class="field-hint">{LOCAL_PROVIDER_HELP[editingConnection.provider]}</p>
              {:else}
                <p class="field-hint">Auto-detected from your running provider.</p>
              {/if}
            </div>
            {#if connectError}<p class="field-error" role="alert">{connectError}</p>{/if}
            {#if editingConnection.tested && !ollamaEnabled}
              <div class="connection-success" role="status">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                <span>Connected — {editingConnection.modelList.length} model{editingConnection.modelList.length !== 1 ? 's' : ''} found.</span>
              </div>
            {/if}
            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => goToScreen('connection-type')}>Back</button>
              {#if !ollamaEnabled}
                <button class="btn btn-outline" onclick={() => void testConnection()} disabled={testingConnection}>
                  {#if testingConnection}<span class="spinner"></span> Testing...{:else}Test Connection{/if}
                </button>
              {/if}
              <button class="btn btn-primary" disabled={testingConnection} onclick={() => {
                const err = validateConnectionFields();
                if (err) { connectError = err; return; }
                finalizeConnection();
              }}>Next</button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Step 3: Models -->
      {#if screen === 'models'}
        <div class="step-content" data-testid="step-models">
          <h2>{SETUP_WIZARD_COPY.selectModelsTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.selectModelsDescription}</p>

          {#if connections.length > 1}
            <div class="field-group">
              <label for="llm-connection">{SETUP_WIZARD_COPY.llmConnectionLabel}</label>
              <select id="llm-connection" value={llmConnectionId} onchange={(e) => {
                llmConnectionId = e.currentTarget.value;
                const conn = getConnectionById(llmConnectionId);
                if (conn && conn.modelList.length === 0 && !conn.tested) void testConnection(conn);
              }}>
                {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
              </select>
            </div>
          {/if}

          <div class="field-group">
            <label for="system-model">System Model</label>
            <ModelSelector id="system-model" bind:value={llmModel} options={llmModelList} placeholder="gpt-4o-mini" />
            <p class="field-hint">Used for message routing, safety, and memory reasoning.</p>
          </div>

          {#if connections.length > 1}
            <div class="field-group">
              <label for="emb-connection">{SETUP_WIZARD_COPY.embeddingConnectionLabel}</label>
              <select id="emb-connection" value={embeddingConnectionId} onchange={(e) => {
                embeddingConnectionId = e.currentTarget.value;
                const conn = getConnectionById(embeddingConnectionId);
                if (conn && conn.modelList.length === 0 && !conn.tested) void testConnection(conn);
              }}>
                {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
              </select>
            </div>
          {/if}

          <div class="field-group">
            <label for="embedding-model">Embedding Model</label>
            <ModelSelector id="embedding-model" bind:value={embeddingModel} options={embModelList} placeholder="text-embedding-3-small" onChange={handleEmbeddingModelChange} />
            <p class="field-hint">Used for memory vector embeddings. Changing this later requires a collection reset.</p>
          </div>

          <div class="field-group">
            <label for="embedding-dims">Embedding Dimensions</label>
            <input id="embedding-dims" type="number" bind:value={embeddingDims} min="1" step="1" />
            <p class="field-hint">Auto-filled for known models. Edit if using a custom model.</p>
          </div>

          <div class="field-group">
            <label for="memory-user-id">Memory User ID</label>
            <input id="memory-user-id" type="text" bind:value={memoryUserId} placeholder="default_user" />
            <p class="field-hint">Derived from your name. Edit if running multiple instances.</p>
          </div>

          <button class="btn-link add-connection-link" type="button" onclick={() => startNewConnection()}>
            {connections.length === 1 ? SETUP_WIZARD_COPY.differentEmbeddingProvider : SETUP_WIZARD_COPY.addAnotherConnection}
          </button>

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => {
              editingConnectionIndex = connections.length - 1;
              const lastConn = connections[connections.length - 1];
              goToScreen(lastConn?.connectionType === 'local' ? 'local-provider' : 'cloud-provider');
            }}>Back</button>
            <button class="btn btn-primary" onclick={() => goToScreen('review')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 4: Review & Install -->
      {#if screen === 'review' || screen === 'install'}
        <div class="step-content" data-testid="step-review">
          <h2>Review & Install</h2>
          <div class="review-grid">
            <div class="review-item">
              <span class="review-label">Name</span>
              <span class="review-value">{ownerName || '(not set)'}</span>
            </div>
            {#if ownerEmail}
              <div class="review-item"><span class="review-label">Email</span><span class="review-value">{ownerEmail}</span></div>
            {/if}
            <div class="review-item"><span class="review-label">Admin Token</span><span class="review-value mono">Set</span></div>

            {#each connections as conn, i}
              <div class="review-item">
                <span class="review-label">Connection{connections.length > 1 ? ` ${i + 1}` : ''}</span>
                <span class="review-value">{conn.connectionType === 'local' ? 'Local' : 'Cloud'} — {conn.name || (PROVIDER_LABELS[conn.provider] ?? conn.provider)}</span>
              </div>
              {#if conn.apiKey}
                <div class="review-item">
                  <span class="review-label">{connections.length > 1 ? `API Key (${conn.name})` : 'API Key'}</span>
                  <span class="review-value mono">{maskedKey(conn.apiKey)}</span>
                </div>
              {/if}
              {#if conn.baseUrl}
                <div class="review-item">
                  <span class="review-label">{connections.length > 1 ? `Base URL (${conn.name})` : 'Base URL'}</span>
                  <span class="review-value mono">{conn.baseUrl}</span>
                </div>
              {/if}
            {/each}

            {#if ollamaEnabled}
              <div class="review-item"><span class="review-label">Ollama</span><span class="review-value">Enabled (in-stack)</span></div>
            {/if}

            <div class="review-item">
              <span class="review-label">System Model</span>
              <span class="review-value mono">{llmModel}{connections.length > 1 && llmConnection ? ` (${llmConnection.name})` : ''}</span>
            </div>
            <div class="review-item">
              <span class="review-label">Embedding Model</span>
              <span class="review-value mono">{embeddingModel}{connections.length > 1 && embConnection ? ` (${embConnection.name})` : ''}</span>
            </div>
            <div class="review-item"><span class="review-label">Embedding Dimensions</span><span class="review-value mono">{embeddingDims}</span></div>
            <div class="review-item"><span class="review-label">Memory User ID</span><span class="review-value">{memoryUserId}</span></div>
          </div>

          {#if installError}<p class="install-error" role="alert">{installError}</p>{/if}

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => goToScreen('models')} disabled={installing}>Back</button>
            <button class="btn btn-primary" onclick={handleInstall} disabled={installing}>
              {#if installing}<span class="spinner"></span> Installing...{:else}Install Stack{/if}
            </button>
          </div>
        </div>
      {/if}

      <!-- Step 5: Deploying -->
      {#if screen === 'deploying'}
        <div class="step-content" data-testid="step-deploying">
          <div class="deploy-header">
            <h2>Setting Up Your Stack</h2>
            <p class="step-description">
              {#if deployPhase === 'pulling'}Pulling container images...
              {:else if deployPhase === 'starting'}Starting services...
              {:else if deployPhase === 'ready'}All services are up and running.
              {:else if deployPhase === 'error'}Deployment encountered an error.
              {:else}Preparing deployment...{/if}
            </p>
          </div>
          <div class="deploy-services">
            {#each deployServices as svc}
              <div class="deploy-service-row">
                <div class="deploy-service-indicator">
                  {#if svc.containerRunning || svc.imageReady}
                    <span class="deploy-check" aria-label={svc.containerRunning ? 'Running' : 'Image ready'}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </span>
                  {:else}
                    <span class="deploy-spinner" aria-label="Downloading"><span class="spinner"></span></span>
                  {/if}
                </div>
                <div class="deploy-service-info">
                  <span class="deploy-service-name">{svc.label}</span>
                  <span class="deploy-service-status">
                    {#if svc.containerRunning}Running{:else if svc.imageReady}Image ready{:else}Pulling image...{/if}
                  </span>
                </div>
                <div class="deploy-service-bar">
                  <div class="deploy-bar-fill" class:indeterminate={!svc.imageReady} class:complete={svc.imageReady}></div>
                </div>
              </div>
            {/each}
          </div>
          {#if deployPhase === 'error'}
            <p class="install-error" role="alert">{deployError}</p>
            <div class="step-actions">
              <button class="btn btn-secondary" onclick={() => { goToScreen('review'); installing = false; }}>Back to Review</button>
            </div>
          {/if}
          {#if deployPhase === 'ready'}
            <div class="deploy-done"><a href="/" class="btn btn-primary console-link">Go to Console</a></div>
          {/if}
        </div>
      {/if}
    </WizardShell>
  </main>
{/if}

<style>
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
  :global(.wizard-header) { margin-bottom: var(--space-6); }
  :global(.wizard-header h1) { font-size: var(--text-2xl); font-weight: var(--font-bold); color: var(--color-text); }
  :global(.wizard-subtitle) { margin-top: var(--space-1); font-size: var(--text-sm); color: var(--color-text-secondary); }
  .loading-state { display: flex; justify-content: center; padding: var(--space-8); }
  .step-indicators { display: flex; align-items: center; justify-content: center; gap: 0; margin-bottom: var(--space-6); }
  .step-dot { width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--color-border); background: var(--color-bg); color: var(--color-text-secondary); font-size: var(--text-sm); font-weight: var(--font-semibold); display: flex; align-items: center; justify-content: center; cursor: default; transition: all var(--transition-fast); }
  .step-dot.active { border-color: var(--color-primary); background: var(--color-primary); color: #000; }
  .step-dot.completed { border-color: var(--color-success); background: var(--color-success); color: #fff; cursor: pointer; }
  .step-line { width: 36px; height: 2px; background: var(--color-border); transition: background var(--transition-fast); }
  .step-line.active { background: var(--color-success); }
  .step-content h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-2); }
  .step-description { font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-4); }
  .field-group { margin-bottom: var(--space-4); }
  .field-group label { display: block; font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text-secondary); margin-bottom: var(--space-1); }
  .field-group input, .field-group select { width: 100%; height: 40px; border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0 12px; background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); }
  .field-group input:focus, .field-group select:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }
  .field-hint { margin-top: var(--space-1); font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .field-error { margin: 0 0 var(--space-2); color: var(--color-danger); font-size: var(--text-sm); }
  :global(.connection-type-card) { display: flex; align-items: flex-start; gap: var(--space-4); width: 100%; padding: var(--space-4) var(--space-5); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; text-align: left; margin-bottom: var(--space-3); transition: all var(--transition-fast); }
  :global(.connection-type-card:hover) { border-color: var(--color-primary); background: var(--color-bg-secondary); }
  :global(.connection-type-icon) { flex-shrink: 0; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: var(--color-bg-secondary); border-radius: var(--radius-md); color: var(--color-primary); }
  :global(.connection-type-text) { display: flex; flex-direction: column; gap: var(--space-1); }
  :global(.connection-type-label) { font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); }
  :global(.connection-type-desc) { font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.4; }
  .provider-quick-picks { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
  .provider-chip { padding: 6px 14px; font-size: var(--text-xs); font-weight: var(--font-medium); border: 1px solid var(--color-border); border-radius: var(--radius-full); background: var(--color-bg); color: var(--color-text); cursor: pointer; transition: all var(--transition-fast); }
  .provider-chip:hover { border-color: var(--color-primary); color: var(--color-primary); }
  .provider-chip.selected { border-color: var(--color-primary); background: var(--color-primary); color: #000; }
  .enable-ollama-section { padding: var(--space-4); background: var(--color-bg-secondary); border: 1px dashed var(--color-border); border-radius: var(--radius-md); margin-bottom: var(--space-4); }
  .enable-ollama-info { margin-bottom: var(--space-3); }
  .enable-ollama-title { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); margin: 0 0 var(--space-1); }
  .enable-ollama-desc { font-size: var(--text-xs); color: var(--color-text-secondary); margin: 0; line-height: 1.4; }
  .enable-ollama-btn { width: 100%; }
  .ollama-progress { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--color-text-secondary); padding: var(--space-2) 0; }
  .connection-success { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--color-success-bg, rgba(64, 192, 87, 0.1)); border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.25)); border-radius: var(--radius-md); font-size: var(--text-sm); color: var(--color-text); margin-bottom: var(--space-2); }
  .connections-summary { margin-bottom: var(--space-4); padding: var(--space-3); background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .connections-summary-title { font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 var(--space-2); }
  .connection-card { display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); margin-bottom: var(--space-1); }
  .connection-card-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .connection-card-detail { font-size: var(--text-xs); color: var(--color-text-tertiary); font-family: var(--font-mono); }
  .btn-link { background: none; border: none; color: var(--color-primary); font-size: var(--text-sm); cursor: pointer; padding: var(--space-2) 0; text-decoration: underline; text-underline-offset: 2px; }
  .btn-link:hover { color: var(--color-primary-hover); }
  .add-connection-link { display: block; margin-bottom: var(--space-2); }
  .step-actions { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: var(--space-6); }
  .review-grid { display: grid; gap: var(--space-3); background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-4); }
  .review-item { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
  .review-label { font-size: var(--text-sm); color: var(--color-text-secondary); flex-shrink: 0; }
  .review-value { font-size: var(--text-sm); color: var(--color-text); text-align: right; word-break: break-all; }
  .review-value.mono { font-family: var(--font-mono); }
  .install-error { margin-top: var(--space-3); color: var(--color-danger); font-size: var(--text-sm); }
  .done-state { text-align: center; padding: var(--space-4) 0; }
  .done-icon { display: inline-block; margin-bottom: var(--space-4); }
  .done-state h2 { font-size: var(--text-2xl); font-weight: var(--font-bold); color: var(--color-text); margin-bottom: var(--space-2); }
  .done-subtitle { font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-5); }
  .service-list { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: center; margin-bottom: var(--space-6); }
  .service-list li { font-size: var(--text-xs); font-family: var(--font-mono); background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success-border); padding: 2px 10px; border-radius: var(--radius-full); }
  .console-link { display: inline-flex; text-decoration: none; }
  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 8px 20px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); line-height: 1.4; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition-fast); white-space: nowrap; justify-content: center; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary { background: var(--color-primary); color: #000; border-color: var(--color-primary); }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }
  .btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border); }
  .btn-secondary:hover:not(:disabled) { background: var(--color-bg-secondary); border-color: var(--color-border-hover); }
  .btn-outline { background: transparent; color: var(--color-primary); border-color: var(--color-primary); }
  .btn-outline:hover:not(:disabled) { background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08)); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  @media (max-width: 480px) { .wizard-card { padding: var(--space-5); } .review-item { flex-direction: column; align-items: flex-start; } .review-value { text-align: left; } }
  .provider-option { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-3) var(--space-4); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; font-size: var(--text-sm); color: var(--color-text); margin-bottom: var(--space-2); transition: all var(--transition-fast); }
  .provider-option:hover { border-color: var(--color-primary); background: var(--color-bg-secondary); }
  .provider-option.selected { border-color: var(--color-primary); background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08)); }
  .provider-option-status { display: flex; align-items: center; }
  .status-dot--ok { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); }
  .provider-option-label { flex: 1; font-weight: var(--font-medium); }
  .provider-option-hint { font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .deploy-header { text-align: center; margin-bottom: var(--space-6); }
  .deploy-services { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-6); }
  .deploy-service-row { display: grid; grid-template-columns: 28px 1fr 120px; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .deploy-service-indicator { display: flex; align-items: center; justify-content: center; }
  .deploy-check { display: flex; align-items: center; justify-content: center; }
  .deploy-spinner { display: flex; align-items: center; justify-content: center; }
  .deploy-service-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .deploy-service-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .deploy-service-status { font-size: var(--text-xs); color: var(--color-text-tertiary); }
  .deploy-service-bar { height: 6px; background: var(--color-bg-secondary); border-radius: 3px; overflow: hidden; }
  .deploy-bar-fill { height: 100%; border-radius: 3px; transition: all 0.4s ease; }
  .deploy-bar-fill.indeterminate { width: 40%; background: var(--color-primary); animation: indeterminate-bar 1.5s ease-in-out infinite; }
  .deploy-bar-fill.complete { width: 100%; background: var(--color-success); animation: none; }
  @keyframes indeterminate-bar { 0% { transform: translateX(-100%); } 50% { transform: translateX(150%); } 100% { transform: translateX(-100%); } }
  @media (prefers-reduced-motion: reduce) { .deploy-bar-fill.indeterminate { animation: none; width: 100%; opacity: 0.5; } }
  .deploy-done { text-align: center; margin-top: var(--space-4); }
  @media (max-width: 480px) { .deploy-service-row { grid-template-columns: 28px 1fr; } .deploy-service-bar { display: none; } }
</style>
