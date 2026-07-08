<script lang="ts">
  import type { AutomationsResponse } from '$lib/types.js';
  import Spinner from '@openpalm/ui-kit/components/common/Spinner.svelte';
  import EmptyState from '@openpalm/ui-kit/components/common/EmptyState.svelte';
  import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';
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
    onRefresh: () => void;
  }

  let { data, loading, error, onRefresh }: Props = $props();

  let hasAutomations = $derived(
    data !== null && Array.isArray(data.automations) && data.automations.length > 0
  );

  // ── Drawer state ──────────────────────────────────────────────────────────
  let drawerOpen = $state(false);
  let drawerDraft = $state<TaskFormData | null>(null);
  let drawerSaving = $state(false);
  let drawerError = $state('');
  let runningTaskName = $state('');

  // Delete-confirmation prompt (in-DOM, mirrors RecoveryTab's prune prompt —
  // testable and consistent with the app's own dialog components, unlike the
  // untestable native confirm()).
  let pendingDeleteFile = $state<string | null>(null);

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

  function requestRemoveTask(fileName: string): void {
    if (drawerSaving) return;
    pendingDeleteFile = fileName;
  }

  function cancelRemoveTask(): void {
    pendingDeleteFile = null;
  }

  async function confirmRemoveTask(): Promise<void> {
    const fileName = pendingDeleteFile;
    if (fileName === null || drawerSaving) return;
    drawerSaving = true;
    try {
      await deleteTaskFile(fileName);
      notifications.push('success', `Deleted ${fileName}.`);
      pendingDeleteFile = null;
      onRefresh();
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to delete task file.');
    } finally {
      drawerSaving = false;
    }
  }

  async function handleRunNow(name: string): Promise<void> {
    if (runningTaskName || drawerSaving) return;
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
  <div class="ph">
    <div>
      <h2 class="ph-title">Routines</h2>
      <p class="ph-sub">Scheduled tasks from knowledge/tasks/</p>
    </div>
    <div class="ph-actions">
      <button class="btn btn-primary btn-outline btn-sm" onclick={openNewTask} disabled={drawerSaving}>New task</button>
      <button class="btn btn-primary btn-outline btn-sm" onclick={onRefresh} disabled={loading}>
        {#if loading}
          <Spinner />
        {/if}
        Refresh
      </button>
    </div>
  </div>

  <div class="panel-body">
    {#if pendingDeleteFile !== null}
      <div class="confirm-prompt" role="alertdialog" aria-label="Confirm delete task">
        <p class="confirm-prompt-title">Delete task file?</p>
        <p>Delete task file "{pendingDeleteFile}"? This cannot be undone.</p>
        <div class="confirm-actions">
          <button class="btn btn-sm btn-danger" onclick={() => void confirmRemoveTask()} disabled={drawerSaving}>
            {#if drawerSaving}<Spinner /> Deleting…{:else}Delete task{/if}
          </button>
          <button class="btn btn-sm btn-secondary" onclick={cancelRemoveTask} disabled={drawerSaving}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if hasAutomations && data}
      <div class="automation-list">
        {#each data.automations as automation (automation.name)}
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
                  disabled={!!runningTaskName || drawerSaving}
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
                  disabled={logLoading}
                >View latest log</button>
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => void openEditTask(automation.fileName)}
                  disabled={drawerSaving}
                >Edit</button>
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => requestRemoveTask(automation.fileName)}
                  disabled={drawerSaving}
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
          <button class="btn btn-secondary btn-sm empty-state-btn" onclick={openNewTask}>Create your first task</button>
          <p class="empty-state-hint">Or drop <code>.md</code>/<code>.yml</code> files into <code>~/.openpalm/knowledge/tasks/</code>.</p>
        {/if}
      </EmptyState>
    {/if}
  </div>
</div>

{#key drawerDraft?.fileName}
  <TaskDrawer
    open={drawerOpen}
    draft={drawerDraft}
    saving={drawerSaving}
    saveError={drawerError}
    onClose={closeDrawer}
    onSave={(fileName, yaml) => void handleSave(fileName, yaml)}
  />
{/key}

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
  .ph {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-4);
    padding: var(--s-sp-6) clamp(1rem, 4vw, 2rem);
  }

  .ph-title {
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    font-weight: 400;
    color: var(--s-ink);
    margin: 0;
  }

  .ph-sub {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin: var(--s-sp-1) 0 0;
  }

  .ph-actions {
    display: flex;
    gap: var(--s-sp-2);
    align-items: center;
    flex-shrink: 0;
  }

  .automation-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
    padding: 0 clamp(1rem, 4vw, 2rem) var(--s-sp-5);
  }

  .automation-card {
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    background: none;
    overflow: hidden;
  }

  .automation-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-4);
    padding: var(--s-sp-4) var(--s-sp-5);
  }

  .automation-main {
    flex: 1;
    min-width: 0;
  }

  .automation-name {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    flex-wrap: wrap;
  }

  .automation-desc {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-top: var(--s-sp-1);
  }

  .automation-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--s-sp-1);
    flex-shrink: 0;
  }

  .meta-item {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }

  .meta-item-action {
    max-width: 28ch;
    text-align: right;
  }

  .badge {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    padding: 0.1em 0.5em;
    border-radius: 2px;
    border: var(--s-hair) solid currentColor;
    background: none;
  }

  .badge.badge-enabled {
    color: var(--s-moss);
  }

  .badge.badge-disabled {
    color: var(--s-ink-3);
  }

  .badge-type {
    color: var(--s-ink-3);
  }

  .automation-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    padding: var(--s-sp-2) var(--s-sp-5);
    border-top: var(--s-hair) solid var(--s-line-soft);
    background: var(--s-paper-deep);
  }

  .automation-actions {
    display: flex;
    gap: var(--s-sp-1);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .automation-file {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    letter-spacing: var(--s-track-label);
  }

  :global(.panel-body) {
    padding: 0 clamp(1rem, 4vw, 2rem) var(--s-sp-5);
  }

  .empty-state-hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin-top: calc(-1 * var(--s-sp-2));
  }

  .empty-state-btn {
    margin-top: var(--s-sp-2);
  }

  .empty-state-hint code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    background: var(--s-paper-deep);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .text-danger {
    color: var(--s-seal);
  }

  .confirm-prompt {
    margin: 0 clamp(1rem, 4vw, 2rem) var(--s-sp-4);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }
  .confirm-prompt-title {
    margin: 0 0 var(--s-sp-1) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }
  .confirm-prompt p {
    margin: 0 0 var(--s-sp-2) 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .confirm-actions {
    display: flex;
    gap: var(--s-sp-2);
  }

  .log-drawer-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-4);
  }

  .log-drawer-copy {
    max-width: 62ch;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .log-drawer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    flex-wrap: wrap;
  }

  .log-drawer-hint {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }

  .log-output {
    margin: 0;
    max-height: min(60dvh, 42rem);
    overflow: auto;
    padding: var(--s-sp-4);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
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
      gap: var(--s-sp-3);
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
