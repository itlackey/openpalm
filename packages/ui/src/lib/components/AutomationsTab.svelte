<script lang="ts">
  import type { AutomationsResponse } from '$lib/types.js';

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
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Refresh
    </button>
  </div>

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
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
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
