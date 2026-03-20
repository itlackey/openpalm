<script lang="ts">
  import type { RegistryResponse } from '$lib/types.js';

  interface Props {
    data: RegistryResponse | null;
    loading: boolean;
    error: string;
    tokenStored: boolean;
    actionLoading: string | null;
    onRefresh: () => void;
    onInstall: (name: string, type: 'channel' | 'automation') => void;
    onUninstall: (name: string, type: 'channel' | 'automation') => void;
  }

  let { data, loading, error, tokenStored, actionLoading, onRefresh, onInstall, onUninstall }: Props = $props();

  let hasComponents = $derived(data !== null && data.components.length > 0);
  let hasAutomations = $derived(data !== null && data.automations.length > 0);
  let hasAny = $derived(hasComponents || hasAutomations);

  /** Reverse map: cron expression to friendly label */
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

  /** Schedule alias to friendly label */
  const SCHEDULE_TO_LABEL: Record<string, string> = {
    'every-5-minutes': 'Every 5 minutes',
    'every-15-minutes': 'Every 15 minutes',
    'hourly': 'Every hour',
    'daily-midnight': 'Daily at midnight',
    'daily-8am': 'Daily at 8 AM',
    'weekly-sunday-3am': 'Weekly (Sunday 3 AM)',
    'weekly-sunday-4am': 'Weekly (Sunday 4 AM)'
  };

  function formatSchedule(schedule: string): string {
    return SCHEDULE_TO_LABEL[schedule] ?? CRON_TO_LABEL[schedule] ?? schedule;
  }

  function formatChannelName(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function formatAutomationName(name: string): string {
    return name
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Registry</h2>
    <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body">
    {#if hasAny && data}
      <!-- Components Section -->
      {#if hasComponents}
        <div class="section">
          <h3 class="section-title">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            Components
          </h3>
          <div class="card-grid">
            {#each data.components as component}
              <div class="registry-card channel-card">
                <div class="card-header">
                  <div class="card-icon channel-icon">
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                  </div>
                  <div class="card-title-row">
                    <span class="card-name">{component.id}</span>
                  </div>
                </div>
                <div class="card-body">
                  <div class="card-meta">
                    <span class="meta-tag">
                      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" />
                        <line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                      Component
                    </span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
          <p class="section-hint">Install components via the Components tab.</p>
        </div>
      {/if}

      <!-- Automations Section -->
      {#if hasAutomations}
        <div class="section">
          <h3 class="section-title">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Automations
          </h3>
          <div class="card-grid">
            {#each data.automations as automation}
              {@const isActioning = actionLoading === `automation:${automation.name}`}
              <div class="registry-card automation-card">
                <div class="card-header">
                  <div class="card-icon automation-icon">
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <div class="card-title-row">
                    <span class="card-name">{formatAutomationName(automation.name)}</span>
                    <span class="badge" class:badge-installed={automation.installed} class:badge-available={!automation.installed}>
                      {automation.installed ? 'Installed' : 'Available'}
                    </span>
                  </div>
                </div>
                <div class="card-body">
                  {#if automation.description}
                    <p class="card-desc">{automation.description}</p>
                  {/if}
                  <div class="card-meta">
                    {#if automation.schedule}
                      <span class="meta-tag">
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                        {formatSchedule(automation.schedule)}
                      </span>
                    {/if}
                    <span class="meta-tag">
                      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      {automation.name}.yml
                    </span>
                  </div>
                </div>
                <div class="card-footer">
                  {#if automation.installed}
                    <button
                      class="btn btn-danger btn-sm"
                      disabled={isActioning}
                      onclick={() => onUninstall(automation.name, 'automation')}
                    >
                      {#if isActioning}<span class="spinner"></span>{/if}
                      Uninstall
                    </button>
                  {:else}
                    <button
                      class="btn btn-primary btn-sm"
                      disabled={isActioning}
                      onclick={() => onInstall(automation.name, 'automation')}
                    >
                      {#if isActioning}<span class="spinner"></span>{/if}
                      Install
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
        {#if loading}
          <p>Loading registry...</p>
        {:else if error}
          <p class="text-danger">{error}</p>
          <button class="btn btn-secondary btn-sm" onclick={onRefresh}>Try Again</button>
        {:else}
          <p>No registry items found.</p>
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

  /* ── Section ──────────────────────────────────────────────────────── */

  .section {
    margin-bottom: var(--space-6);
  }

  .section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }

  .section-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin-top: var(--space-3);
    font-style: italic;
  }

  /* ── Card Grid ────────────────────────────────────────────────────── */

  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--space-4);
  }

  .registry-card {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .registry-card:hover {
    border-color: var(--color-border-hover);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }

  .channel-icon {
    background: var(--color-info-bg);
    color: var(--color-info);
  }

  .automation-icon {
    background: var(--color-warning-bg);
    color: var(--color-warning);
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-width: 0;
  }

  .card-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .card-body {
    padding: 0 var(--space-4) var(--space-3);
    flex: 1;
  }

  .card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin: 0 0 var(--space-3) 0;
    line-height: 1.5;
  }

  .card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .meta-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-tertiary);
  }

  /* ── Badges ───────────────────────────────────────────────────────── */

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

  .badge-installed {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .badge-available {
    background: var(--color-bg-tertiary);
    color: var(--color-text-tertiary);
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */

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

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
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

  .btn-primary {
    background: var(--color-primary);
    color: #fff;
    border-color: var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .btn-danger {
    background: var(--color-danger-bg);
    color: var(--color-danger);
    border-color: transparent;
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-danger);
    color: #fff;
  }

  /* ── Shared ───────────────────────────────────────────────────────── */

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

  .empty-state .btn {
    margin-top: var(--space-2);
  }

  .text-danger {
    color: var(--color-danger);
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
    .card-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
