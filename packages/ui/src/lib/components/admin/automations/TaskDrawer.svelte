<script lang="ts">
  import Drawer from '$lib/components/common/Drawer.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    SCHEDULE_PRESETS,
    DOW_LABELS,
    buildCron,
    cronToPresetId,
    cronToHour,
    cronToDow,
    cronToDom,
    describeCron,
    validateCron,
    validateTaskFilename,
    formDataToYaml,
    type TaskFormData,
    type SchedulePresetId,
  } from './task-form.js';

  interface Props {
    open: boolean;
    /** null = new task; non-null = editing existing */
    draft: TaskFormData | null;
    saving: boolean;
    saveError: string;
    onClose: () => void;
    onSave: (fileName: string, yaml: string) => void;
  }

  let { open, draft, saving, saveError, onClose, onSave }: Props = $props();

  // ── Local form state ──────────────────────────────────────────────────

  let isNew = $derived(draft !== null && draft.fileName === '');

  // File name for new tasks only; for edits, the fileName is fixed.
  let newFileName = $state('');

  let description = $state('');
  let enabled = $state(false);
  let actionKind = $state<'command' | 'prompt' | 'workflow'>('command');
  let commandShell = $state('echo hello');
  let promptBody = $state('');
  let workflowRef = $state('');

  // Schedule state
  let presetId = $state<SchedulePresetId>('daily');
  let hour = $state(9);
  let dow = $state(1);
  let dom = $state(1);
  let rawCron = $state('0 9 * * *');
  let advancedOpen = $state(false);

  // Validation
  let fileNameError = $derived(
    isNew ? validateTaskFilename(newFileName) : null
  );
  let cronError = $derived(
    presetId === 'advanced' ? validateCron(rawCron) : null
  );

  let resolvedCron = $derived(buildCron(presetId, hour, dow, dom, rawCron));
  let cronSummary = $derived(describeCron(presetId, hour, dow, dom, rawCron));

  let canSave = $derived(
    !saving &&
    (isNew ? fileNameError === null && newFileName.trim() !== '' : true) &&
    cronError === null
  );

  // ── Sync form state when draft changes ────────────────────────────────

  // Use $effect for one-time init when drawer opens (not reactive sync —
  // we want to init once per open, not stomp user edits on each render).
  let prevDraft = $state<TaskFormData | null>(null);
  $effect(() => {
    if (draft === prevDraft) return;
    prevDraft = draft;
    if (!draft) return;

    newFileName = '';
    description = draft.description;
    enabled = draft.enabled;
    actionKind = draft.actionKind;
    commandShell = draft.commandShell;
    promptBody = draft.promptBody;
    workflowRef = draft.workflowRef;

    const pid = cronToPresetId(draft.schedule);
    presetId = pid;
    hour = cronToHour(draft.schedule);
    dow = cronToDow(draft.schedule);
    dom = cronToDom(draft.schedule);
    rawCron = draft.schedule;
    advancedOpen = pid === 'advanced';
  });

  // ── Save ──────────────────────────────────────────────────────────────

  function handleSave(): void {
    if (!canSave || !draft) return;

    const fileName = isNew ? newFileName.trim() : draft.fileName;
    const updated: TaskFormData = {
      ...draft,
      fileName,
      description,
      enabled,
      actionKind,
      commandShell,
      promptBody,
      workflowRef,
      schedule: resolvedCron,
    };
    onSave(fileName, formDataToYaml(updated));
  }

  // ── Preset change handler ─────────────────────────────────────────────

  function onPresetChange(e: Event): void {
    const val = (e.currentTarget as HTMLSelectElement).value as SchedulePresetId;
    presetId = val;
    advancedOpen = val === 'advanced';
  }
</script>

<Drawer
  {open}
  title={isNew ? 'New automation' : `Edit — ${draft?.fileName ?? ''}`}
  onClose={onClose}
  width="36rem"
>
  {#if draft !== null}
    <form class="task-form" onsubmit={(e) => { e.preventDefault(); handleSave(); }}>

      <!-- File name (new tasks only) -->
      {#if isNew}
        <div class="field-group" class:field-group--error={fileNameError !== null && newFileName.length > 0}>
          <label class="field-label" for="tf-filename">File name</label>
          <input
            id="tf-filename"
            class="field-input"
            type="text"
            placeholder="my-task.yml"
            autocomplete="off"
            spellcheck="false"
            bind:value={newFileName}
            disabled={saving}
          />
          {#if fileNameError && newFileName.length > 0}
            <span class="field-error" role="alert">{fileNameError}</span>
          {:else}
            <span class="field-hint">Lowercase letters, digits, hyphens. Must end in .yml, .yaml, or .md</span>
          {/if}
        </div>
      {/if}

      <!-- Description -->
      <div class="field-group">
        <label class="field-label" for="tf-desc">Description</label>
        <input
          id="tf-desc"
          class="field-input"
          type="text"
          placeholder="What does this task do?"
          bind:value={description}
          disabled={saving}
        />
      </div>

      <!-- Enabled -->
      <label class="toggle-row">
        <input type="checkbox" bind:checked={enabled} disabled={saving} />
        <span class="toggle-label">Enabled</span>
        <span class="toggle-hint">Disabled tasks are saved but not registered with cron</span>
      </label>

      <!-- Schedule builder -->
      <fieldset class="schedule-fieldset" disabled={saving}>
        <legend class="field-label">Schedule</legend>

        <div class="schedule-row">
          <select class="field-select" value={presetId} onchange={onPresetChange}>
            {#each SCHEDULE_PRESETS as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
          </select>

          {#if presetId === 'daily' || presetId === 'weekly' || presetId === 'monthly'}
            <div class="schedule-params">
              {#if presetId === 'weekly'}
                <label class="param-label" for="tf-dow">Day</label>
                <select id="tf-dow" class="field-select field-select--narrow" bind:value={dow}>
                  {#each DOW_LABELS as label, i (i)}
                    <option value={i}>{label}</option>
                  {/each}
                </select>
              {/if}

              {#if presetId === 'monthly'}
                <label class="param-label" for="tf-dom">Day of month</label>
                <input
                  id="tf-dom"
                  class="field-input field-input--narrow"
                  type="number"
                  min="1"
                  max="31"
                  bind:value={dom}
                />
              {/if}

              <label class="param-label" for="tf-hour">Hour (0–23)</label>
              <input
                id="tf-hour"
                class="field-input field-input--narrow"
                type="number"
                min="0"
                max="23"
                bind:value={hour}
              />
            </div>
          {/if}
        </div>

        <!-- Summary line -->
        <p class="schedule-summary" class:schedule-summary--error={cronError !== null}>
          {cronSummary}
        </p>

        <!-- Advanced disclosure -->
        <details bind:open={advancedOpen} class="advanced-details">
          <summary class="advanced-summary">Advanced (raw cron)</summary>
          <div class="advanced-body">
            <label class="field-label" for="tf-rawcron">Cron expression</label>
            <input
              id="tf-rawcron"
              class="field-input field-mono"
              class:field-input--error={cronError !== null}
              type="text"
              placeholder="* * * * *"
              spellcheck="false"
              bind:value={rawCron}
              oninput={() => { presetId = 'advanced'; advancedOpen = true; }}
              disabled={saving}
            />
            {#if cronError}
              <span class="field-error" role="alert">{cronError}</span>
            {:else}
              <span class="field-hint">5 fields: minute hour day-of-month month day-of-week</span>
            {/if}
          </div>
        </details>
      </fieldset>

      <!-- Command -->
      <fieldset class="field-group" disabled={saving}>
        <legend class="field-label">Action type</legend>
        <div class="radio-row">
          <label class="radio-label">
            <input type="radio" name="tf-kind" value="command" bind:group={actionKind} />
            Shell command
          </label>
          <label class="radio-label">
            <input type="radio" name="tf-kind" value="prompt" bind:group={actionKind} />
            Assistant prompt
          </label>
          <label class="radio-label">
            <input type="radio" name="tf-kind" value="workflow" bind:group={actionKind} />
            Workflow
          </label>
        </div>

        {#if actionKind === 'command'}
          <div class="field-group" style="margin-top: var(--space-3)">
            <label class="field-label" for="tf-cmd">Shell command</label>
            <input
              id="tf-cmd"
              class="field-input field-mono"
              type="text"
              placeholder="echo hello"
              spellcheck="false"
              bind:value={commandShell}
            />
            <span class="field-hint">Runs as: <code>sh -c "&lt;command&gt;"</code></span>
          </div>
        {:else if actionKind === 'prompt'}
          <div class="field-group" style="margin-top: var(--space-3)">
            <label class="field-label" for="tf-prompt">Prompt text</label>
            <textarea
              id="tf-prompt"
              class="field-input field-textarea"
              rows="4"
              placeholder="Summarise the latest logs and notify me if there are errors."
              bind:value={promptBody}
            ></textarea>
          </div>
        {:else}
          <div class="field-group" style="margin-top: var(--space-3)">
            <label class="field-label" for="tf-workflow">Workflow ref</label>
            <input
              id="tf-workflow"
              class="field-input field-mono"
              type="text"
              placeholder="workflow:my-workflow"
              spellcheck="false"
              bind:value={workflowRef}
            />
          </div>
        {/if}
      </fieldset>

      <!-- Unknown-key notice -->
      {#if Object.keys(draft.unknownKeys).length > 0}
        <p class="unknown-keys-notice">
          This task file contains additional fields
          (<code>{Object.keys(draft.unknownKeys).join(', ')}</code>)
          that are not editable here but will be preserved when saved.
        </p>
      {/if}

      <!-- Save error -->
      {#if saveError}
        <p class="save-error" role="alert">{saveError}</p>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    <button class="btn btn-secondary" onclick={onClose} disabled={saving}>Cancel</button>
    <button class="btn btn-primary" onclick={handleSave} disabled={!canSave}>
      {#if saving}<Spinner />{/if}
      {isNew ? 'Create' : 'Save'}
    </button>
  {/snippet}
</Drawer>

<style>
  .task-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    border: none;
    padding: 0;
    margin: 0;
  }

  .field-group--error .field-input {
    border-bottom-color: var(--s-seal);
  }

  .field-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .field-input {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
    width: 100%;
  }

  .field-input:focus {
    outline: none;
    border-bottom-color: var(--s-ink-2);
  }

  .field-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .field-input--narrow {
    width: 6rem;
  }

  .field-input--error {
    border-bottom-color: var(--s-seal);
  }

  .field-select {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
  }

  .field-select--narrow {
    width: auto;
  }

  .field-select:focus {
    outline: none;
    border-bottom-color: var(--s-ink-2);
  }

  .field-textarea {
    resize: vertical;
    line-height: 1.5;
    min-height: 6rem;
    border: var(--s-hair) solid var(--s-line) !important;
    border-radius: 2px !important;
    padding: var(--s-sp-3) !important;
  }

  .field-mono {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }

  .field-hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
  }

  .field-hint code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
  }

  .field-error {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-seal);
    letter-spacing: var(--s-track-label);
  }

  /* Toggle row */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
    cursor: pointer;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }

  .toggle-row input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .toggle-label {
    color: var(--s-ink);
  }

  .toggle-hint {
    color: var(--s-ink-3);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }

  /* Schedule */
  .schedule-fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    padding: var(--s-sp-4);
    margin: 0;
  }

  .schedule-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-sp-3);
  }

  .schedule-params {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .param-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    white-space: nowrap;
  }

  .schedule-summary {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    background: var(--s-paper-deep);
    border-radius: 2px;
    padding: var(--s-sp-2) var(--s-sp-3);
    margin: 0;
  }

  .schedule-summary--error {
    color: var(--s-seal);
  }

  .advanced-details {
    border-top: var(--s-hair) solid var(--s-line-soft);
    padding-top: var(--s-sp-3);
  }

  .advanced-summary {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    cursor: pointer;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .advanced-summary::-webkit-details-marker { display: none; }

  .advanced-summary::before {
    content: '▶';
    font-size: 10px;
    transition: transform var(--s-t-quick) var(--s-ease);
  }

  details[open] .advanced-summary::before {
    transform: rotate(90deg);
  }

  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    margin-top: var(--s-sp-3);
  }

  /* Radio row */
  .radio-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-sp-4);
    padding-top: var(--s-sp-2);
  }

  .radio-label {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    cursor: pointer;
  }

  /* Notices */
  .unknown-keys-notice {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    padding: var(--s-sp-3);
    margin: 0;
  }

  .unknown-keys-notice code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
  }

  .save-error {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
    padding: var(--s-sp-3);
    margin: 0;
  }

  @media (max-width: 400px) {
    .schedule-row {
      flex-direction: column;
      align-items: stretch;
    }

    .schedule-params {
      flex-direction: column;
      align-items: stretch;
    }

    .field-input--narrow,
    .field-select--narrow {
      width: 100%;
    }

    .radio-row {
      flex-direction: column;
    }
  }
</style>
