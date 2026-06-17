<script lang="ts">
  import type { AutomationsResponse } from '$lib/types.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import TaskDrawer from './TaskDrawer.svelte';
  import { fetchTaskFile, saveTaskFile, deleteTaskFile, runAutomation, fetchAutomationLog } from '$lib/api.js';
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
  let runningTaskName = $state('');

  let logDrawerOpen = $state(false);
  let logTaskName = $state('');
  let logLines = $state<string[]>([]);
  let logLoading = $state(false);
  let logError = $state('');
  const LOG_LINE_LIMIT = 200;

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

  async function handleRunNow(name: string): Promise<void> {
    if (runningTaskName || drawerSaving || !tokenStored) return;
    runningTaskName = name;
    try {
      const result = await runAutomation(name);
      if (result.ok) {
        notifications.push('success', `"${name}" completed. Open the log to view output.`);
      } else {
        const detail = result.error ? `: ${result.error}` : '';
        notifications.push('error', `"${name}" failed${detail}`);
      }
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to start the routine.');
    } finally {
      runningTaskName = '';
    }
  }

  async function loadLog(name: string): Promise<void> {
    logLoading = true;
    logError = '';
    logTaskName = name;
    try {
      const result = await fetchAutomationLog(name, LOG_LINE_LIMIT);
      logLines = result.lines;
    } catch (e) {
      logLines = [];
      logError = e instanceof Error ? e.message : 'Failed to load the latest routine log.';
    } finally {
      logLoading = false;
    }
  }

  async function openLogDrawer(name: string): Promise<void> {
    logDrawerOpen = true;
    await loadLog(name);
  }

  function closeLogDrawer(): void {
    logDrawerOpen = false;
    logTaskName = '';
    logLines = [];
    logLoading = false;
    logError = '';
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

  function describeAction(automation: NonNullable<AutomationsResponse['automations']>[number]): string {
    switch (automation.action.type) {
      case 'assistant':
        return automation.action.content?.trim() ? 'Assistant prompt' : 'Assistant task';
      case 'shell':
        return automation.action.content?.trim() ? automation.action.content.trim() : 'Shell command';
      case 'api':
        return automation.action.path
          ? `${automation.action.method ?? 'Call'} ${automation.action.path}`
          : 'API request';
      case 'http':
        return automation.action.url ? `${automation.action.method ?? 'Request'} ${automation.action.url}` : 'HTTP request';
      case 'workflow':
        return 'Workflow';
      default:
        return automation.action.type;
    }
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Routines</h2>
      <p class="panel-subtitle">Scheduled tasks from <code>~/.openpalm/knowledge/tasks/</code>. Run them now, edit them, or inspect the latest output.</p>
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
                <span class="meta-item meta-item-action">{describeAction(automation)}</span>
              </div>
            </div>
            <div class="automation-footer">
              <span class="automation-file">{automation.fileName}</span>
              <div class="automation-actions">
                <button
                  class="btn btn-secondary btn-sm"
                  onclick={() => void handleRunNow(automation.name)}
                  disabled={!!runningTaskName || drawerSaving || !tokenStored}
                >
                  {#if runningTaskName === automation.name}
                    <Spinner />
                    Running...
                  {:else}
                    Run now
                  {/if}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => void openLogDrawer(automation.name)}
                  disabled={logLoading || !tokenStored}
                >View latest log</button>
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

<Drawer
  open={logDrawerOpen}
  title={logTaskName ? `Latest log — ${logTaskName}` : 'Latest log'}
  onClose={closeLogDrawer}
  width="42rem"
>
  <div class="log-drawer-body">
    <p class="log-drawer-copy">
      Showing the most recent routine output available for <strong>{logTaskName || 'this task'}</strong>.
    </p>

    <div class="log-drawer-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadLog(logTaskName)} disabled={logLoading || !logTaskName}>
        {#if logLoading}
          <Spinner />
        {/if}
        Refresh log
      </button>
      <span class="log-drawer-hint">Up to {LOG_LINE_LIMIT} recent lines</span>
    </div>

    {#if logError}
      <div class="feedback feedback--error" role="alert">
        <span>{logError}</span>
      </div>
    {/if}

    {#if logLoading && logLines.length === 0}
      <div class="loading-state">
        <Spinner />
        <span>Loading the latest output…</span>
      </div>
    {:else if logLines.length > 0}
      <pre class="log-output">{logLines.join('\n')}</pre>
    {:else if !logError}
      <EmptyState>
        {#snippet icon()}
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        {/snippet}
        <p>No recent output yet.</p>
        <p class="empty-state-hint">Run the routine first, then open this drawer to see the output.</p>
      </EmptyState>
    {/if}
  </div>
</Drawer>

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

  .meta-item-action {
    max-width: 28ch;
    text-align: right;
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

  .automation-actions {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

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

  .log-drawer-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .log-drawer-copy {
    max-width: 62ch;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .log-drawer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .log-drawer-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }

  .log-output {
    margin: 0;
    max-height: min(60dvh, 42rem);
    overflow: auto;
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg-secondary);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
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

    .meta-item-action {
      text-align: left;
      max-width: none;
    }

    .automation-footer {
      align-items: flex-start;
      flex-direction: column;
    }

    .automation-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
