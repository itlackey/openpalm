<script lang="ts">
  import type { AutomationsResponse } from '$lib/types.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import TaskDrawer from './TaskDrawer.svelte';
  import { fetchTaskFile, saveTaskFile, deleteTaskFile } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import {
    yamlToFormData,
    newFormData,
    cronToPresetId,
    type TaskFormData,
  } from './task-form.js';

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

  // ── Drawer state ──────────────────────────────────────────────────────────
  let drawerOpen = $state(false);
  let drawerDraft = $state<TaskFormData | null>(null);
  let drawerSaving = $state(false);
  let drawerError = $state('');

  function openNewTask(): void {
    const form = newFormData();
    drawerDraft = form;
    drawerError = '';
    drawerOpen = true;
  }

  async function openEditTask(fileName: string): Promise<void> {
    if (drawerSaving) return;
    drawerSaving = true;
    drawerError = '';
    try {
      const { content } = await fetchTaskFile(fileName);
      drawerDraft = yamlToFormData(fileName, content);
      drawerOpen = true;
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to read task file.');
    } finally {
      drawerSaving = false;
    }
  }

  function closeDrawer(): void {
    drawerOpen = false;
    drawerDraft = null;
    drawerError = '';
  }

  async function handleSave(fileName: string, yaml: string): Promise<void> {
    drawerSaving = true;
    drawerError = '';
    try {
      await saveTaskFile(fileName, yaml);
      notifications.push('success', `Saved ${fileName}. Refreshing…`);
      closeDrawer();
      onRefresh();
    } catch (e) {
      drawerError = e instanceof Error ? e.message : 'Failed to save task file.';
    } finally {
      drawerSaving = false;
    }
  }

  async function removeTask(fileName: string): Promise<void> {
    if (drawerSaving || !confirm(`Delete task file "${fileName}"?`)) return;
    drawerSaving = true;
    try {
      await deleteTaskFile(fileName);
      notifications.push('success', `Deleted ${fileName}.`);
      onRefresh();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to delete task file.');
    } finally {
      drawerSaving = false;
    }
  }

  /** Map a cron expression to a friendly display string. */
  function formatSchedule(cron: string): string {
    const preset = cronToPresetId(cron);
    switch (preset) {
      case 'every-15-minutes': return 'Every 15 minutes';
      case 'every-hour':       return 'Every hour';
      case 'daily': {
        const h = parseInt(cron.split(' ')[1] ?? '0', 10);
        return `Daily at ${String(h).padStart(2, '0')}:00`;
      }
      case 'weekly': {
        const parts = cron.split(' ');
        const h = parseInt(parts[1] ?? '0', 10);
        const d = parseInt(parts[4] ?? '0', 10);
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        return `Weekly (${days[d] ?? 'Sun'}) at ${String(h).padStart(2, '0')}:00`;
      }
      case 'monthly': {
        const parts = cron.split(' ');
        const h = parseInt(parts[1] ?? '0', 10);
        const dom = parseInt(parts[2] ?? '1', 10);
        return `Monthly (day ${dom}) at ${String(h).padStart(2, '0')}:00`;
      }
      default: return cron;
    }
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Automations</h2>
      <p class="panel-subtitle">Scheduled tasks from <code>~/.openpalm/knowledge/tasks/</code>.</p>
    </div>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={openNewTask} disabled={drawerSaving || !tokenStored}>New task</button>
      <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
        {#if loading}
          <Spinner />
        {/if}
        Refresh
      </button>
    </div>
  </div>

  <div class="panel-body">
    {#if hasAutomations && data}
      <div class="automation-list">
        {#each data.automations as automation}
          <div class="automation-card">
            <div class="automation-row">
              <div class="automation-main">
                <div class="automation-name">
                  {automation.name}
                  <span class="badge" class:badge-enabled={automation.enabled} class:badge-disabled={!automation.enabled}>
                    {automation.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span class="badge badge-type">{automation.action.type}</span>
                </div>
                {#if automation.description}
                  <div class="automation-desc">{automation.description}</div>
                {/if}
              </div>
              <div class="automation-meta">
                <span class="meta-item">{formatSchedule(automation.schedule)}</span>
              </div>
            </div>
            <div class="automation-footer">
              <span class="automation-file">{automation.fileName}</span>
              <div class="automation-actions">
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => void openEditTask(automation.fileName)}
                  disabled={drawerSaving || !tokenStored}
                >Edit</button>
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => void removeTask(automation.fileName)}
                  disabled={drawerSaving || !tokenStored}
                  aria-label="Delete {automation.fileName}"
                >Delete</button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <EmptyState>
        {#snippet icon()}
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        {/snippet}
        {#if loading}
          <p>Loading automations...</p>
        {:else if error}
          <p class="text-danger">{error}</p>
          <button class="btn btn-secondary btn-sm empty-state-btn" onclick={onRefresh}>Try Again</button>
        {:else}
          <p>No automations configured.</p>
          <button class="btn btn-secondary btn-sm empty-state-btn" onclick={openNewTask} disabled={!tokenStored}>Create your first task</button>
          <p class="empty-state-hint">Or drop <code>.md</code>/<code>.yml</code> files into <code>~/.openpalm/knowledge/tasks/</code>.</p>
        {/if}
      </EmptyState>
    {/if}
  </div>
</div>

<TaskDrawer
  open={drawerOpen}
  draft={drawerDraft}
  saving={drawerSaving}
  saveError={drawerError}
  onClose={closeDrawer}
  onSave={(fileName, yaml) => void handleSave(fileName, yaml)}
/>

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
    font-weight: var(--font-medium);
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

  .empty-state-btn {
    margin-top: var(--space-2);
  }

  .empty-state-hint code {
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
