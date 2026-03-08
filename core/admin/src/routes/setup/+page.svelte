<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { LLM_PROVIDERS, PROVIDER_DEFAULT_URLS, PROVIDER_LABELS, LOCAL_PROVIDER_HELP, EMBEDDING_DIMS, OLLAMA_DEFAULT_MODELS } from '$lib/provider-constants.js';
  import { SETUP_WIZARD_COPY } from '$lib/setup-wizard/copy.js';
  import { mapModelDiscoveryError } from '$lib/model-discovery.js';
  import WizardShell from '$lib/components/setup-wizard/WizardShell.svelte';
  import ConnectionPicker from '$lib/components/setup-wizard/ConnectionPicker.svelte';
  import ConnectionsHubList from '$lib/components/setup-wizard/ConnectionsHubList.svelte';
  import RequiredModelsScreen from '$lib/components/setup-wizard/RequiredModelsScreen.svelte';
  import OptionalAddonsScreen from '$lib/components/setup-wizard/OptionalAddonsScreen.svelte';
  import {
    createInitialDraft,
    createConnectionDraft,
    isAfterScreen,
    isAtOrAfterScreen,
    maxScreen,
    parseWizardScreen,
    type WizardScreen,
    type WizardConnectionDraft,
    type WizardAssignments,
  } from '$lib/setup-wizard/state.js';
  import type { LocalProviderDetection } from '$lib/api.js';
  import type { PageData } from './$types';

  // ── Connection test error mapping ────────────────────────────────────────
  function mapConnectionTestError(result: { error?: string; errorCode?: string }): string {
    switch (result.errorCode) {
      case 'unauthorized':
        return 'Unauthorized. This endpoint may require a valid API key.';
      case 'not_found':
        return 'Endpoint not found. Verify the Base URL includes /v1.';
      case 'timeout':
        return "Couldn't reach the server. Confirm it's running and accessible.";
      case 'missing_base_url':
        return 'Base URL is required for this provider.';
      default:
        return result.error ?? 'Connection failed. Check the Base URL and API key.';
    }
  }

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  // svelte-ignore state_referenced_locally
  const { setupToken = '', detectedUserId = 'default_user' } = data;

  // ── Wizard state ────────────────────────────────────────────────────────
  const initialDraft = createInitialDraft(detectedUserId);
  let screen: WizardScreen = $state(initialDraft.screen);
  let furthestScreen: WizardScreen = $state(initialDraft.screen);
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
  let assignments = $state(initialDraft.assignments);

  // Convenience accessors (derived, no extra state)
  let llmConnectionId = $derived(assignments.llm.connectionId);
  let embeddingConnectionId = $derived(assignments.embeddings.connectionId);
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
  let exportError = $state('');
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

  // ── Auto-test debounce ────────────────────────────────────────────────
  let autoTestTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleAutoTest(): void {
    if (autoTestTimer) clearTimeout(autoTestTimer);
    autoTestTimer = setTimeout(() => {
      if (editingConnection && !editingConnection.tested && !testingConnection) {
        const err = validateConnectionFields();
        if (!err) void testConnection();
      }
    }, 800);
  }

  // ── Derived helpers ─────────────────────────────────────────────────────

  function getConnectionById(id: string): WizardConnectionDraft | undefined {
    return connections.find(c => c.id === id);
  }

  let llmConnection = $derived(getConnectionById(llmConnectionId));
  let embConnection = $derived(getConnectionById(embeddingConnectionId));

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
    furthestScreen = maxScreen(furthestScreen, next);
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
      const needsState: WizardScreen[] = [
        'add-connection-details',
        'models',
        'optional-addons',
        'review',
        'install',
      ];
      if (needsState.includes(parsed) && connections.length === 0) {
        screen = 'welcome';
      } else {
        screen = parsed;
        furthestScreen = maxScreen(furthestScreen, parsed);
      }
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
    const updated: WizardConnectionDraft = {
      ...editingConnection,
      connectionType: type,
      tested: false,
      modelList: [],
      provider: type === 'cloud' ? 'openai' : 'ollama',
      baseUrl: type === 'cloud'
        ? (PROVIDER_DEFAULT_URLS['openai'] ?? '')
        : (PROVIDER_DEFAULT_URLS['ollama'] ?? ''),
      apiKey: '',
    };
    connections = connections.map((c, i) => i === idx ? updated : c);
    if (type === 'local') void detectLocalProviders();
    goToScreen('add-connection-details');
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
    if (detected?.available) {
      scheduleAutoTest();
    }
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
      assignments = {
        ...assignments,
        llm: { ...assignments.llm, connectionId: editingConnection.id },
        embeddings: {
          ...assignments.embeddings,
          connectionId: editingConnection.id,
          sameAsLlm: true,
        },
      };
    }

    addingNewConnection = false;
    editingConnectionIndex = -1;
    goToScreen('connections-hub');
  }

  function editConnection(index: number): void {
    editingConnectionIndex = index;
    addingNewConnection = true;
    connectError = '';
    goToScreen('add-connection-details');
  }

  function duplicateConnection(index: number): void {
    const source = connections[index];
    if (!source) return;
    const newId = crypto.randomUUID().slice(0, 8);
    const copy: WizardConnectionDraft = {
      ...source,
      id: newId,
      name: source.name ? `${source.name} (copy)` : '',
      tested: false,
      modelList: [],
    };
    connections = [...connections, copy];
    editingConnectionIndex = connections.length - 1;
    addingNewConnection = true;
    connectError = '';
    goToScreen('add-connection-details');
  }

  function removeConnection(index: number): void {
    const removed = connections[index];
    connections = connections.filter((_, i) => i !== index);
    // If removed connection was assigned to LLM or embeddings, clear those
    if (removed && assignments.llm.connectionId === removed.id) {
      assignments = {
        ...assignments,
        llm: { ...assignments.llm, connectionId: '', model: '' },
      };
    }
    if (removed && assignments.embeddings.connectionId === removed.id) {
      assignments = {
        ...assignments,
        embeddings: { ...assignments.embeddings, connectionId: '', model: '' },
      };
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
      const defaultChat = (result.defaultChatModel as string) ?? OLLAMA_DEFAULT_MODELS.chat;
      const defaultEmbed = (result.defaultEmbeddingModel as string) ?? OLLAMA_DEFAULT_MODELS.embedding;
      const dimsKey = `ollama/${defaultEmbed}`;
      assignments = {
        ...assignments,
        llm: { ...assignments.llm, model: defaultChat },
        embeddings: {
          ...assignments.embeddings,
          model: defaultEmbed,
          embeddingDims: EMBEDDING_DIMS[dimsKey] ?? 768,
        },
      };
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
        // Set assignments and go to connections hub
        if (editingConnection) {
          assignments = {
            ...assignments,
            llm: { ...assignments.llm, connectionId: editingConnection.id },
            embeddings: { ...assignments.embeddings, connectionId: editingConnection.id },
          };
        }
        finalizeConnection();
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
      const res = await fetch('/admin/connections/test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders(setupSessionToken)
        },
        body: JSON.stringify({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          kind: target.connectionType === 'local' ? 'local' : 'cloud',
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        connectError = data.message ?? `Connection test failed (HTTP ${res.status})`;
        return;
      }
      const result = await res.json();
      if (!result.ok) {
        connectError = mapConnectionTestError(result);
        return;
      }
      const apiModels: string[] = result.models ?? [];

      // Update the target connection with results
      const idx = connections.findIndex(c => c.id === target.id);
      if (idx >= 0) {
        const merged = new Set<string>(apiModels);
        if (assignments.llm.model && target.id === assignments.llm.connectionId) merged.add(assignments.llm.model);
        if (assignments.embeddings.model && target.id === assignments.embeddings.connectionId) merged.add(assignments.embeddings.model);
        const sorted = [...merged].sort();
        connections = connections.map((c, i) =>
          i === idx ? { ...c, tested: true, modelList: sorted } : c
        );

        // Pre-select models if not already set
        if (sorted.length > 0) {
          if (!assignments.llm.model && target.id === assignments.llm.connectionId) {
            assignments = { ...assignments, llm: { ...assignments.llm, model: sorted[0] } };
          }
          if (!assignments.embeddings.model && target.id === assignments.embeddings.connectionId) {
            const embedCandidate = sorted.find(m => m.includes('embed') || m.includes('ada'));
            assignments = {
              ...assignments,
              embeddings: { ...assignments.embeddings, model: embedCandidate ?? sorted[0] },
            };
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

  async function handleExport(type: 'opencode' | 'mem0'): Promise<void> {
    exportError = '';
    try {
      const res = await fetch(`/admin/connections/export/${type}`, {
        headers: buildHeaders(setupSessionToken)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string };
        exportError = data.message ?? `Export failed (HTTP ${res.status})`;
        return;
      }
      const blob = await res.blob();
      const filename = type === 'opencode' ? 'opencode.json' : 'mem0-config.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      exportError = 'Network error — unable to download config.';
    }
  }

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
              connectionId: assignments.llm.connectionId,
              model: assignments.llm.model,
              ...(assignments.llm.smallModel ? { smallModel: assignments.llm.smallModel } : {}),
            },
            embeddings: {
              connectionId: assignments.embeddings.connectionId,
              model: assignments.embeddings.model,
              embeddingDims: assignments.embeddings.embeddingDims,
            },
            ...(assignments.reranking.enabled ? {
              reranking: {
                enabled: true,
                connectionId: assignments.reranking.connectionId,
                model: assignments.reranking.model,
                mode: assignments.reranking.mode,
                topN: assignments.reranking.topN,
              },
            } : {}),
            ...(assignments.tts.enabled ? {
              tts: {
                enabled: true,
                connectionId: assignments.tts.connectionId,
                model: assignments.tts.model,
                voice: assignments.tts.voice,
                format: assignments.tts.format,
              },
            } : {}),
            ...(assignments.stt.enabled ? {
              stt: {
                enabled: true,
                connectionId: assignments.stt.connectionId,
                model: assignments.stt.model,
                language: assignments.stt.language,
              },
            } : {}),
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
      setupSessionToken = adminToken;
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
    if (autoTestTimer) clearTimeout(autoTestTimer);
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
          <!-- Dot 1: Welcome -->
          <button class="step-dot"
            class:active={screen === 'welcome'}
            class:completed={isAfterScreen(furthestScreen, 'welcome')}
            onclick={() => goToScreen('welcome')}
            aria-label="Step 1: Welcome"
            aria-current={screen === 'welcome' ? 'step' : undefined}>
            {#if isAfterScreen(furthestScreen, 'welcome')}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{:else}1{/if}
          </button>
          <span class="step-line" class:active={isAfterScreen(furthestScreen, 'welcome')}></span>

          <!-- Dot 2: Connections Hub -->
          <button class="step-dot"
            class:active={screen === 'connections-hub'}
            class:completed={isAfterScreen(furthestScreen, 'connections-hub')}
            disabled={!isAtOrAfterScreen(furthestScreen, 'connections-hub')}
            onclick={() => goToScreen('connections-hub')}
            aria-label="Step 2: Connections"
            aria-current={screen === 'connections-hub' ? 'step' : undefined}>
            {#if isAfterScreen(furthestScreen, 'connections-hub')}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{:else}2{/if}
          </button>
          <span class="step-line" class:active={isAfterScreen(furthestScreen, 'connections-hub')}></span>

          <!-- Dot 3: Add Connection (Type + Details — grouped) -->
          <button class="step-dot"
            class:active={screen === 'connection-type' || screen === 'add-connection-details'}
            class:completed={isAfterScreen(furthestScreen, 'add-connection-details')}
            disabled={!isAtOrAfterScreen(furthestScreen, 'connection-type')}
            onclick={() => {
              if (connections.length > 0) {
                editingConnectionIndex = 0;
                goToScreen('add-connection-details');
              } else {
                goToScreen('connection-type');
              }
            }}
            aria-label="Step 3: Add Connection"
            aria-current={screen === 'connection-type' || screen === 'add-connection-details' ? 'step' : undefined}>
            {#if isAfterScreen(furthestScreen, 'add-connection-details')}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{:else}3{/if}
          </button>
          <span class="step-line" class:active={isAfterScreen(furthestScreen, 'add-connection-details')}></span>

          <!-- Dot 4: Required Models -->
          <button class="step-dot"
            class:active={screen === 'models'}
            class:completed={isAfterScreen(furthestScreen, 'models')}
            disabled={!isAtOrAfterScreen(furthestScreen, 'models')}
            onclick={() => goToScreen('models')}
            aria-label="Step 4: Required Models"
            aria-current={screen === 'models' ? 'step' : undefined}>
            {#if isAfterScreen(furthestScreen, 'models')}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{:else}4{/if}
          </button>
          <span class="step-line" class:active={isAfterScreen(furthestScreen, 'models')}></span>

          <!-- Dot 5: Optional Add-ons -->
          <button class="step-dot"
            class:active={screen === 'optional-addons'}
            class:completed={isAfterScreen(furthestScreen, 'optional-addons')}
            disabled={!isAtOrAfterScreen(furthestScreen, 'optional-addons')}
            onclick={() => goToScreen('optional-addons')}
            aria-label="Step 5: Optional Add-ons"
            aria-current={screen === 'optional-addons' ? 'step' : undefined}>
            {#if isAfterScreen(furthestScreen, 'optional-addons')}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>{:else}5{/if}
          </button>
          <span class="step-line" class:active={isAfterScreen(furthestScreen, 'optional-addons')}></span>

          <!-- Dot 6: Review & Install -->
          <button class="step-dot"
            class:active={screen === 'review' || screen === 'install'}
            disabled={!isAtOrAfterScreen(furthestScreen, 'review')}
            onclick={() => goToScreen('review')}
            aria-label="Step 6: Review & Install"
            aria-current={screen === 'review' || screen === 'install' ? 'step' : undefined}>
            6
          </button>
        </nav>
      {/if}

      <!-- Screen 1: Welcome -->
      {#if screen === 'welcome'}
        <div class="step-content" data-testid="step-welcome">
          <h2>{SETUP_WIZARD_COPY.welcomeTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.welcomeBody}</p>
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
              if (adminToken.trim().length < 8) { tokenError = 'Admin token must be at least 8 characters.'; return; }
              tokenError = '';
              if (!memoryUserId || memoryUserId === detectedUserId || memoryUserId === 'default_user') {
                memoryUserId = ownerName.trim().toLowerCase().replace(/\s+/g, '_');
              }
              goToScreen('connections-hub');
            }}>{SETUP_WIZARD_COPY.welcomeStart}</button>
          </div>
        </div>
      {/if}

      <!-- Screen 2: Connections Hub -->
      {#if screen === 'connections-hub'}
        <div class="step-content" data-testid="step-connections-hub">
          <h2>{SETUP_WIZARD_COPY.connectionsHubTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.connectionsHubBody}</p>

          <ConnectionsHubList
            {connections}
            onEdit={(i) => editConnection(i)}
            onDuplicate={(i) => duplicateConnection(i)}
            onRemove={(i) => removeConnection(i)}
            onAdd={() => startNewConnection()}
            emptyHeadline={SETUP_WIZARD_COPY.connectionsHubEmptyHeadline}
            emptyBody={SETUP_WIZARD_COPY.connectionsHubEmptyBody}
            emptyCta={SETUP_WIZARD_COPY.connectionsHubEmptyCta}
          />

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => goToScreen('welcome')}>Back</button>
            <button class="btn btn-outline" onclick={() => startNewConnection()}>
              {SETUP_WIZARD_COPY.connectionsHubAddBtn}
            </button>
            <button class="btn btn-primary"
              disabled={connections.length === 0}
              onclick={() => { connectError = ''; goToScreen('models'); }}>
              {SETUP_WIZARD_COPY.connectionsHubContinueBtn}
            </button>
          </div>
        </div>
      {/if}

      <!-- Screen 3: Connection Type -->
      {#if screen === 'connection-type'}
        <div class="step-content" data-testid="step-connection-type">
          <h2>{SETUP_WIZARD_COPY.addConnectionTypeTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.connectionTypePrompt}</p>
          <ConnectionPicker
            onSelectCloud={() => selectConnectionType('cloud')}
            onSelectLocal={() => selectConnectionType('local')}
          />
          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => {
              // If we were adding a new connection, remove the blank draft
              if (addingNewConnection && connections.length > 0) {
                connections = connections.slice(0, -1);
                addingNewConnection = false;
              }
              goToScreen('connections-hub');
            }}>Back</button>
          </div>
        </div>
      {/if}

      <!-- Screen 4: Add Connection Details -->
      {#if screen === 'add-connection-details' && editingConnection}
        <div class="step-content" data-testid="step-add-connection-details">
          <h2>{SETUP_WIZARD_COPY.addConnectionDetailsTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.addConnectionDetailsBody}</p>

          <!-- Connection name -->
          <div class="field-group">
            <label for="conn-name">{SETUP_WIZARD_COPY.addConnectionNameLabel}</label>
            <input
              id="conn-name"
              type="text"
              value={editingConnection.name}
              oninput={(e) => updateEditingField('name', e.currentTarget.value)}
              placeholder={SETUP_WIZARD_COPY.addConnectionNamePlaceholder}
            />
          </div>

          <!-- Cloud-specific: provider chip picker + API key -->
          {#if editingConnection.connectionType === 'cloud'}
            <div class="provider-quick-picks">
              {#each CLOUD_PROVIDERS as p}
                <button class="provider-chip" class:selected={editingConnection.provider === p}
                  type="button" onclick={() => handleProviderChange(p)}>
                  {PROVIDER_LABELS[p] ?? p}
                </button>
              {/each}
            </div>

            <div class="field-group">
              <label for="conn-api-key">{SETUP_WIZARD_COPY.addConnectionApiKeyLabel}</label>
              <input id="conn-api-key" type="password"
                value={editingConnection.apiKey}
                oninput={(e) => { updateEditingField('apiKey', e.currentTarget.value); scheduleAutoTest(); }}
                placeholder={SETUP_WIZARD_COPY.addConnectionApiKeyPlaceholder}
              />
              <p class="field-hint">{SETUP_WIZARD_COPY.addConnectionApiKeyHint}</p>
            </div>
          {/if}

          <!-- Local-specific: detection + Ollama enable -->
          {#if editingConnection.connectionType === 'local'}
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
          {/if}

          <!-- Shared: Base URL -->
          <div class="field-group">
            <label for="conn-base-url">{SETUP_WIZARD_COPY.addConnectionBaseUrlLabel}</label>
            <input id="conn-base-url" type="url"
              value={editingConnection.baseUrl}
              oninput={(e) => updateEditingField('baseUrl', e.currentTarget.value)}
              placeholder={editingConnection.connectionType === 'cloud'
                ? 'https://api.example.com/v1'
                : 'http://localhost:1234/v1'}
            />
            <p class="field-hint">{SETUP_WIZARD_COPY.addConnectionBaseUrlHint}</p>
            {#if editingConnection.baseUrl && !editingConnection.baseUrl.endsWith('/v1') && !Object.values(PROVIDER_DEFAULT_URLS).includes(editingConnection.baseUrl)}
              <p class="field-warn">{SETUP_WIZARD_COPY.addConnectionBaseUrlWarn}</p>
            {/if}
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
            <button class="btn btn-secondary" onclick={() => goToScreen('connection-type')}>{SETUP_WIZARD_COPY.addConnectionCancelBtn}</button>
            {#if !ollamaEnabled || editingConnection.connectionType === 'cloud'}
              <button class="btn btn-outline" onclick={() => void testConnection()} disabled={testingConnection}>
                {#if testingConnection}<span class="spinner"></span> Testing...{:else}Test Connection{/if}
              </button>
            {/if}
            <button class="btn btn-primary" disabled={testingConnection} onclick={() => {
              if (!editingConnection!.name.trim()) { connectError = 'Connection name is required.'; return; }
              const err = validateConnectionFields();
              if (err) { connectError = err; return; }
              finalizeConnection();
            }}>{SETUP_WIZARD_COPY.addConnectionSaveBtn}</button>
          </div>
        </div>
      {/if}

      <!-- Screen 5: Required Models -->
      {#if screen === 'models'}
        <RequiredModelsScreen
          {connections}
          {assignments}
          {connectError}
          onAssignmentsChange={(next) => { assignments = next; }}
          onAddConnection={() => startNewConnection()}
          onBack={() => goToScreen('connections-hub')}
          onNext={() => {
            if (!assignments.llm.model.trim()) { connectError = 'Chat model is required.'; return; }
            if (!assignments.embeddings.model.trim()) { connectError = 'Embedding model is required.'; return; }
            connectError = '';
            goToScreen('optional-addons');
          }}
        />
      {/if}

      <!-- Screen 6: Optional Add-ons -->
      {#if screen === 'optional-addons'}
        <OptionalAddonsScreen
          {connections}
          {assignments}
          onAssignmentsChange={(next) => { assignments = next; }}
          onBack={() => goToScreen('models')}
          onNext={() => goToScreen('review')}
          onSkip={() => goToScreen('review')}
        />
      {/if}

      <!-- Screen 7: Review & Install -->
      {#if screen === 'review' || screen === 'install'}
        <div class="step-content" data-testid="step-review">
          <h2>{SETUP_WIZARD_COPY.reviewTitle}</h2>
          <p class="step-description">{SETUP_WIZARD_COPY.reviewBody}</p>
          <div class="review-grid">
            <div class="review-section-header">
              <span>Account</span>
              <button class="review-edit-btn" onclick={() => goToScreen('welcome')} type="button">Edit</button>
            </div>
            <div class="review-item">
              <span class="review-label">Name</span>
              <span class="review-value">{ownerName || '(not set)'}</span>
            </div>
            {#if ownerEmail}
              <div class="review-item"><span class="review-label">Email</span><span class="review-value">{ownerEmail}</span></div>
            {/if}
            <div class="review-item"><span class="review-label">Admin Token</span><span class="review-value mono">Set</span></div>

            <div class="review-section-header">
              <span>{SETUP_WIZARD_COPY.reviewSectionConnections}</span>
              <button class="review-edit-btn" onclick={() => goToScreen('connections-hub')} type="button">Edit</button>
            </div>
            {#each connections as conn, i}
              <div class="review-item">
                <span class="review-label">Provider{connections.length > 1 ? ` ${i + 1}` : ''}</span>
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

            <div class="review-section-header">
              <span>{SETUP_WIZARD_COPY.reviewSectionModels}</span>
              <button class="review-edit-btn" onclick={() => goToScreen('models')} type="button">Edit</button>
            </div>
            <div class="review-item">
              <span class="review-label">Chat Model</span>
              <span class="review-value mono">{assignments.llm.model || '—'}{connections.length > 1 && llmConnection ? ` (${llmConnection.name})` : ''}</span>
            </div>
            {#if assignments.llm.smallModel}
              <div class="review-item">
                <span class="review-label">Small Model</span>
                <span class="review-value mono">{assignments.llm.smallModel}</span>
              </div>
            {/if}
            <div class="review-item">
              <span class="review-label">Embedding Model</span>
              <span class="review-value mono">{assignments.embeddings.model || '—'}{connections.length > 1 && embConnection ? ` (${embConnection.name})` : ''}</span>
            </div>
            <div class="review-item"><span class="review-label">Embedding Dimensions</span><span class="review-value mono">{assignments.embeddings.embeddingDims}</span></div>
            <div class="review-item"><span class="review-label">Memory User ID</span><span class="review-value">{memoryUserId}</span></div>

            <div class="review-section-header">
              <span>{SETUP_WIZARD_COPY.reviewSectionAddons}</span>
              <button class="review-edit-btn" onclick={() => goToScreen('optional-addons')} type="button">Edit</button>
            </div>
            {#if assignments.reranking.enabled || assignments.tts.enabled || assignments.stt.enabled}
              {#if assignments.reranking.enabled}
                <div class="review-item"><span class="review-label">Reranking</span><span class="review-value">{assignments.reranking.mode === 'llm' ? 'LLM reranker' : 'Dedicated reranker'}{assignments.reranking.model ? ` — ${assignments.reranking.model}` : ''}</span></div>
              {/if}
              {#if assignments.tts.enabled}
                <div class="review-item"><span class="review-label">Text-to-Speech</span><span class="review-value">{assignments.tts.model || 'Enabled'}{assignments.tts.voice ? ` / ${assignments.tts.voice}` : ''}</span></div>
              {/if}
              {#if assignments.stt.enabled}
                <div class="review-item"><span class="review-label">Speech-to-Text</span><span class="review-value">{assignments.stt.model || 'Enabled'}{assignments.stt.language ? ` / ${assignments.stt.language}` : ''}</span></div>
              {/if}
            {:else}
              <div class="review-item"><span class="review-label review-label--muted">None configured</span><span class="review-value"></span></div>
            {/if}
          </div>

          <div class="review-grid">
            <div class="review-section-header">
              <span>Config Exports</span>
            </div>
            <div class="review-item">
              <span class="review-label">OpenCode config</span>
              <span class="review-value">
                <button class="review-edit-btn" type="button" onclick={() => void handleExport('opencode')}>
                  Download opencode.json
                </button>
              </span>
            </div>
            <div class="review-item">
              <span class="review-label">Mem0 config</span>
              <span class="review-value">
                <button class="review-edit-btn" type="button" onclick={() => void handleExport('mem0')}>
                  Download mem0-config.json
                </button>
              </span>
            </div>
            {#if exportError}
              <div class="review-item">
                <span class="review-label" style="color: var(--color-error)">Export error</span>
                <span class="review-value" style="color: var(--color-error)">{exportError}</span>
              </div>
            {/if}
          </div>

          {#if installError}<p class="install-error" role="alert">{installError}</p>{/if}

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => goToScreen('optional-addons')} disabled={installing}>Back</button>
            <button class="btn btn-primary" onclick={handleInstall} disabled={installing}>
              {#if installing}<span class="spinner"></span> Installing...{:else}{SETUP_WIZARD_COPY.reviewSaveBtn}{/if}
            </button>
          </div>
        </div>
      {/if}

      <!-- Deploying screen (unchanged) -->
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
              <button class="btn btn-secondary" onclick={() => { deployPhase = null; deployError = ''; deployServices = []; deployMessage = ''; installing = false; goToScreen('review'); }}>Back to Review</button>
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
    place-items: center;
    padding: var(--space-6);
    background:
      radial-gradient(ellipse 80% 60% at 15% 10%, rgba(255, 157, 0, 0.06) 0%, transparent 60%),
      radial-gradient(ellipse 60% 50% at 85% 90%, rgba(99, 102, 241, 0.05) 0%, transparent 55%),
      #f8f9fb;
    position: relative;
    overflow: hidden;
  }
  .setup-page::before {
    content: '';
    position: absolute;
    bottom: -40px;
    left: -40px;
    width: 320px;
    height: 320px;
    background-image: url('/wizard.png');
    background-size: contain;
    background-repeat: no-repeat;
    opacity: 0.18;
    pointer-events: none;
    z-index: 0;
  }
  .wizard-card {
    width: 100%;
    max-width: 520px;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 20px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 4px 6px -1px rgba(0, 0, 0, 0.06), 0 16px 40px -8px rgba(0, 0, 0, 0.1);
    padding: var(--space-8);
    position: relative;
    z-index: 1;
  }
  .loading-state { display: flex; justify-content: center; padding: var(--space-8); }
  .step-indicators { display: flex; align-items: center; margin-bottom: var(--space-6); padding: var(--space-2) 0; gap: 0; }
  .step-dot { width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; border: 2px solid var(--color-border-hover, #adb5bd); background: var(--color-bg); color: var(--color-text-secondary); font-size: var(--text-sm); font-weight: var(--font-bold); display: flex; align-items: center; justify-content: center; cursor: default; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); position: relative; z-index: 1; }
  .step-dot:not(:disabled):not(.active):not(.completed) { cursor: pointer; }
  .step-dot:disabled { opacity: 0.5; cursor: not-allowed; }
  .step-dot.active { border-color: var(--color-primary); background: var(--color-primary); color: #000; transform: scale(1.1); box-shadow: 0 0 0 4px rgba(255, 157, 0, 0.15), 0 0 0 8px rgba(255, 157, 0, 0.05); }
  .step-dot.completed { border-color: var(--color-success); background: var(--color-success); color: #fff; cursor: pointer; }
  .step-dot.completed:hover { box-shadow: 0 0 0 4px rgba(64, 192, 87, 0.15); }
  .step-line { flex: 1; min-width: var(--space-4); height: 2px; background: var(--color-border); transition: background 0.4s ease; }
  .step-line.active { background: var(--color-success); }
  .step-content h2 { font-size: var(--text-2xl); font-weight: var(--font-bold); color: var(--color-text); margin-bottom: var(--space-2); letter-spacing: -0.01em; }
  .step-description { font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-6); line-height: 1.5; }
  .field-group { margin-bottom: var(--space-5); }
  .field-group label { display: block; font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text); margin-bottom: var(--space-2); }
  .field-group input, .field-group select { width: 100%; height: 44px; border: 1.5px solid var(--color-border); border-radius: var(--radius-lg); padding: 0 14px; background: var(--color-bg); color: var(--color-text); font-size: var(--text-base); transition: all 0.2s ease; }
  .field-group input::placeholder { color: var(--color-text-tertiary); }
  .field-group input:hover, .field-group select:hover { border-color: var(--color-border-hover); }
  .field-group input:focus, .field-group select:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 4px var(--color-primary-subtle); }
  .field-hint { margin-top: var(--space-2); font-size: var(--text-xs); color: var(--color-text-secondary); line-height: 1.5; }
  .field-error { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--radius-md); color: #dc2626; font-size: var(--text-sm); font-weight: var(--font-medium); }
  .field-warn {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
    color: #b45309;
    line-height: 1.5;
  }
  /* connection-type-card styles live in ConnectionPicker.svelte (scoped) */
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
  .step-content { display: flex; flex-direction: column; flex: 1; }
  .step-actions { display: flex; justify-content: flex-end; gap: var(--space-3); margin-top: auto; padding-top: var(--space-5); border-top: 1px solid var(--color-border); }
  .review-grid { display: flex; flex-direction: column; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: var(--space-2); }
  .review-section-header { display: flex; justify-content: space-between; align-items: center; padding: 8px var(--space-4); background: rgba(0, 0, 0, 0.04); font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--color-border); }
  .review-edit-btn { background: none; border: none; color: var(--color-primary); font-size: var(--text-xs); font-weight: var(--font-medium); cursor: pointer; padding: 2px 8px; border-radius: var(--radius-md); transition: all 0.15s ease; text-transform: none; letter-spacing: normal; }
  .review-edit-btn:hover { background: var(--color-primary-subtle); color: var(--color-primary-hover); }
  .review-item { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); padding: 10px var(--space-4); border-bottom: 1px solid var(--color-border); }
  .review-item:last-child { border-bottom: none; }
  .review-item:nth-child(even) { background: rgba(0, 0, 0, 0.03); }
  .review-label { font-size: var(--text-sm); color: var(--color-text-secondary); flex-shrink: 0; min-width: 140px; }
  .review-label--muted { color: var(--color-text-tertiary); font-style: italic; }
  .review-value { font-size: var(--text-sm); color: var(--color-text); text-align: right; word-break: break-all; font-weight: var(--font-medium); }
  .review-value.mono { font-family: var(--font-mono); font-size: 0.8rem; }
  .install-error { margin-top: var(--space-3); color: var(--color-danger); font-size: var(--text-sm); }
  .done-state { text-align: center; padding: var(--space-4) 0; }
  .done-icon { display: inline-block; margin-bottom: var(--space-4); }
  .done-state h2 { font-size: var(--text-2xl); font-weight: var(--font-bold); color: var(--color-text); margin-bottom: var(--space-2); }
  .done-subtitle { font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-5); }
  .service-list { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: center; margin-bottom: var(--space-6); }
  .service-list li { font-size: var(--text-xs); font-family: var(--font-mono); background: var(--color-success-bg); color: var(--color-success); border: 1px solid var(--color-success-border); padding: 2px 10px; border-radius: var(--radius-full); }
  .console-link { display: inline-flex; text-decoration: none; }
  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 10px 24px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-bold); line-height: 1.4; border: 1.5px solid transparent; border-radius: var(--radius-lg); cursor: pointer; transition: all 0.2s ease; white-space: nowrap; justify-content: center; }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-primary { background: var(--color-primary); color: #1a1a1a; border-color: transparent; border-radius: var(--radius-full); padding: 11px 32px; box-shadow: 0 1px 3px rgba(255, 157, 0, 0.3), 0 4px 12px rgba(255, 157, 0, 0.2); }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); box-shadow: 0 2px 6px rgba(255, 157, 0, 0.4), 0 8px 20px rgba(255, 157, 0, 0.25); transform: translateY(-2px); }
  .btn-primary:active:not(:disabled) { transform: translateY(0); box-shadow: 0 1px 4px rgba(255, 157, 0, 0.2); transition-duration: 0.1s; }
  .btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border-hover, #adb5bd); border-radius: var(--radius-full); }
  .btn-secondary:hover:not(:disabled) { background: var(--color-bg-secondary); border-color: var(--color-text-secondary); color: var(--color-text); }
  .btn-outline { background: transparent; color: var(--color-primary); border-color: var(--color-primary); }
  .btn-outline:hover:not(:disabled) { background: var(--color-primary-subtle); }
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
