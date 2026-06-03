<script lang="ts">
  import type { AutomationsResponse } from '$lib/types.js';
  import { fetchTaskFile, saveTaskFile, deleteTaskFile } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';

  interface Props {
    data: AutomationsResponse | null;
    loading: boolean;
    error: string;
    tokenStored: boolean;
    onRefresh: () => void;
  }

  let { data, loading, error, tokenStored, onRefresh }: Props = $props();

  let hasAutomations = $derived(
    data !== null && Array.isArray(data.automations) && data.automations.length > 0
  );

  // ── Task-file editor (edits the raw .yml/.md in /stash/tasks) ─────────────
  let editingFile = $state<string | null>(null);
  let editorContent = $state('');
  let busy = $state(false);

  async function openEditor(fileName: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      editingFile = fileName;
      editorContent = (await fetchTaskFile(fileName)).content;
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to read task file.');
      editingFile = null;
    } finally {
      busy = false;
    }
  }

  function startNewTask(): void {
    const name = (prompt('New task file name (.yml):', 'my-task.yml') ?? '').trim();
    if (!name) return;
    editingFile = name;
    editorContent = "schedule: '0 9 * * *'\nenabled: false\ndescription: \ncommand:\n  - sh\n  - -c\n  - echo hello\n";
  }

  function closeEditor(): void {
    editingFile = null;
    editorContent = '';
  }

  async function saveEditor(): Promise<void> {
    if (!editingFile || busy) return;
    busy = true;
    try {
      await saveTaskFile(editingFile, editorContent);
      notifications.push('success', `Saved ${editingFile}. Refreshing…`);
      closeEditor();
      onRefresh();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to save task file.');
    } finally {
      busy = false;
    }
  }

  async function removeTask(fileName: string): Promise<void> {
    if (busy || !confirm(`Delete task file "${fileName}"?`)) return;
    busy = true;
    try {
      await deleteTaskFile(fileName);
      notifications.push('success', `Deleted ${fileName}.`);
      if (editingFile === fileName) closeEditor();
      onRefresh();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to delete task file.');
    } finally {
      busy = false;
    }
  }

  /** Reverse map: cron expression -> friendly label */
  const CRON_TO_LABEL: Record<string, string> = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Every hour',
    '0 0 * * *': 'Daily at midnight',
    '0 8 * * *': 'Daily at 8 AM',
    '0 0 * * 0': 'Weekly (Sunday midnight)',
    '0 3 * * 0': 'Weekly (Sunday 3 AM)',
    '0 4 * * 0': 'Weekly (Sunday 4 AM)'
  };

  function formatSchedule(cron: string): { label: string; cron: string } | null {
    const friendly = CRON_TO_LABEL[cron];
    if (friendly) return { label: friendly, cron };
    return null;
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Automations</h2>
      <p class="panel-subtitle">Scheduled tasks read from <code>~/.openpalm/knowledge/tasks/</code>. Add or edit task files there to manage automations — changes take effect on refresh.</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={startNewTask} disabled={busy || !tokenStored}>New task</button>
      <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
        {#if loading}
          <span class="spinner"></span>
        {/if}
        Refresh
      </button>
    </div>
  </div>

  {#if editingFile}
    <div class="task-editor">
      <div class="task-editor-head">
        <span class="task-editor-name">{editingFile}</span>
        <span class="task-editor-hint">Raw akm task file (YAML) — set <code>enabled</code>, <code>schedule</code>, <code>command</code>, etc.</span>
      </div>
      <textarea class="task-editor-area" spellcheck="false" rows="14" bind:value={editorContent} disabled={busy}></textarea>
      <div class="task-editor-actions">
        <button class="btn btn-secondary btn-sm" onclick={closeEditor} disabled={busy}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={() => void saveEditor()} disabled={busy}>
          {#if busy}<span class="spinner"></span>{/if} Save
        </button>
      </div>
    </div>
  {/if}

  <div class="panel-body">
    {#if hasAutomations && data}
      <div class="automation-list">
        {#each data.automations as automation}
          {@const preset = formatSchedule(automation.schedule)}
          <div class="automation-card">
            <div class="automation-row">
              <div class="automation-main">
                <div class="automation-name">
                  {automation.name}
                  <span class="badge" class:badge-enabled={automation.enabled} class:badge-disabled={!automation.enabled}>
                    {automation.enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span class="badge badge-type">{automation.action.type}</span>
                </div>
                {#if automation.description}
                  <div class="automation-desc">{automation.description}</div>
                {/if}
              </div>
              <div class="automation-meta">
                {#if preset?.cron}
                  <span class="meta-item schedule-friendly">{preset.label}</span>
                {:else}
                  <span class="meta-item"><code>{automation.schedule}</code></span>
                  <span class="meta-item meta-tz">{automation.timezone}</span>
                {/if}
              </div>
            </div>
            <div class="automation-footer">
              <span class="automation-file">{automation.fileName}</span>
              <div class="automation-actions">
                <button class="btn btn-ghost btn-sm" onclick={() => void openEditor(automation.fileName)} disabled={busy || !tokenStored}>Edit</button>
                <button class="btn btn-ghost btn-sm" onclick={() => void removeTask(automation.fileName)} disabled={busy || !tokenStored} aria-label="Delete {automation.fileName}">Delete</button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        {#if loading}
          <p>Loading automations...</p>
        {:else if error}
          <p class="text-danger">{error}</p>
          <button class="btn btn-secondary btn-sm" onclick={onRefresh}>Try Again</button>
        {:else}
          <p>No automations configured.</p>
          <p class="empty-state-hint">Drop <code>.md</code> task files into <code>~/.openpalm/knowledge/tasks/</code>, or install via <code>akm</code>.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .automation-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .automation-card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .automation-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .automation-main {
    flex: 1;
    min-width: 0;
  }

  .automation-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    flex-wrap: wrap;
  }

  .automation-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
  }

  .automation-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .meta-item {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .meta-item code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .schedule-friendly {
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .meta-tz {
    color: var(--color-text-tertiary);
  }

  .badge-type {
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
  }

  .automation-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
  }

  .automation-actions { display: flex; gap: var(--space-1); }

  .task-editor {
    border: 1px solid var(--color-border); border-radius: var(--radius-md);
    background: var(--color-bg-secondary); padding: var(--space-4);
    margin-bottom: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2);
  }
  .task-editor-head { display: flex; flex-direction: column; gap: 2px; }
  .task-editor-name { font-family: var(--font-mono); font-size: var(--text-sm); font-weight: var(--font-semibold); }
  .task-editor-hint { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .task-editor-area {
    width: 100%; font-family: var(--font-mono); font-size: var(--text-sm); line-height: 1.5;
    border: 1px solid var(--color-border); border-radius: var(--radius-sm);
    background: var(--color-bg); color: var(--color-text); padding: var(--space-3); resize: vertical;
  }
  .task-editor-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }

  .automation-file {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
  }

  .empty-state-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin-top: calc(-1 * var(--space-2));
  }

  .empty-state .btn {
    margin-top: var(--space-2);
  }

  .empty-state code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .text-danger {
    color: var(--color-danger);
  }

  @media (max-width: 768px) {
    .automation-row {
      flex-direction: column;
    }

    .automation-meta {
      align-items: flex-start;
      flex-direction: row;
      gap: var(--space-3);
    }
  }

</style>
