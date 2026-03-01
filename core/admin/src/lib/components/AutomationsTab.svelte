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

  let expandedLogs: Set<string> = $state(new Set());

  function toggleLogs(fileName: string): void {
    const next = new Set(expandedLogs);
    if (next.has(fileName)) {
      next.delete(fileName);
    } else {
      next.add(fileName);
    }
    expandedLogs = next;
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  /** Reverse map: cron expression → friendly label */
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
    <h2>Automations</h2>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body">
    {#if data?.scheduler}
      <div class="scheduler-status">
        <span class="scheduler-label">Scheduler</span>
        <span class="scheduler-count">{data.scheduler.jobCount} active job{data.scheduler.jobCount === 1 ? '' : 's'}</span>
      </div>
    {/if}

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
              <button
                class="logs-toggle"
                onclick={() => toggleLogs(automation.fileName)}
                aria-expanded={expandedLogs.has(automation.fileName)}
              >
                <svg class="chevron" class:chevron-open={expandedLogs.has(automation.fileName)} aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Logs
                {#if automation.logs.length > 0}
                  <span class="log-count">({automation.logs.length})</span>
                {/if}
              </button>
              {#if automation.logs.length > 0}
                {@const last = automation.logs[0]}
                <span class="last-run" class:last-run-ok={last.ok} class:last-run-fail={!last.ok}>
                  {last.ok ? 'OK' : 'FAIL'} &middot; {formatDuration(last.durationMs)} &middot; {formatTime(last.at)}
                </span>
              {/if}
            </div>
            {#if expandedLogs.has(automation.fileName)}
              <div class="logs-panel">
                {#if automation.logs.length === 0}
                  <div class="logs-empty">No executions recorded yet.</div>
                {:else}
                  <table class="logs-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each automation.logs as entry}
                        <tr class:log-row-fail={!entry.ok}>
                          <td class="log-time">{formatTime(entry.at)}</td>
                          <td>
                            <span class="log-status" class:log-ok={entry.ok} class:log-fail={!entry.ok}>
                              {entry.ok ? 'OK' : 'FAIL'}
                            </span>
                          </td>
                          <td class="log-duration">{formatDuration(entry.durationMs)}</td>
                          <td class="log-error">{entry.error ?? ''}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </div>
            {/if}
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
        {:else}
          <p>No automations configured. Drop .yml files into <code>~/.config/openpalm/automations/</code> to get started.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h2 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .panel-body {
    padding: var(--space-5);
  }

  .scheduler-status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-5);
    font-size: var(--text-sm);
  }

  .scheduler-label {
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .scheduler-count {
    color: var(--color-text-secondary);
  }

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

  .meta-cron {
    color: var(--color-text-tertiary);
  }

  .meta-tz {
    color: var(--color-text-tertiary);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    font-weight: var(--font-semibold);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-enabled {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .badge-disabled {
    background: var(--color-bg-tertiary);
    color: var(--color-text-tertiary);
  }

  .badge-type {
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
  }

  /* ── Footer with logs toggle ──────────────────────────────────────── */

  .automation-footer {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
  }

  .logs-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: none;
    border: none;
    padding: var(--space-1) var(--space-2);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .logs-toggle:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }

  .chevron {
    transition: transform var(--transition-fast);
  }

  .chevron-open {
    transform: rotate(90deg);
  }

  .log-count {
    color: var(--color-text-tertiary);
    font-weight: var(--font-medium);
  }

  .last-run {
    font-size: var(--text-xs);
    margin-left: auto;
  }

  .last-run-ok {
    color: var(--color-success);
  }

  .last-run-fail {
    color: var(--color-danger);
  }

  /* ── Logs panel ────────────────────────────────────────────────────── */

  .logs-panel {
    border-top: 1px solid var(--color-border);
    max-height: 280px;
    overflow-y: auto;
  }

  .logs-empty {
    padding: var(--space-4);
    text-align: center;
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }

  .logs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-xs);
  }

  .logs-table th {
    position: sticky;
    top: 0;
    background: var(--color-bg-tertiary);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--color-border);
  }

  .logs-table td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    vertical-align: top;
  }

  .logs-table tr:last-child td {
    border-bottom: none;
  }

  .log-row-fail {
    background: color-mix(in srgb, var(--color-danger) 4%, transparent);
  }

  .log-time {
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .log-status {
    font-weight: var(--font-semibold);
    text-transform: uppercase;
  }

  .log-ok {
    color: var(--color-success);
  }

  .log-fail {
    color: var(--color-danger);
  }

  .log-duration {
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .log-error {
    color: var(--color-danger);
    word-break: break-word;
    max-width: 300px;
  }

  /* ── Shared ────────────────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-10) var(--space-4);
    color: var(--color-text-tertiary);
    text-align: center;
    gap: var(--space-4);
  }

  .empty-state p {
    font-size: var(--text-sm);
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

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
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

    .log-error {
      max-width: 150px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner,
    .chevron {
      animation: none;
      transition: none;
    }
  }
</style>
