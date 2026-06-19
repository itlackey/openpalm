<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { fetchSecretFiles, fetchSecretFile, saveSecretFile, deleteSecretFile, type SecretFileInfo } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import IconLock from '$lib/components/icons/IconLock.svelte';

  interface Props { tokenStored: boolean; }
  let { tokenStored }: Props = $props();

  let loading = $state(false);
  let busy = $state(false);
  let error = $state('');
  let files = $state<SecretFileInfo[]>([]);

  // Editor state for the currently-open file.
  let selected = $state<string | null>(null);
  let editorValue = $state('');
  let reveal = $state(false);

  // New-file form.
  let newName = $state('');
  let newNameInput: HTMLInputElement | undefined = $state();

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  async function loadFiles(): Promise<void> {
    loading = true;
    error = '';
    try {
      files = (await fetchSecretFiles()).files;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to list secret files.';
    } finally {
      loading = false;
    }
  }

  async function open(name: string): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const res = await fetchSecretFile(name);
      selected = res.name;
      editorValue = res.value;
      reveal = false;
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to read file.');
    } finally {
      busy = false;
    }
  }

  function closeEditor(): void {
    selected = null;
    editorValue = '';
    reveal = false;
  }

  async function save(): Promise<void> {
    if (!selected || busy) return;
    busy = true;
    try {
      await saveSecretFile(selected, editorValue);
      notifications.push('success', `Saved ${selected}.`);
      await loadFiles();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to save file.');
    } finally {
      busy = false;
    }
  }

  async function remove(name: string): Promise<void> {
    if (busy) return;
    if (!confirm(`Delete secret file "${name}"? This cannot be undone.`)) return;
    busy = true;
    try {
      await deleteSecretFile(name);
      notifications.push('success', `Deleted ${name}.`);
      if (selected === name) closeEditor();
      await loadFiles();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to delete file.');
    } finally {
      busy = false;
    }
  }

  async function createNew(): Promise<void> {
    const name = newName.trim();
    if (!name || busy) return;
    busy = true;
    try {
      await saveSecretFile(name, '');
      notifications.push('success', `Created ${name}.`);
      newName = '';
      await loadFiles();
      await open(name);
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to create file.');
    } finally {
      busy = false;
    }
  }

  onMount(() => { if (tokenStored) void loadFiles(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Secrets</h2>
      <p class="panel-subtitle">Encrypted key files under knowledge/secrets/</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadFiles()} disabled={loading || busy || !tokenStored}>
        {#if loading}<Spinner />{/if}
        Refresh
      </button>
    </div>
  </div>

  {#if error}<div class="error-banner"><span>{error}</span></div>{/if}

  <div class="secrets-layout">
    <!-- File list -->
    <div class="secrets-list">
      {#if files.length === 0 && !loading}
        <p class="empty-note">No secret files found.</p>
      {/if}
      {#each files as f (f.name)}
        <div class="secret-row {selected === f.name ? 'active' : ''}">
          <button class="secret-name" onclick={() => void open(f.name)} disabled={busy} aria-label="Edit {f.name}">
            <span class="mono">{f.name}</span>
            <span class="secret-size">{fmtSize(f.size)}</span>
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => void remove(f.name)} disabled={busy} aria-label="Delete {f.name}">✕</button>
        </div>
      {/each}

      <div class="new-secret">
        <label class="new-secret-label" for="new-secret-name">New secret file</label>
        <div class="new-secret-row">
          <input id="new-secret-name" class="control-input" type="text" spellcheck="false" placeholder="new-file-name" bind:value={newName} bind:this={newNameInput} disabled={busy} />
          <button class="btn btn-secondary btn-sm" onclick={() => void createNew()} disabled={busy || !newName.trim()}>Add</button>
        </div>
      </div>
    </div>

    <!-- Editor -->
    <div class="secrets-editor">
      {#if selected}
        <div class="editor-head">
          <span class="mono">{selected}</span>
          <label class="reveal-toggle"><input type="checkbox" bind:checked={reveal} /> Reveal</label>
        </div>
        <textarea
          class="control-input editor-area {reveal ? '' : 'masked'}"
          spellcheck="false"
          rows="16"
          bind:value={editorValue}
          disabled={busy}></textarea>
        <div class="editor-actions">
          <button class="btn btn-secondary btn-sm" onclick={closeEditor} disabled={busy}>Close</button>
          <button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={busy}>
            {#if busy}<Spinner />{/if}
            Save
          </button>
        </div>
      {:else}
        <div class="editor-empty">
          <IconLock size={24} />
          <p>Select a file to view or edit its contents.</p>
          <button class="btn btn-secondary btn-sm" onclick={() => newNameInput?.focus()}>New secret</button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .error-banner { color: var(--s-seal); padding: var(--s-sp-2) var(--s-sp-3); border: var(--s-hair) solid var(--s-seal); border-radius: 2px; margin-bottom: var(--s-sp-4); }
  .empty-note { font-size: var(--s-type-deed); color: var(--s-ink-2); font-family: var(--s-font-display); }
  .mono { font-family: var(--s-font-mono); font-size: var(--s-type-mark); }

  .secrets-layout { display: grid; grid-template-columns: minmax(16rem, 22rem) 1fr; gap: var(--s-sp-4); align-items: start; }
  @media (max-width: 720px) { .secrets-layout { grid-template-columns: 1fr; } }

  .secrets-list { display: flex; flex-direction: column; gap: var(--s-sp-1); }
  .secret-row { display: flex; align-items: center; gap: var(--s-sp-1); }
  .secret-row.active .secret-name { border-color: var(--s-ink-2); }
  .secret-name {
    flex: 1; display: flex; align-items: center; justify-content: space-between; gap: var(--s-sp-2);
    text-align: left; padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line); border-radius: 2px;
    background: none; color: var(--s-ink); cursor: pointer;
    font-family: var(--s-font-mono); font-size: var(--s-type-mark);
    transition: border-color var(--s-t-quick) var(--s-ease);
  }
  .secret-name:hover { border-color: var(--s-ink-2); }
  .secret-size { font-size: var(--s-type-mark-sm); color: var(--s-ink-3); flex-shrink: 0; font-family: var(--s-font-mono); letter-spacing: var(--s-track-label); text-transform: uppercase; }
  .new-secret { display: flex; flex-direction: column; gap: var(--s-sp-1); margin-top: var(--s-sp-3); }
  .new-secret-label { font-family: var(--s-font-mono); font-size: var(--s-type-mark); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .new-secret-row { display: flex; gap: var(--s-sp-2); flex-wrap: wrap; }

  .secrets-editor { min-width: 0; }
  .editor-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s-sp-2); }
  .reveal-toggle { display: flex; align-items: center; gap: var(--s-sp-1); font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); letter-spacing: var(--s-track-label); text-transform: uppercase; color: var(--s-ink-3); }
  .reveal-toggle input[type='checkbox'] {
    appearance: none;
    width: 0.9rem; height: 0.9rem;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
  }
  .reveal-toggle input[type='checkbox']:checked {
    background: var(--s-seal);
    border-color: var(--s-seal);
  }
  .reveal-toggle input[type='checkbox']:checked::after {
    content: '';
    position: absolute; left: 1px; top: 0px;
    width: 6px; height: 4px;
    border: 1.2px solid white; border-top: 0; border-right: 0;
    transform: rotate(-45deg);
  }
  .editor-area { width: 100%; font-family: var(--s-font-mono); font-size: var(--s-type-mark-sm); resize: vertical; background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper)); border: var(--s-hair) solid var(--s-line-soft); color: var(--s-ink-2); border-radius: 2px; padding: var(--s-sp-3); }
  .editor-area.masked { -webkit-text-security: disc; }
  .editor-actions { display: flex; justify-content: flex-end; gap: var(--s-sp-2); margin-top: var(--s-sp-2); }
  .editor-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: var(--s-sp-3); padding: var(--s-sp-8) var(--s-sp-4);
    color: var(--s-ink-3); text-align: center;
    border: var(--s-hair) solid var(--s-line-soft); border-radius: 2px;
    min-height: 12rem;
  }
  .editor-empty :global(.s-icon) { opacity: 0.4; }
  .editor-empty p { font-size: var(--s-type-deed); margin: 0; max-width: 24rem; font-family: var(--s-font-display); color: var(--s-ink-2); }
</style>
