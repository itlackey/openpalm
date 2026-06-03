<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchSecretFiles, fetchSecretFile, saveSecretFile, deleteSecretFile, type SecretFileInfo } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';

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
    <h2>Secrets</h2>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadFiles()} disabled={loading || busy || !tokenStored}>
        {#if loading}<span class="spinner"></span>{/if}
        Refresh
      </button>
    </div>
  </div>

  <p class="section-note">
    Files in the assistant's secrets directory (<code>/stash/secrets</code> →
    <code>knowledge/secrets</code>). These are mounted into the assistant and granted to
    services via Docker secrets. Files are stored 0600. Editing here changes the live
    file — restart affected services to pick up changes.
  </p>

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
        <input class="control-input" type="text" spellcheck="false" placeholder="new-file-name" bind:value={newName} disabled={busy} />
        <button class="btn btn-secondary btn-sm" onclick={() => void createNew()} disabled={busy || !newName.trim()}>Add</button>
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
            {#if busy}<span class="spinner"></span>{/if}
            Save
          </button>
        </div>
      {:else}
        <p class="empty-note">Select a file to view or edit its contents.</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); }
  .section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0 0 var(--space-4); }
  .error-banner { background: var(--color-danger-subtle, rgba(239,68,68,0.1)); color: var(--color-danger, #ef4444); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); margin-bottom: var(--space-4); }
  .empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); }
  .mono { font-family: var(--font-mono); font-size: var(--text-sm); }

  .secrets-layout { display: grid; grid-template-columns: minmax(16rem, 22rem) 1fr; gap: var(--space-4); align-items: start; }
  @media (max-width: 720px) { .secrets-layout { grid-template-columns: 1fr; } }

  .secrets-list { display: flex; flex-direction: column; gap: var(--space-1); }
  .secret-row { display: flex; align-items: center; gap: var(--space-1); }
  .secret-row.active .secret-name { border-color: var(--color-primary, #6366f1); }
  .secret-name {
    flex: 1; display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
    text-align: left; padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border); border-radius: var(--radius-sm);
    background: var(--color-bg-secondary); color: var(--color-text); cursor: pointer;
  }
  .secret-name:hover { background: var(--color-bg-tertiary, var(--color-bg-secondary)); }
  .secret-size { font-size: var(--text-xs); color: var(--color-text-secondary); flex-shrink: 0; }
  .new-secret { display: flex; gap: var(--space-2); margin-top: var(--space-3); }

  .secrets-editor { min-width: 0; }
  .editor-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-2); }
  .reveal-toggle { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); color: var(--color-text-secondary); }
  .editor-area { width: 100%; font-family: var(--font-mono); font-size: var(--text-sm); resize: vertical; }
  .editor-area.masked { -webkit-text-security: disc; }
  .editor-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
</style>
