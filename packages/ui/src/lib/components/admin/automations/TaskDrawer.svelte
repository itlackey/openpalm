<script lang="ts">
  import { onMount } from 'svelte';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { validateTaskFilename, type TaskFormData } from './task-form.js';

  interface Props {
    open: boolean;
    /** null = new task; non-null = editing existing */
    draft: TaskFormData | null;
    saving: boolean;
    saveError: string;
    onClose: () => void;
    onSave: (fileName: string, content: string, expectedRevision: string | null) => void;
  }

  let { open, draft, saving, saveError, onClose, onSave }: Props = $props();

  let isNew = $derived(draft !== null && draft.fileName === '');
  let newFileName = $state('');
  let rawYaml = $state('');
  let originalRawYaml = '';
  let normalizedOriginalRawYaml = '';

  onMount(() => {
    if (!draft) return;
    originalRawYaml = draft.rawYaml;
    normalizedOriginalRawYaml = originalRawYaml.replace(/\r\n?/g, '\n');
    rawYaml = normalizedOriginalRawYaml;
  });

  let fileNameError = $derived(
    isNew ? validateTaskFilename(newFileName) : null
  );

  let canSave = $derived(
    !saving &&
    (isNew ? fileNameError === null && newFileName.trim() !== '' : true)
  );

  function handleSave(): void {
    if (!canSave || !draft) return;
    const fileName = isNew ? newFileName.trim() : draft.fileName;
    const content = rawYaml === normalizedOriginalRawYaml ? originalRawYaml : rawYaml;
    onSave(fileName, content, draft.revision);
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
            <span class="field-hint">A schedulable AKM task ID followed by exact lowercase <code>.yml</code>. AKM validates task semantics.</span>
          {/if}
        </div>
      {/if}

      <div class="field-group">
        <label class="field-label" for="tf-yaml">Task YAML</label>
        <textarea
          id="tf-yaml"
          class="field-input field-textarea field-mono"
          rows="18"
          spellcheck="false"
          bind:value={rawYaml}
          disabled={saving}
        ></textarea>
        <span class="field-hint">AKM validates this text during reconciliation and manual runs. Untouched saves preserve the original bytes; editing may normalize line endings.</span>
      </div>

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
    border-color: var(--s-seal);
  }

  .field-label {
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-ink-2);
  }

  .field-input {
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    background: var(--s-paper);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    padding: var(--s-sp-2) var(--s-sp-3);
    width: 100%;
  }

  .field-input:focus {
    outline: 2px solid var(--s-seal);
    outline-offset: 1px;
  }

  .field-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .field-textarea {
    resize: vertical;
    line-height: 1.5;
    min-height: 6rem;
  }

  .field-mono {
    font-family: var(--s-font-mono);
  }

  .field-hint {
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
  }

  .field-hint code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
  }

  .field-error {
    font-size: var(--s-type-deed);
    color: var(--s-seal);
  }

  .save-error {
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    background: color-mix(in srgb, var(--s-seal) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--s-seal) 30%, transparent);
    border-radius: 2px;
    padding: var(--s-sp-3);
    margin: 0;
  }

</style>
