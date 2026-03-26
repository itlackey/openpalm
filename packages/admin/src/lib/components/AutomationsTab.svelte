<script lang="ts">
  import type { AutomationsResponse, CatalogAutomation } from '$lib/types.js';
  import { getAdminToken } from '$lib/auth.js';
  import { fetchAutomationCatalog, installAutomation, uninstallAutomation } from '$lib/api.js';

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

  // ── Catalog state ─────────────────────────────────────────────
  let showCatalog = $state(false);
  let catalog = $state<CatalogAutomation[]>([]);
  let catalogLoading = $state(false);
  let catalogError = $state('');
  let actionLoading = $state<string | null>(null);
  let actionSuccess = $state('');

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

  async function loadCatalog(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    catalogLoading = true;
    catalogError = '';
    try {
      const result = await fetchAutomationCatalog(token);
      catalog = result.automations;
    } catch (e) {
      catalogError = e instanceof Error ? e.message : 'Failed to load catalog.';
    } finally {
      catalogLoading = false;
    }
  }

  function handleToggleCatalog(): void {
    showCatalog = !showCatalog;
    if (showCatalog && catalog.length === 0) {
      void loadCatalog();
    }
  }

  async function handleInstall(name: string): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    actionLoading = name;
    actionSuccess = '';
    try {
      await installAutomation(token, name);
      actionSuccess = `Installed "${name}".`;
      await loadCatalog();
      onRefresh();
    } catch (e) {
      catalogError = e instanceof Error ? e.message : 'Install failed.';
    } finally {
      actionLoading = null;
    }
  }

  async function handleUninstall(name: string): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    actionLoading = name;
    actionSuccess = '';
    try {
      await uninstallAutomation(token, name);
      actionSuccess = `Uninstalled "${name}".`;
      await loadCatalog();
      onRefresh();
    } catch (e) {
      catalogError = e instanceof Error ? e.message : 'Uninstall failed.';
    } finally {
      actionLoading = null;
    }
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Automations</h2>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={handleToggleCatalog} disabled={!tokenStored}>
        {showCatalog ? 'Hide Catalog' : 'Browse Catalog'}
      </button>
      <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
        {#if loading}
          <span class="spinner"></span>
        {/if}
        Refresh
      </button>
    </div>
  </div>

  <!-- ── Catalog Section ──────────────────────────────────────── -->
  {#if showCatalog}
    <div class="catalog-section">
      <div class="catalog-header">
        <h3>Available Automations</h3>
        <button class="btn btn-ghost btn-sm" onclick={() => void loadCatalog()} disabled={catalogLoading}>
          {#if catalogLoading}<span class="spinner"></span>{/if}
          Refresh Catalog
        </button>
      </div>

      {#if actionSuccess}
        <div class="feedback feedback--success" role="status" aria-live="polite">
          <span>{actionSuccess}</span>
          <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => actionSuccess = ''}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      {/if}

      {#if catalogError}
        <div class="feedback feedback--error" role="alert">
          <span>{catalogError}</span>
          <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={() => catalogError = ''}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      {/if}

      {#if catalogLoading && catalog.length === 0}
        <div class="loading-state">
          <span class="spinner"></span>
          <span>Loading catalog...</span>
        </div>
      {:else if catalog.length === 0 && !catalogLoading}
        <div class="catalog-empty">
          <p>No automations available in the registry.</p>
        </div>
      {:else}
        <div class="catalog-list">
          {#each catalog as item (item.name)}
            <div class="catalog-card">
              <div class="catalog-card-main">
                <div class="catalog-card-name">
                  {item.name}
                  {#if item.installed}
                    <span class="badge badge-enabled">installed</span>
                  {/if}
                </div>
                {#if item.description}
                  <div class="catalog-card-desc">{item.description}</div>
                {/if}
                {#if item.schedule}
                  {@const preset = formatSchedule(item.schedule)}
                  <div class="catalog-card-schedule">
                    {#if preset}
                      {preset.label}
                    {:else}
                      <code>{item.schedule}</code>
                    {/if}
                  </div>
                {/if}
              </div>
              <div class="catalog-card-action">
                {#if item.installed}
                  <button
                    class="btn btn-sm btn-danger"
                    disabled={actionLoading === item.name}
                    onclick={() => void handleUninstall(item.name)}
                  >
                    {#if actionLoading === item.name}
                      <span class="spinner"></span>
                    {:else}
                      Uninstall
                    {/if}
                  </button>
                {:else}
                  <button
                    class="btn btn-sm btn-outline"
                    disabled={actionLoading === item.name}
                    onclick={() => void handleInstall(item.name)}
                  >
                    {#if actionLoading === item.name}
                      <span class="spinner"></span>
                    {:else}
                      Install
                    {/if}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Installed Automations ────────────────────────────────── -->
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
          <p class="empty-state-hint">Use the catalog above to install automations, or drop .yml files into <code>~/.openpalm/config/automations/</code>.</p>
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

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .panel-body {
    padding: var(--space-5);
  }

  /* ── Catalog Section ──────────────────────────────────────────── */

  .catalog-section {
    border-bottom: 1px solid var(--color-border);
    padding: var(--space-4) var(--space-5);
    background: var(--color-bg-secondary);
  }

  .catalog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .catalog-header h3 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .catalog-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .catalog-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .catalog-card-main {
    flex: 1;
    min-width: 0;
  }

  .catalog-card-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
    flex-wrap: wrap;
  }

  .catalog-card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: var(--space-1);
  }

  .catalog-card-schedule {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    margin-top: var(--space-1);
  }

  .catalog-card-schedule code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
  }

  .catalog-card-action {
    flex-shrink: 0;
  }

  .catalog-empty {
    padding: var(--space-4);
    text-align: center;
    color: var(--color-text-tertiary);
    font-size: var(--text-sm);
  }

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  /* ── Feedback ─────────────────────────────────────────────────── */

  .feedback {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }

  .feedback span { flex: 1; }

  .feedback--success {
    background: var(--color-success-bg);
    border: 1px solid var(--color-success-border);
    color: var(--color-text);
  }

  .feedback--error {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border, rgba(255, 107, 107, 0.25));
    color: var(--color-text);
  }

  .btn-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    border-radius: var(--radius-sm);
  }

  .btn-dismiss:hover {
    opacity: 1;
    background: rgba(128, 128, 128, 0.1);
  }

  /* ── Installed Automations ────────────────────────────────────── */

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

  /* ── Empty State ──────────────────────────────────────────────── */

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

  /* ── Buttons ──────────────────────────────────────────────────── */

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

  .btn-outline {
    background: transparent;
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--color-primary-subtle);
  }

  .btn-ghost {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    padding: 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .btn-danger {
    background: var(--color-danger);
    color: #fff;
    border-color: var(--color-danger);
  }

  .btn-danger:hover:not(:disabled) {
    opacity: 0.9;
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

    .catalog-card {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      transition: none;
    }
  }
</style>
