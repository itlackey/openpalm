<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import {
    fetchConnectionsDto,
    createConnectionProfile,
    updateConnectionProfile,
    deleteConnectionProfile,
    fetchMemoryConfig,
    fetchProviderModels,
    saveConnectionsDto,
    testConnectionProfile,
  } from '$lib/api.js';
  import { EMBEDDING_DIMS } from '$lib/provider-constants.js';
  import { mapConnectionTestError } from '$lib/model-discovery.js';
  import type {
    CanonicalAssignmentsDto,
    CanonicalConnectionProfileDto,
    ConnectionProfilePayload,
  } from '$lib/types.js';
  import ConnectionForm from './ConnectionForm.svelte';
  import ModelSelector from './setup-wizard/ModelSelector.svelte';

  interface Props {
    loading: boolean;
    onRefresh: () => void;
  }

  let { loading, onRefresh }: Props = $props();

  // ── Profile list state ───────────────────────────────────────────
  let profiles = $state<CanonicalConnectionProfileDto[]>([]);
  let listLoading = $state(false);
  let listError = $state('');

  // ── Form panel state ─────────────────────────────────────────────
  let formMode = $state<'hidden' | 'create' | 'edit'>('hidden');
  let editingProfile = $state<CanonicalConnectionProfileDto | null>(null);

  // ── Inline test state (lifted from ConnectionForm) ────────────────
  let testLoading = $state(false);
  let testError = $state('');
  let testModelList = $state<string[]>([]);
  let connectionTested = $state(false);

  // ── Action feedback ───────────────────────────────────────────────
  let actionError = $state('');
  let actionSuccess = $state('');

  // ── Memory settings state ─────────────────────────────────────────
  let memoryUserId = $state('default_user');
  let memoryModel = $state('');
  let customInstructions = $state('');
  let llmConnectionId = $state('');
  let chatModel = $state('');
  let smallModel = $state('');
  let embeddingConnectionId = $state('');
  let embeddingModel = $state('');
  let embeddingDims = $state(1536);
  let rerankingEnabled = $state(false);
  let rerankingConnectionId = $state('');
  let rerankingMode = $state<'llm' | 'dedicated'>('llm');
  let rerankingModel = $state('');
  let rerankingTopN = $state(5);
  let ttsEnabled = $state(false);
  let ttsConnectionId = $state('');
  let ttsModel = $state('');
  let ttsVoice = $state('');
  let ttsFormat = $state('');
  let sttEnabled = $state(false);
  let sttConnectionId = $state('');
  let sttModel = $state('');
  let sttLanguage = $state('');
  let connectionModels = $state<Record<string, string[]>>({});
  let modelListLoading = $state<Record<string, boolean>>({});
  let modelListError = $state<Record<string, string>>({});
  let memorySaving = $state(false);
  let modelSaving = $state(false);
  let memorySaveError = $state('');
  let modelSaveError = $state('');
  let memorySaveSuccess = $state(false);
  let modelSaveSuccess = $state(false);
  let dimensionMismatch = $state(false);
  let dimensionWarning = $state('');
  let resetting = $state(false);
  let resetSuccess = $state(false);

  let selectedConnectionIds = $derived(
    [...new Set([
      llmConnectionId,
      embeddingConnectionId,
      rerankingEnabled ? rerankingConnectionId : '',
      ttsEnabled ? ttsConnectionId : '',
      sttEnabled ? sttConnectionId : '',
    ].filter(Boolean))]
  );

  // ── Load on mount ─────────────────────────────────────────────────
  void loadProfiles();
  void loadMemoryConfig();

  $effect(() => {
    for (const connectionId of selectedConnectionIds) {
      void loadModelsForConnection(connectionId);
    }
  });

  function getProfileById(connectionId: string): CanonicalConnectionProfileDto | undefined {
    return profiles.find((profile) => profile.id === connectionId);
  }

  function getModelOptions(connectionId: string): string[] {
    return connectionModels[connectionId] ?? [];
  }

  function getConnectionName(connectionId: string): string {
    return getProfileById(connectionId)?.name ?? 'No connection selected';
  }

  function getSelectedModelCopy(label: string, connectionId: string, model: string): string {
    if (!connectionId || !model.trim()) return `${label} is not configured yet.`;
    return `${label} uses ${getConnectionName(connectionId)}.`;
  }

  function getModelDiscoveryError(connectionId: string): string {
    return modelListError[connectionId] ?? '';
  }

  function readConfigValue(config: Record<string, unknown>, key: string): string {
    const value = config[key];
    return typeof value === 'string' ? value : '';
  }

  async function loadModelsForConnection(connectionId: string, force = false): Promise<void> {
    const token = getAdminToken();
    if (!token || !connectionId) return;

    const profile = getProfileById(connectionId);
    if (!profile) return;

    if (!force && connectionId in connectionModels) return;
    if (modelListLoading[connectionId]) return;

    modelListLoading = { ...modelListLoading, [connectionId]: true };
    modelListError = { ...modelListError, [connectionId]: '' };
    try {
      const result = await fetchProviderModels(
        token,
        profile.provider,
        profile.auth.apiKeySecretRef ?? '',
        profile.baseUrl,
      );
      connectionModels = { ...connectionModels, [connectionId]: result.models ?? [] };
      if (result.status === 'recoverable_error') {
        modelListError = {
          ...modelListError,
          [connectionId]: result.error || 'Could not fetch models for this connection.',
        };
      }
    } catch {
      connectionModels = { ...connectionModels, [connectionId]: [] };
      modelListError = {
        ...modelListError,
        [connectionId]: 'Could not fetch models for this connection.',
      };
    } finally {
      modelListLoading = { ...modelListLoading, [connectionId]: false };
    }
  }

  function handleEmbeddingModelChange(newModel: string): void {
    embeddingModel = newModel;

    const profile = getProfileById(embeddingConnectionId);
    if (!profile) return;

    const dims = EMBEDDING_DIMS[`${profile.provider}/${newModel}`];
    if (dims) {
      embeddingDims = dims;
    }
  }

  function applyAssignments(assignments: CanonicalAssignmentsDto): void {
    llmConnectionId = assignments.llm.connectionId;
    chatModel = assignments.llm.model;
    smallModel = assignments.llm.smallModel ?? '';

    embeddingConnectionId = assignments.embeddings.connectionId;
    embeddingModel = assignments.embeddings.model;
    embeddingDims = assignments.embeddings.embeddingDims ?? 1536;

    rerankingEnabled = assignments.reranking?.enabled ?? false;
    rerankingConnectionId = assignments.reranking?.connectionId ?? '';
    rerankingMode = assignments.reranking?.mode ?? 'llm';
    rerankingModel = assignments.reranking?.model ?? '';
    rerankingTopN = assignments.reranking?.topN ?? 5;

    ttsEnabled = assignments.tts?.enabled ?? false;
    ttsConnectionId = assignments.tts?.connectionId ?? '';
    ttsModel = assignments.tts?.model ?? '';
    ttsVoice = assignments.tts?.voice ?? '';
    ttsFormat = assignments.tts?.format ?? '';

    sttEnabled = assignments.stt?.enabled ?? false;
    sttConnectionId = assignments.stt?.connectionId ?? '';
    sttModel = assignments.stt?.model ?? '';
    sttLanguage = assignments.stt?.language ?? '';
  }

  function buildAssignments(): CanonicalAssignmentsDto {
    return {
      llm: {
        connectionId: llmConnectionId,
        model: chatModel,
        ...(smallModel.trim() ? { smallModel: smallModel.trim() } : {}),
      },
      embeddings: {
        connectionId: embeddingConnectionId,
        model: embeddingModel,
        embeddingDims,
      },
      reranking: {
        enabled: rerankingEnabled,
        ...(rerankingEnabled && rerankingConnectionId ? { connectionId: rerankingConnectionId } : {}),
        ...(rerankingEnabled ? { mode: rerankingMode } : {}),
        ...(rerankingEnabled && rerankingModel.trim() ? { model: rerankingModel.trim() } : {}),
        ...(rerankingEnabled ? { topN: rerankingTopN } : {}),
      },
      tts: {
        enabled: ttsEnabled,
        ...(ttsEnabled && ttsConnectionId ? { connectionId: ttsConnectionId } : {}),
        ...(ttsEnabled && ttsModel.trim() ? { model: ttsModel.trim() } : {}),
        ...(ttsEnabled && ttsVoice.trim() ? { voice: ttsVoice.trim() } : {}),
        ...(ttsEnabled && ttsFormat.trim() ? { format: ttsFormat.trim() } : {}),
      },
      stt: {
        enabled: sttEnabled,
        ...(sttEnabled && sttConnectionId ? { connectionId: sttConnectionId } : {}),
        ...(sttEnabled && sttModel.trim() ? { model: sttModel.trim() } : {}),
        ...(sttEnabled && sttLanguage.trim() ? { language: sttLanguage.trim() } : {}),
      },
    };
  }

  function validateSettings(section: 'memory' | 'model'): string {
    if (profiles.length === 0) {
      return 'Add a connection before saving settings.';
    }
    if (!llmConnectionId.trim()) return 'Select a chat connection.';
    if (!chatModel.trim()) return 'Chat model is required.';
    if (!memoryModel.trim()) return 'Memory model is required.';
    if (!embeddingConnectionId.trim()) return 'Select an embedding connection.';
    if (!embeddingModel.trim()) return 'Embedding model is required.';
    if (rerankingEnabled && !rerankingConnectionId.trim()) return 'Select a reranker connection.';
    if (ttsEnabled && !ttsConnectionId.trim()) return 'Select a text-to-speech connection.';
    if (sttEnabled && !sttConnectionId.trim()) return 'Select a speech-to-text connection.';
    return '';
  }

  async function saveSettings(section: 'memory' | 'model'): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    const validationError = validateSettings(section);
    if (validationError) {
      if (section === 'memory') {
        memorySaveError = validationError;
        memorySaveSuccess = false;
      } else {
        modelSaveError = validationError;
        modelSaveSuccess = false;
      }
      return;
    }

    if (section === 'memory') {
      memorySaving = true;
      memorySaveError = '';
      memorySaveSuccess = false;
    } else {
      modelSaving = true;
      modelSaveError = '';
      modelSaveSuccess = false;
    }

    dimensionWarning = '';
    dimensionMismatch = false;
    resetSuccess = false;

    try {
      const result = await saveConnectionsDto(token, {
        profiles,
        assignments: buildAssignments(),
        memoryModel,
        memoryUserId,
        customInstructions,
      });

      if (result.ok) {
        if (section === 'memory') {
          memorySaveSuccess = true;
          modelSaveSuccess = false;
        } else {
          modelSaveSuccess = true;
          memorySaveSuccess = false;
        }

        if (result.dimensionMismatch) {
          dimensionMismatch = true;
          dimensionWarning = result.dimensionWarning ?? 'Embedding dimensions changed. Reset the memory collection to apply.';
        }

        await loadMemoryConfig();
        onRefresh();
      } else if (section === 'memory') {
        memorySaveError = 'Failed to save memory settings.';
      } else {
        modelSaveError = 'Failed to save model settings.';
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unable to reach admin API.';
      if (section === 'memory') {
        memorySaveError = message;
      } else {
        modelSaveError = message;
      }
    } finally {
      if (section === 'memory') {
        memorySaving = false;
      } else {
        modelSaving = false;
      }
    }
  }

  async function loadProfiles(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    listLoading = true;
    listError = '';
    try {
      const dto = await fetchConnectionsDto(token);
      profiles = dto.profiles;
    } catch {
      listError = 'Failed to load connections.';
    } finally {
      listLoading = false;
    }
  }

  async function loadMemoryConfig(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    try {
      const conns = await fetchConnectionsDto(token);
      profiles = conns.profiles;
      if (conns.connections['MEMORY_USER_ID']) memoryUserId = conns.connections['MEMORY_USER_ID'];
      applyAssignments(conns.assignments);

      if (conns.connections['EMBEDDING_DIMS']) {
        embeddingDims = Number(conns.connections['EMBEDDING_DIMS']) || embeddingDims;
      }

      try {
        const omData = await fetchMemoryConfig(token);
        customInstructions = omData.config.memory.custom_instructions ?? '';
        memoryModel = readConfigValue(omData.config.mem0.llm.config, 'model') || conns.assignments.llm.model;

        const persistedEmbeddingModel = readConfigValue(omData.config.mem0.embedder.config, 'model');
        if (persistedEmbeddingModel) {
          embeddingModel = persistedEmbeddingModel;
        }

        const persistedDims = omData.config.mem0.vector_store.config.embedding_model_dims;
        if (Number.isInteger(persistedDims) && persistedDims > 0) {
          embeddingDims = persistedDims;
        }
      } catch {
        memoryModel = conns.assignments.llm.model;
      }
    } catch {
      // Memory config may not exist yet — fall through
    }
  }

  // ── Profile CRUD action handlers ──────────────────────────────────

  function handleAddNew(): void {
    editingProfile = null;
    formMode = 'create';
    clearFeedback();
    resetTestState();
  }

  function handleEdit(profile: CanonicalConnectionProfileDto): void {
    editingProfile = profile;
    formMode = 'edit';
    clearFeedback();
    resetTestState();
  }

  async function handleDuplicate(profile: CanonicalConnectionProfileDto): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    actionError = '';
    try {
      const copy: ConnectionProfilePayload = {
        id: crypto.randomUUID().slice(0, 8),
        name: `${profile.name} (copy)`,
        kind: profile.kind as 'openai_compatible_remote' | 'openai_compatible_local',
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        auth: {
          mode: profile.auth.mode,
          apiKeySecretRef: profile.auth.apiKeySecretRef,
        },
      };
      await createConnectionProfile(token, copy);
      await loadProfiles();
      actionSuccess = `Duplicated "${profile.name}".`;
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to duplicate.';
    }
  }

  async function handleRemove(profile: CanonicalConnectionProfileDto): Promise<void> {
    if (!confirm(`Remove "${profile.name}"? This cannot be undone.`)) return;
    const token = getAdminToken();
    if (!token) return;
    actionError = '';
    try {
      await deleteConnectionProfile(token, profile.id);
      await loadProfiles();
      actionSuccess = `Removed "${profile.name}".`;
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to remove.';
    }
  }

  async function handleFormSave(payload: ConnectionProfilePayload): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    actionError = '';
    try {
      if (formMode === 'create') {
        await createConnectionProfile(token, payload);
        actionSuccess = `Connection "${payload.name}" added.`;
      } else {
        await updateConnectionProfile(token, payload);
        actionSuccess = `Connection "${payload.name}" updated.`;
      }
      formMode = 'hidden';
      editingProfile = null;
      resetTestState();
      await loadProfiles();
      onRefresh();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Failed to save.';
    }
  }

  function handleFormCancel(): void {
    formMode = 'hidden';
    editingProfile = null;
    resetTestState();
  }

  async function handleTest(draft: { baseUrl: string; apiKey: string; kind: string }): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    testLoading = true;
    testError = '';
    testModelList = [];
    connectionTested = false;
    try {
      const result = await testConnectionProfile(token, draft);
      if (!result.ok) {
        testError = mapConnectionTestError(result);
        return;
      }
      testModelList = result.models ?? [];
      connectionTested = true;
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
    connectionTested = false;
  }

  async function handleResetCollection(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;

    if (!confirm('This will delete all stored memories. The collection will be recreated with the correct dimensions on restart. Continue?')) {
      return;
    }

    resetting = true;
    try {
      const res = await fetch('/admin/memory/reset-collection', {
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
        memorySaveError = data.message ?? 'Failed to reset memory collection.';
      }
    } catch {
      memorySaveError = 'Unable to reach admin API.';
    } finally {
      resetting = false;
    }
  }
</script>

<section class="connections-tab" aria-label="Connections configuration">
  <div class="tab-header">
    <div class="tab-header-text">
      <h2>Connections</h2>
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
      aria-label="Refresh connections"
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

  <!-- ── Profiles list ─────────────────────────────────────────── -->
  <section class="panel connections-section">
    <div class="panel-header">
      <h3>Connections</h3>
      {#if !listLoading}
        <button class="btn btn-sm btn-outline" type="button" onclick={handleAddNew}>
          Add connection
        </button>
      {/if}
    </div>

    <div class="panel-body" style="padding: 0;">
      {#if listLoading}
        <div class="loading-state">
          <span class="spinner"></span>
          <span>Loading connections...</span>
        </div>
      {:else if listError}
        <div class="list-error">
          <span>{listError}</span>
          <button class="btn btn-sm btn-ghost" type="button" onclick={loadProfiles}>
            Retry
          </button>
        </div>
      {:else if profiles.length === 0}
        <div class="empty-state">
          <p class="empty-headline">No connections yet</p>
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
            <span class="conn-col conn-col--type">Type</span>
            <span class="conn-col conn-col--url">Base URL</span>
            <span class="conn-col conn-col--auth">Auth</span>
            <span class="conn-col conn-col--actions"></span>
          </div>
          {#each profiles as profile (profile.id)}
            <div class="conn-table-row">
              <span class="conn-col conn-col--name conn-name">{profile.name}</span>
              <span class="conn-col conn-col--type">
                <span class="badge {profile.kind === 'openai_compatible_local' ? 'badge-local' : 'badge-remote'}">
                  {profile.kind === 'openai_compatible_local' ? 'Local' : 'Remote'}
                </span>
              </span>
              <span class="conn-col conn-col--url conn-url" title={profile.baseUrl}>
                {profile.baseUrl}
              </span>
              <span class="conn-col conn-col--auth">
                {profile.auth.mode === 'api_key' ? 'Key set' : 'No key'}
              </span>
              <span class="conn-col conn-col--actions">
                <button class="btn-action" type="button"
                  onclick={() => handleEdit(profile)} aria-label="Edit {profile.name}">
                  Edit
                </button>
                <button class="btn-action" type="button"
                  onclick={() => void handleDuplicate(profile)}
                  aria-label="Duplicate {profile.name}">
                  Duplicate
                </button>
                <button class="btn-action btn-action--danger" type="button"
                  onclick={() => void handleRemove(profile)}
                  aria-label="Remove {profile.name}">
                  Remove
                </button>
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <!-- ── ConnectionForm panel (create / edit) ─────────────────── -->
  {#if formMode !== 'hidden'}
    <section class="panel connections-section">
      <div class="panel-header">
        <h3>{formMode === 'create' ? 'Add connection' : 'Edit connection'}</h3>
      </div>
      <div class="panel-body">
        <ConnectionForm
          initial={editingProfile}
          {testLoading}
          modelList={testModelList}
          {testError}
          {connectionTested}
          onSave={(payload) => void handleFormSave(payload)}
          onCancel={handleFormCancel}
          onTest={(draft) => void handleTest(draft)}
        />
      </div>
    </section>
  {/if}

  <!-- ── Memory Settings ────────────────────────────────────────── -->
  <form onsubmit={(e) => { e.preventDefault(); void saveSettings('memory'); }} novalidate>
    <section class="panel connections-section">
      <div class="panel-header">
        <h3>Memory Settings</h3>
      </div>
      <div class="panel-body">
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
            <label for="memory-model" class="form-label">Memory model</label>
            <ModelSelector
              id="memory-model"
              value={memoryModel}
              options={getModelOptions(llmConnectionId)}
              placeholder="gpt-4o-mini"
              onChange={(value) => memoryModel = value}
            />
            <span class="field-hint">{getSelectedModelCopy('Memory model', llmConnectionId, memoryModel)}</span>
            {#if modelListLoading[llmConnectionId]}
              <span class="field-status">Loading models from {getConnectionName(llmConnectionId)}...</span>
            {:else if getModelDiscoveryError(llmConnectionId)}
              <div class="field-status-row">
                <span class="field-status field-status--warning">{getModelDiscoveryError(llmConnectionId)}</span>
                <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(llmConnectionId, true)}>Retry</button>
              </div>
            {/if}
          </div>

          <div class="form-field">
            <label for="memory-embedding-connection" class="form-label">Embedding connection</label>
            <select
              id="memory-embedding-connection"
              class="form-input"
              bind:value={embeddingConnectionId}
            >
              <option value="">- select connection -</option>
              {#each profiles as profile}
                <option value={profile.id}>{profile.name}</option>
              {/each}
            </select>
          </div>

          <div class="form-field">
            <label for="memory-embedding-model" class="form-label">Embedding model</label>
            <ModelSelector
              id="memory-embedding-model"
              value={embeddingModel}
              options={getModelOptions(embeddingConnectionId)}
              placeholder="text-embedding-3-small"
              onChange={handleEmbeddingModelChange}
            />
            <span class="field-hint">{getSelectedModelCopy('Embedding model', embeddingConnectionId, embeddingModel)} Changing embeddings later requires a collection reset.</span>
            {#if modelListLoading[embeddingConnectionId]}
              <span class="field-status">Loading models from {getConnectionName(embeddingConnectionId)}...</span>
            {:else if getModelDiscoveryError(embeddingConnectionId)}
              <div class="field-status-row">
                <span class="field-status field-status--warning">{getModelDiscoveryError(embeddingConnectionId)}</span>
                <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(embeddingConnectionId, true)}>Retry</button>
              </div>
            {/if}
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

          <div class="form-field form-field-full">
            <div class="addon-row" class:addon-row--active={rerankingEnabled}>
              <div class="addon-toggle-row">
                <label class="addon-toggle-label">
                  <input type="checkbox" bind:checked={rerankingEnabled} />
                  <span class="addon-label-text">Enable reranking</span>
                </label>
                <span class="addon-help">Improves memory retrieval relevance by re-ordering retrieved items.</span>
              </div>
              {#if rerankingEnabled}
                <div class="addon-fields">
                  <div class="field-group">
                    <fieldset class="radio-fieldset">
                      <legend class="radio-legend">Reranker type</legend>
                      <div class="radio-group">
                        <label class="radio-label">
                          <input type="radio" name="reranking-type-admin" value="llm" checked={rerankingMode === 'llm'} onchange={() => rerankingMode = 'llm'} />
                          Use an LLM to rerank
                        </label>
                        <label class="radio-label">
                          <input type="radio" name="reranking-type-admin" value="dedicated" checked={rerankingMode === 'dedicated'} onchange={() => rerankingMode = 'dedicated'} />
                          Use a dedicated reranker
                        </label>
                      </div>
                    </fieldset>
                  </div>
                  <div class="field-group">
                    <label for="reranking-connection-admin">Connection</label>
                    <select id="reranking-connection-admin" bind:value={rerankingConnectionId}>
                      <option value="">- select connection -</option>
                      {#each profiles as profile}
                        <option value={profile.id}>{profile.name}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="field-group">
                    <label for="reranking-model-admin">Model</label>
                    <ModelSelector
                      id="reranking-model-admin"
                      value={rerankingModel}
                      options={getModelOptions(rerankingConnectionId)}
                      placeholder="e.g., rerank-2"
                      onChange={(value) => rerankingModel = value}
                    />
                    <span class="field-hint">{getSelectedModelCopy('Reranker model', rerankingConnectionId, rerankingModel)}</span>
                    {#if modelListLoading[rerankingConnectionId]}
                      <span class="field-status">Loading models from {getConnectionName(rerankingConnectionId)}...</span>
                    {:else if getModelDiscoveryError(rerankingConnectionId)}
                      <div class="field-status-row">
                        <span class="field-status field-status--warning">{getModelDiscoveryError(rerankingConnectionId)}</span>
                        <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(rerankingConnectionId, true)}>Retry</button>
                      </div>
                    {/if}
                  </div>
                  <div class="field-group">
                    <label for="reranking-topn-admin">Top N results</label>
                    <input id="reranking-topn-admin" type="number" min="1" step="1" bind:value={rerankingTopN} />
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </section>

    {#if memorySaveSuccess}
      <div class="feedback feedback--success" role="status" aria-live="polite">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Memory settings saved.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => memorySaveSuccess = false}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    {#if memorySaveError}
      <div class="feedback feedback--error" role="alert" aria-live="assertive">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{memorySaveError}</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => memorySaveError = ''}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    <div class="form-actions">
      <button class="btn btn-primary" type="submit" disabled={memorySaving}>
        {#if memorySaving}
          <span class="spinner"></span>
        {/if}
        Save Memory Settings
      </button>
    </div>
  </form>

  <form onsubmit={(e) => { e.preventDefault(); void saveSettings('model'); }} novalidate>
    <section class="panel connections-section">
      <div class="panel-header">
        <h3>Model Settings</h3>
      </div>
      <div class="panel-body settings-stack">
        <div class="settings-card">
          <div class="settings-card-header">
            <span class="settings-card-title">Chat Models</span>
            <span class="settings-card-help">Choose the default chat and small models used by OpenCode.</span>
          </div>

          <div class="field-group">
            <label for="chat-connection-admin">Connection</label>
            <select id="chat-connection-admin" bind:value={llmConnectionId}>
              <option value="">- select connection -</option>
              {#each profiles as profile}
                <option value={profile.id}>{profile.name}</option>
              {/each}
            </select>
          </div>

          <div class="field-group">
            <label for="chat-model-admin">Chat model</label>
            <ModelSelector
              id="chat-model-admin"
              value={chatModel}
              options={getModelOptions(llmConnectionId)}
              placeholder="gpt-4o-mini"
              onChange={(value) => chatModel = value}
            />
            <span class="field-hint">{getSelectedModelCopy('Chat model', llmConnectionId, chatModel)}</span>
            {#if modelListLoading[llmConnectionId]}
              <span class="field-status">Loading models from {getConnectionName(llmConnectionId)}...</span>
            {:else if getModelDiscoveryError(llmConnectionId)}
              <div class="field-status-row">
                <span class="field-status field-status--warning">{getModelDiscoveryError(llmConnectionId)}</span>
                <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(llmConnectionId, true)}>Retry</button>
              </div>
            {/if}
          </div>

          <div class="field-group">
            <label for="small-model-admin">Small model</label>
            <ModelSelector
              id="small-model-admin"
              value={smallModel}
              options={getModelOptions(llmConnectionId)}
              placeholder="Defaults to the chat model when left blank"
              onChange={(value) => smallModel = value}
            />
            <p class="field-hint">{getSelectedModelCopy('Small model', llmConnectionId, smallModel)} Use a cheaper or faster model for lightweight tasks.</p>
          </div>
        </div>

        <div class="addon-row" class:addon-row--active={ttsEnabled}>
          <div class="addon-toggle-row">
            <label class="addon-toggle-label">
              <input type="checkbox" bind:checked={ttsEnabled} />
              <span class="addon-label-text">Enable text-to-speech</span>
            </label>
            <span class="addon-help">Turns responses into audio.</span>
          </div>
          {#if ttsEnabled}
            <div class="addon-fields">
              <div class="field-group">
                <label for="tts-connection-admin">Connection</label>
                <select id="tts-connection-admin" bind:value={ttsConnectionId}>
                  <option value="">- select connection -</option>
                  {#each profiles as profile}
                    <option value={profile.id}>{profile.name}</option>
                  {/each}
                </select>
              </div>
              <div class="field-group">
                <label for="tts-model-admin">Model</label>
                <ModelSelector
                  id="tts-model-admin"
                  value={ttsModel}
                  options={getModelOptions(ttsConnectionId)}
                  placeholder="e.g., tts-1"
                  onChange={(value) => ttsModel = value}
                />
                <span class="field-hint">{getSelectedModelCopy('Text-to-speech model', ttsConnectionId, ttsModel)}</span>
                {#if modelListLoading[ttsConnectionId]}
                  <span class="field-status">Loading models from {getConnectionName(ttsConnectionId)}...</span>
                {:else if getModelDiscoveryError(ttsConnectionId)}
                  <div class="field-status-row">
                    <span class="field-status field-status--warning">{getModelDiscoveryError(ttsConnectionId)}</span>
                    <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(ttsConnectionId, true)}>Retry</button>
                  </div>
                {/if}
              </div>
              <div class="field-group">
                <label for="tts-voice-admin">Voice</label>
                <input id="tts-voice-admin" type="text" bind:value={ttsVoice} placeholder="e.g., alloy" />
              </div>
              <div class="field-group">
                <label for="tts-format-admin">Output format</label>
                <input id="tts-format-admin" type="text" bind:value={ttsFormat} placeholder="e.g., mp3" />
              </div>
            </div>
          {/if}
        </div>

        <div class="addon-row" class:addon-row--active={sttEnabled}>
          <div class="addon-toggle-row">
            <label class="addon-toggle-label">
              <input type="checkbox" bind:checked={sttEnabled} />
              <span class="addon-label-text">Enable speech-to-text</span>
            </label>
            <span class="addon-help">Transcribes audio into text.</span>
          </div>
          {#if sttEnabled}
            <div class="addon-fields">
              <div class="field-group">
                <label for="stt-connection-admin">Connection</label>
                <select id="stt-connection-admin" bind:value={sttConnectionId}>
                  <option value="">- select connection -</option>
                  {#each profiles as profile}
                    <option value={profile.id}>{profile.name}</option>
                  {/each}
                </select>
              </div>
              <div class="field-group">
                <label for="stt-model-admin">Model</label>
                <ModelSelector
                  id="stt-model-admin"
                  value={sttModel}
                  options={getModelOptions(sttConnectionId)}
                  placeholder="e.g., whisper-1"
                  onChange={(value) => sttModel = value}
                />
                <span class="field-hint">{getSelectedModelCopy('Speech-to-text model', sttConnectionId, sttModel)}</span>
                {#if modelListLoading[sttConnectionId]}
                  <span class="field-status">Loading models from {getConnectionName(sttConnectionId)}...</span>
                {:else if getModelDiscoveryError(sttConnectionId)}
                  <div class="field-status-row">
                    <span class="field-status field-status--warning">{getModelDiscoveryError(sttConnectionId)}</span>
                    <button class="btn-link-inline" type="button" onclick={() => void loadModelsForConnection(sttConnectionId, true)}>Retry</button>
                  </div>
                {/if}
              </div>
              <div class="field-group">
                <label for="stt-language-admin">Language</label>
                <input id="stt-language-admin" type="text" bind:value={sttLanguage} placeholder="e.g., en" />
              </div>
            </div>
          {/if}
        </div>
      </div>
    </section>

    {#if modelSaveSuccess}
      <div class="feedback feedback--success" role="status" aria-live="polite">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Model settings saved.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => modelSaveSuccess = false}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    {#if modelSaveError}
      <div class="feedback feedback--error" role="alert" aria-live="assertive">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{modelSaveError}</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => modelSaveError = ''}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    <div class="form-actions">
      <button class="btn btn-primary" type="submit" disabled={modelSaving}>
        {#if modelSaving}
          <span class="spinner"></span>
        {/if}
        Save Model Settings
      </button>
    </div>
  </form>
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

  .field-status-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .field-status {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .field-status--warning {
    color: var(--color-warning, #b45309);
  }

  .btn-link-inline {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    cursor: pointer;
  }

  .btn-link-inline:hover {
    text-decoration: underline;
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

  .field-group label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .field-group input[type='text'],
  .field-group input[type='number'],
  .field-group select {
    width: 100%;
    height: 44px;
    border: 1.5px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: 0 14px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-base);
    transition: all 0.2s ease;
  }

  .field-group input:focus,
  .field-group select:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 4px var(--color-primary-subtle);
  }

  .addon-row {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .addon-row--active {
    border-color: var(--color-primary);
  }

  .addon-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
  }

  .addon-toggle-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    flex-shrink: 0;
  }

  .addon-label-text {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .addon-help {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.4;
    padding-top: 2px;
  }

  .addon-fields {
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }

  .radio-fieldset {
    border: none;
    padding: 0;
    margin: 0;
  }

  .radio-legend {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
    padding: 0;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
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

  .conn-col--name  { flex: 2; min-width: 0; }
  .conn-col--type  { flex: 1; min-width: 0; }
  .conn-col--url   { flex: 3; min-width: 0; overflow: hidden;
                     text-overflow: ellipsis; white-space: nowrap; }
  .conn-col--auth  { flex: 1; min-width: 0; }
  .conn-col--actions {
    flex: 0 0 auto;
    display: flex;
    gap: var(--space-2);
  }

  .conn-name {
    font-weight: var(--font-medium);
  }

  .conn-url {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .badge-local {
    color: var(--color-info);
    background: var(--color-info-bg);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
  }

  .badge-remote {
    color: var(--color-text-secondary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
  }

  .btn-action {
    background: none;
    border: none;
    font-size: var(--text-xs);
    font-family: var(--font-sans);
    font-weight: var(--font-medium);
    color: var(--color-primary);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
  }

  .btn-action:hover {
    text-decoration: underline;
  }

  .btn-action--danger {
    color: var(--color-danger);
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

    .conn-col--url,
    .conn-col--auth {
      display: none;
    }
  }
</style>
