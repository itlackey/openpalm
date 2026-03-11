<script lang="ts">
  import { SETUP_WIZARD_COPY } from '$lib/setup-wizard/copy.js';
  import { EMBEDDING_DIMS } from '$lib/provider-constants.js';
  import ModelSelector from '$lib/components/setup-wizard/ModelSelector.svelte';
  import type { WizardConnectionDraft, WizardAssignments } from '$lib/setup-wizard/state.js';

  interface Props {
    connections: WizardConnectionDraft[];
    assignments: WizardAssignments;
    connectError: string;
    onAssignmentsChange: (next: WizardAssignments) => void;
    onAddConnection: () => void;
    onBack: () => void;
    onNext: () => void;
  }

  let {
    connections,
    assignments,
    connectError,
    onAssignmentsChange,
    onAddConnection,
    onBack,
    onNext,
  }: Props = $props();

  let llmConnection = $derived(connections.find(c => c.id === assignments.llm.connectionId));
  let embConnection = $derived(connections.find(c => c.id === assignments.embeddings.connectionId));

  let llmModelList = $derived(llmConnection?.modelList ?? []);
  let embModelList = $derived(embConnection?.modelList ?? []);
  let embeddingModelOptions = $derived(getEmbeddingModelOptions(embConnection, embModelList, assignments.embeddings.model));
  let embeddingDimsHint = $derived(getEmbeddingDimsHint());

  function resolveEmbeddingDims(provider: string, model: string): number | null {
    const exact = EMBEDDING_DIMS[`${provider}/${model}`];
    if (exact) return exact;

    const withoutTag = model.replace(/:[^/]+$/, '');
    const canonical = EMBEDDING_DIMS[`${provider}/${withoutTag}`];
    if (canonical) return canonical;

    const prefixMatch = Object.entries(EMBEDDING_DIMS).find(([key]) => {
      const [knownProvider, knownModel] = key.split('/', 2);
      return knownProvider === provider && (model === knownModel || model.startsWith(`${knownModel}:`));
    });

    return prefixMatch?.[1] ?? null;
  }

  function isEmbeddingLikeModel(model: string): boolean {
    return /embed|embedding|bge|e5|nomic|minilm|mxbai|arctic|ada/i.test(model);
  }

  function getEmbeddingModelOptions(
    connection: WizardConnectionDraft | undefined,
    models: string[],
    currentModel: string,
  ): string[] {
    if (models.length === 0) return [];

    const filtered = models.filter((model) => {
      if (!connection) return isEmbeddingLikeModel(model);
      return resolveEmbeddingDims(connection.provider, model) !== null || isEmbeddingLikeModel(model);
    });

    if (filtered.length === 0) return models;
    if (currentModel && !filtered.includes(currentModel) && models.includes(currentModel)) {
      return [currentModel, ...filtered];
    }

    return filtered;
  }

  function pickPreferredEmbeddingModel(connection: WizardConnectionDraft | undefined, models: string[]): string {
    if (models.length === 0) return '';

    if (connection) {
      const knownModel = models.find((model) => resolveEmbeddingDims(connection.provider, model) !== null);
      if (knownModel) return knownModel;
    }

    const embeddingLike = models.find((model) => isEmbeddingLikeModel(model));
    if (embeddingLike) return embeddingLike;

    return models[0];
  }

  function handleEmbeddingConnectionChange(connectionId: string): void {
    const nextConnection = connections.find((connection) => connection.id === connectionId);
    const nextModel = pickPreferredEmbeddingModel(nextConnection, nextConnection?.modelList ?? []);

    let nextEmbeddingDims = assignments.embeddings.embeddingDims;
    if (nextConnection && nextModel) {
      nextEmbeddingDims = resolveEmbeddingDims(nextConnection.provider, nextModel) ?? nextEmbeddingDims;
    }

    onAssignmentsChange({
      ...assignments,
      embeddings: {
        ...assignments.embeddings,
        connectionId,
        model: nextModel || assignments.embeddings.model,
        embeddingDims: nextEmbeddingDims,
        sameAsLlm: false,
      },
    });
  }

  function handleEmbeddingModelChange(newModel: string): void {
    const conn = embConnection;
    let embeddingDims = assignments.embeddings.embeddingDims;
    if (conn) {
      const nextDims = resolveEmbeddingDims(conn.provider, newModel);
      if (nextDims) {
        embeddingDims = nextDims;
      }
    }
    onAssignmentsChange({
      ...assignments,
      embeddings: { ...assignments.embeddings, model: newModel, embeddingDims },
    });
  }

  function getEmbeddingDimsHint(): string {
    if (!assignments.embeddings.model.trim() || !embConnection) {
      return 'Choose an embedding model to auto-fill dimensions when possible.';
    }

    const detectedDims = resolveEmbeddingDims(embConnection.provider, assignments.embeddings.model);
    if (detectedDims !== null) {
      return `Dimensions auto-detected for this model: ${detectedDims}.`;
    }

    return `Dimensions are using the current value (${assignments.embeddings.embeddingDims}) because this model is not in the known embedding map yet.`;
  }

</script>

<div class="step-content" data-testid="step-models">
  <h2>{SETUP_WIZARD_COPY.selectModelsTitle}</h2>
  <p class="step-description">{SETUP_WIZARD_COPY.selectModelsDescription}</p>

  <!-- LLM Card -->
  <div class="model-card">
    <div class="model-card-header">
      <span class="model-card-title">{SETUP_WIZARD_COPY.llmCardTitle}</span>
      <span class="model-card-help">{SETUP_WIZARD_COPY.llmCardHelp}</span>
    </div>

    <div class="field-group">
      <label for="llm-connection">{SETUP_WIZARD_COPY.llmConnectionLabel}</label>
      <select id="llm-connection" value={assignments.llm.connectionId} onchange={(e) => {
        const nextConnectionId = e.currentTarget.value;
        const nextConnection = connections.find((connection) => connection.id === nextConnectionId);
        const nextChatModel = nextConnection?.modelList[0] ?? assignments.llm.model;
        const nextSmallModel = nextConnection?.modelList.includes(assignments.llm.smallModel)
          ? assignments.llm.smallModel
          : (nextConnection?.modelList[0] ?? assignments.llm.smallModel);

        onAssignmentsChange({
          ...assignments,
          llm: {
            ...assignments.llm,
            connectionId: nextConnectionId,
            model: nextChatModel,
            smallModel: nextSmallModel,
          },
        });
      }}>
        <option value="" disabled>{SETUP_WIZARD_COPY.llmConnectionPlaceholder}</option>
        {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
      </select>
    </div>

    <div class="field-group">
      <label for="system-model">Chat model</label>
      <ModelSelector
        id="system-model"
        value={assignments.llm.model}
        options={llmModelList}
        placeholder="gpt-4o-mini"
        onChange={(v) => onAssignmentsChange({ ...assignments, llm: { ...assignments.llm, model: v } })}
      />
    </div>

    <div class="field-group">
      <label for="small-model">{SETUP_WIZARD_COPY.llmSmallModelLabel}</label>
      <ModelSelector
        id="small-model"
        value={assignments.llm.smallModel}
        options={llmModelList}
        placeholder={SETUP_WIZARD_COPY.llmSmallModelPlaceholder}
        onChange={(v) => onAssignmentsChange({ ...assignments, llm: { ...assignments.llm, smallModel: v } })}
      />
      <p class="field-hint">{SETUP_WIZARD_COPY.llmSmallModelHint}</p>
    </div>
  </div>

  <!-- Embeddings Card -->
  <div class="model-card">
    <div class="model-card-header">
      <span class="model-card-title">{SETUP_WIZARD_COPY.embeddingsCardTitle}</span>
      <span class="model-card-help">{SETUP_WIZARD_COPY.embeddingsCardHelp}</span>
    </div>

    <div class="field-group">
      <label for="emb-connection">{SETUP_WIZARD_COPY.embeddingConnectionLabel}</label>
      <select id="emb-connection" value={assignments.embeddings.connectionId} onchange={(e) => {
        handleEmbeddingConnectionChange(e.currentTarget.value);
      }}>
        <option value="" disabled>{SETUP_WIZARD_COPY.embeddingConnectionPlaceholder}</option>
        {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
      </select>
    </div>

    <div class="field-group">
      <label for="embedding-model">Embedding model</label>
      <ModelSelector
        id="embedding-model"
        value={assignments.embeddings.model}
        options={embeddingModelOptions}
        placeholder="text-embedding-3-small"
        onChange={handleEmbeddingModelChange}
      />
      <p class="field-hint">Used for memory vector embeddings. The list prefers embedding-capable models.</p>
      <p class="field-hint field-hint--accent">{embeddingDimsHint}</p>
    </div>

    <div class="field-group field-group--compact">
      <label for="embedding-dims">{SETUP_WIZARD_COPY.embeddingsDimsLabel}</label>
      <input
        id="embedding-dims"
        type="number"
        value={assignments.embeddings.embeddingDims}
        placeholder={SETUP_WIZARD_COPY.embeddingsDimsPlaceholder}
        min="1"
        step="1"
        oninput={(e) => onAssignmentsChange({
          ...assignments,
          embeddings: { ...assignments.embeddings, embeddingDims: parseInt(e.currentTarget.value, 10) || 1536 },
        })}
      />
      <p class="field-hint">{SETUP_WIZARD_COPY.embeddingsDimsHint}</p>
    </div>
  </div>

  <button class="btn-link add-connection-link" type="button" onclick={onAddConnection}>
    {SETUP_WIZARD_COPY.addAnotherConnection}
  </button>

  {#if connectError}
    <p class="field-error" role="alert">{connectError}</p>
  {/if}

  <div class="step-actions">
    <button class="btn btn-secondary" onclick={onBack}>Back</button>
    <button class="btn btn-primary" onclick={onNext}>Continue</button>
  </div>
</div>

<style>
  .step-content {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .step-description {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-6);
    line-height: 1.5;
  }
  .model-card {
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .model-card-header {
    margin-bottom: var(--space-4);
  }
  .model-card-title {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }
  .model-card-help {
    display: block;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.4;
  }
  .field-group {
    margin-bottom: var(--space-4);
  }
  .field-group--compact {
    margin-bottom: 0;
  }
  .field-group label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }
  .field-group input,
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
  .field-hint {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }
  .field-hint--accent {
    color: var(--color-primary-hover);
    font-weight: var(--font-medium);
  }
  .field-error {
    margin: 0 0 var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: var(--radius-md);
    color: #dc2626;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }
  .add-connection-link {
    display: block;
    margin-bottom: var(--space-2);
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: var(--space-2) 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .step-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: auto;
    padding-top: var(--space-5);
    border-top: 1px solid var(--color-border);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 10px 24px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    line-height: 1.4;
    border: 1.5px solid transparent;
    border-radius: var(--radius-full);
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    justify-content: center;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn-primary {
    background: var(--color-primary);
    color: #1a1a1a;
    border-color: transparent;
    box-shadow: 0 1px 3px rgba(255, 157, 0, 0.3), 0 4px 12px rgba(255, 157, 0, 0.2);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border-hover, #adb5bd);
  }
  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }
  .btn-link {
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: var(--space-2) 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
