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

  function handleEmbeddingModelChange(newModel: string): void {
    const conn = embConnection;
    let embeddingDims = assignments.embeddings.embeddingDims;
    if (conn) {
      const key = `${conn.provider}/${newModel}`;
      if (EMBEDDING_DIMS[key]) {
        embeddingDims = EMBEDDING_DIMS[key];
      }
    }
    onAssignmentsChange({
      ...assignments,
      embeddings: { ...assignments.embeddings, model: newModel, embeddingDims },
    });
  }

  function applyEmbeddingsSameAsLlm(): void {
    onAssignmentsChange({
      ...assignments,
      embeddings: {
        ...assignments.embeddings,
        connectionId: assignments.llm.connectionId,
        sameAsLlm: true,
      },
    });
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
        onAssignmentsChange({ ...assignments, llm: { ...assignments.llm, connectionId: e.currentTarget.value } });
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
        options={[]}
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

    <button class="btn-link same-as-llm-btn" type="button" onclick={applyEmbeddingsSameAsLlm}>
      {SETUP_WIZARD_COPY.embeddingsSameAsLlm}
    </button>

    <div class="field-group">
      <label for="emb-connection">{SETUP_WIZARD_COPY.embeddingConnectionLabel}</label>
      <select id="emb-connection" value={assignments.embeddings.connectionId} onchange={(e) => {
        onAssignmentsChange({ ...assignments, embeddings: { ...assignments.embeddings, connectionId: e.currentTarget.value, sameAsLlm: false } });
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
        options={embModelList}
        placeholder="text-embedding-3-small"
        onChange={handleEmbeddingModelChange}
      />
      <p class="field-hint">Used for memory vector embeddings. Changing this later requires a collection reset.</p>
    </div>

    <details class="advanced-toggle">
      <summary class="advanced-toggle-summary">{SETUP_WIZARD_COPY.embeddingsAdvancedToggle}</summary>
      <div class="field-group" style="margin-top: var(--space-3);">
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
    </details>
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
  .same-as-llm-btn {
    display: inline-block;
    margin-bottom: var(--space-3);
    background: none;
    border: none;
    color: var(--color-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .same-as-llm-btn:hover {
    color: var(--color-primary-hover);
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
  .advanced-toggle {
    margin-bottom: var(--space-2);
  }
  .advanced-toggle-summary {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
    padding: var(--space-1) 0;
  }
  .advanced-toggle-summary:hover {
    color: var(--color-text);
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
