<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSecretFiles, saveSecretFile } from '$lib/api.js';
  import IconAdd from '$lib/components/icons/IconAdd.svelte';

  // Reusable secret picker: choose an EXISTING secret by name, or quick-add a
  // new one that is written through the shared /admin/secrets store and becomes
  // immediately selectable. Never displays secret values. Uses a native <select>
  // so keyboard/focus/target-size come for free (rubric F3/F5).
  interface Props {
    /** Selected secret NAME (bindable). */
    value?: string;
    /** Stable id for the <select>, for an external <label for>. */
    id?: string;
    /** Called whenever the selection changes (including after quick-add). */
    onChange?: (name: string) => void;
  }
  let { value = $bindable(''), id = 'secret-select', onChange }: Props = $props();

  let names = $state<string[]>([]);
  let loading = $state(true);
  let adding = $state(false);
  let newName = $state('');
  let newValue = $state('');
  let saving = $state(false);
  let error = $state('');
  let nameInput = $state<HTMLInputElement | undefined>();

  async function loadNames(): Promise<void> {
    loading = true;
    try {
      const { files } = await fetchSecretFiles();
      names = files.map((f) => f.name).sort((a, b) => a.localeCompare(b));
    } catch {
      names = [];
    } finally {
      loading = false;
    }
  }
  onMount(loadNames);

  function onSelectChange(e: Event): void {
    value = (e.currentTarget as HTMLSelectElement).value;
    onChange?.(value);
  }

  function openAdd(): void {
    adding = true;
    error = '';
    newName = '';
    newValue = '';
    queueMicrotask(() => nameInput?.focus());
  }
  function cancelAdd(): void {
    adding = false;
    error = '';
  }

  async function saveAdd(): Promise<void> {
    const name = newName.trim();
    if (!name) { error = 'Name is required.'; return; }
    if (!newValue) { error = 'Value is required.'; return; }
    if (saving) return;
    saving = true;
    error = '';
    try {
      await saveSecretFile(name, newValue);
      await loadNames();
      value = name;
      onChange?.(name);
      adding = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save secret.';
    } finally {
      saving = false;
    }
  }

  function onAddKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); }
  }
</script>

<div class="secret-select">
  <div class="ss-row">
    <select {id} class="form-input ss-select" {value} onchange={onSelectChange} disabled={loading || adding}>
      <option value="">{loading ? 'Loading secrets…' : 'Select a secret…'}</option>
      {#each names as name (name)}
        <option value={name}>{name}</option>
      {/each}
    </select>
    <button type="button" class="btn btn-secondary ss-add-btn" onclick={openAdd} disabled={adding}>
      <IconAdd size={15} />
      <span class="ss-add-label">New</span>
    </button>
  </div>

  {#if adding}
    <div class="ss-add-form" role="group" aria-label="Add a new secret">
      <label class="ss-field">
        <span class="ss-field-label">Secret name</span>
        <input
          bind:this={nameInput}
          bind:value={newName}
          class="form-input"
          placeholder="e.g. discord_bot_token"
          autocomplete="off"
          spellcheck="false"
          onkeydown={onAddKeydown}
        />
      </label>
      <label class="ss-field">
        <span class="ss-field-label">Value</span>
        <input
          bind:value={newValue}
          class="form-input"
          type="password"
          placeholder="Paste the secret value"
          autocomplete="new-password"
          onkeydown={onAddKeydown}
        />
      </label>
      {#if error}<p class="ss-error" role="alert">{error}</p>{/if}
      <div class="ss-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick={saveAdd} disabled={saving}>
          {saving ? 'Saving…' : 'Save & select'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick={cancelAdd} disabled={saving}>Cancel</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .secret-select {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }
  .ss-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }
  .ss-select {
    flex: 1 1 auto;
    min-width: 0;
    height: 38px;
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    color: var(--s-ink);
    background: var(--s-paper);
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0 var(--s-sp-1);
  }
  .ss-select:focus {
    outline: none;
    border-bottom-color: var(--s-ink-2);
  }
  .ss-add-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
    flex-shrink: 0;
    height: 38px;
  }
  .ss-add-btn :global(svg) {
    flex-shrink: 0;
  }
  .ss-add-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    background: var(--s-paper-deep);
  }
  .ss-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }
  .ss-field-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .ss-error {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-seal);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }
  .ss-actions {
    display: flex;
    gap: var(--s-sp-2);
  }
  @media (max-width: 480px) {
    .ss-add-label {
      display: none;
    }
    .ss-add-btn {
      width: 38px;
      justify-content: center;
    }
  }
</style>
