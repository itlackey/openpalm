<script lang="ts">
  import { SETUP_WIZARD_COPY } from '$lib/setup-wizard/copy.js';
  import ModelSelector from '$lib/components/setup-wizard/ModelSelector.svelte';
  import type { WizardConnectionDraft, WizardAssignments } from '$lib/setup-wizard/state.js';

  interface Props {
    connections: WizardConnectionDraft[];
    assignments: WizardAssignments;
    onAssignmentsChange: (next: WizardAssignments) => void;
    onBack: () => void;
    onNext: () => void;
  }

  let { connections, assignments, onAssignmentsChange, onBack, onNext }: Props = $props();

  function rerankingConnModelList(): string[] {
    const conn = connections.find(c => c.id === assignments.reranking.connectionId);
    return conn?.modelList ?? [];
  }

  function ttsConnModelList(): string[] {
    const conn = connections.find(c => c.id === assignments.tts.connectionId);
    return conn?.modelList ?? [];
  }

  function sttConnModelList(): string[] {
    const conn = connections.find(c => c.id === assignments.stt.connectionId);
    return conn?.modelList ?? [];
  }
</script>

<div class="step-content" data-testid="step-optional-addons">
  <h2>{SETUP_WIZARD_COPY.optionalAddonsTitle}</h2>
  <p class="step-description">{SETUP_WIZARD_COPY.optionalAddonsBody}</p>

  <!-- Reranking -->
  <div class="addon-row" class:addon-row--active={assignments.reranking.enabled}>
    <div class="addon-toggle-row">
      <label class="addon-toggle-label">
        <input
          type="checkbox"
          checked={assignments.reranking.enabled}
          onchange={(e) => onAssignmentsChange({
            ...assignments,
            reranking: { ...assignments.reranking, enabled: e.currentTarget.checked },
          })}
        />
        <span class="addon-label-text">{SETUP_WIZARD_COPY.rerankingToggleLabel}</span>
      </label>
      <span class="addon-help">{SETUP_WIZARD_COPY.rerankingToggleHelp}</span>
    </div>
    {#if assignments.reranking.enabled}
      <div class="addon-fields">
        <div class="field-group">
          <fieldset class="radio-fieldset">
            <legend class="radio-legend">{SETUP_WIZARD_COPY.rerankingTypeLabel}</legend>
            <div class="radio-group">
              <label class="radio-label">
                <input
                  type="radio"
                  name="reranking-type"
                  value="llm"
                  checked={assignments.reranking.mode === 'llm'}
                  onchange={() => onAssignmentsChange({ ...assignments, reranking: { ...assignments.reranking, mode: 'llm' } })}
                />
                {SETUP_WIZARD_COPY.rerankingTypeLlm}
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  name="reranking-type"
                  value="dedicated"
                  checked={assignments.reranking.mode === 'dedicated'}
                  onchange={() => onAssignmentsChange({ ...assignments, reranking: { ...assignments.reranking, mode: 'dedicated' } })}
                />
                {SETUP_WIZARD_COPY.rerankingTypeDedicated}
              </label>
            </div>
          </fieldset>
        </div>
        <div class="field-group">
          <label for="reranking-connection">Connection</label>
          <select id="reranking-connection" value={assignments.reranking.connectionId} onchange={(e) => onAssignmentsChange({ ...assignments, reranking: { ...assignments.reranking, connectionId: e.currentTarget.value } })}>
            <option value="">— select connection —</option>
            {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
          </select>
        </div>
        <div class="field-group">
          <label for="reranking-model">Model</label>
          <ModelSelector
            id="reranking-model"
            value={assignments.reranking.model}
            options={rerankingConnModelList()}
            placeholder="e.g., rerank-2"
            onChange={(v) => onAssignmentsChange({ ...assignments, reranking: { ...assignments.reranking, model: v } })}
          />
        </div>
        <div class="field-group">
          <label for="reranking-topn">Top N results</label>
          <input
            id="reranking-topn"
            type="number"
            value={assignments.reranking.topN}
            min="1"
            step="1"
            oninput={(e) => onAssignmentsChange({ ...assignments, reranking: { ...assignments.reranking, topN: parseInt(e.currentTarget.value, 10) || 5 } })}
          />
        </div>
      </div>
    {/if}
  </div>

  <!-- TTS -->
  <div class="addon-row" class:addon-row--active={assignments.tts.enabled}>
    <div class="addon-toggle-row">
      <label class="addon-toggle-label">
        <input
          type="checkbox"
          checked={assignments.tts.enabled}
          onchange={(e) => onAssignmentsChange({
            ...assignments,
            tts: { ...assignments.tts, enabled: e.currentTarget.checked },
          })}
        />
        <span class="addon-label-text">{SETUP_WIZARD_COPY.ttsToggleLabel}</span>
      </label>
      <span class="addon-help">{SETUP_WIZARD_COPY.ttsToggleHelp}</span>
    </div>
    {#if assignments.tts.enabled}
      <div class="addon-fields">
        <div class="field-group">
          <label for="tts-connection">Connection</label>
          <select id="tts-connection" value={assignments.tts.connectionId} onchange={(e) => onAssignmentsChange({ ...assignments, tts: { ...assignments.tts, connectionId: e.currentTarget.value } })}>
            <option value="">— select connection —</option>
            {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
          </select>
        </div>
        <div class="field-group">
          <label for="tts-model">Model (optional)</label>
          <ModelSelector
            id="tts-model"
            value={assignments.tts.model}
            options={ttsConnModelList()}
            placeholder="e.g., tts-1"
            onChange={(v) => onAssignmentsChange({ ...assignments, tts: { ...assignments.tts, model: v } })}
          />
        </div>
        <div class="field-group">
          <label for="tts-voice">Voice (optional)</label>
          <input id="tts-voice" type="text" value={assignments.tts.voice} placeholder="e.g., alloy" oninput={(e) => onAssignmentsChange({ ...assignments, tts: { ...assignments.tts, voice: e.currentTarget.value } })} />
        </div>
        <div class="field-group">
          <label for="tts-format">Output format (optional)</label>
          <input id="tts-format" type="text" value={assignments.tts.format} placeholder="e.g., mp3" oninput={(e) => onAssignmentsChange({ ...assignments, tts: { ...assignments.tts, format: e.currentTarget.value } })} />
        </div>
      </div>
    {/if}
  </div>

  <!-- STT -->
  <div class="addon-row" class:addon-row--active={assignments.stt.enabled}>
    <div class="addon-toggle-row">
      <label class="addon-toggle-label">
        <input
          type="checkbox"
          checked={assignments.stt.enabled}
          onchange={(e) => onAssignmentsChange({
            ...assignments,
            stt: { ...assignments.stt, enabled: e.currentTarget.checked },
          })}
        />
        <span class="addon-label-text">{SETUP_WIZARD_COPY.sttToggleLabel}</span>
      </label>
      <span class="addon-help">{SETUP_WIZARD_COPY.sttToggleHelp}</span>
    </div>
    {#if assignments.stt.enabled}
      <div class="addon-fields">
        <div class="field-group">
          <label for="stt-connection">Connection</label>
          <select id="stt-connection" value={assignments.stt.connectionId} onchange={(e) => onAssignmentsChange({ ...assignments, stt: { ...assignments.stt, connectionId: e.currentTarget.value } })}>
            <option value="">— select connection —</option>
            {#each connections as conn}<option value={conn.id}>{conn.name || conn.provider}</option>{/each}
          </select>
        </div>
        <div class="field-group">
          <label for="stt-model">Model (optional)</label>
          <ModelSelector
            id="stt-model"
            value={assignments.stt.model}
            options={sttConnModelList()}
            placeholder="e.g., whisper-1"
            onChange={(v) => onAssignmentsChange({ ...assignments, stt: { ...assignments.stt, model: v } })}
          />
        </div>
        <div class="field-group">
          <label for="stt-language">Language (optional)</label>
          <input id="stt-language" type="text" value={assignments.stt.language} placeholder="e.g., en" oninput={(e) => onAssignmentsChange({ ...assignments, stt: { ...assignments.stt, language: e.currentTarget.value } })} />
        </div>
      </div>
    {/if}
  </div>

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
  .addon-row {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
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
    padding: 0 var(--space-4) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }
  .addon-fields :global(.field-group:first-child) {
    margin-top: var(--space-3);
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
  .step-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
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
</style>
