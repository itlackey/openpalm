<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import { fetchServiceLogs } from '$lib/api.js';

  interface Props {
    tokenStored: boolean;
    services: string[];
  }

  let { tokenStored, services }: Props = $props();

  let logs = $state('');
  let loading = $state(false);
  let error = $state('');
  let selectedService = $state('');
  let tailLines = $state(100);
  let autoScroll = $state(true);

  let logContainer: HTMLPreElement | undefined = $state();

  async function loadLogs(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    loading = true;
    error = '';
    try {
      const result = await fetchServiceLogs(token, {
        service: selectedService || undefined,
        tail: tailLines,
      });
      if (result.ok) {
        logs = result.logs;
        if (autoScroll && logContainer) {
          requestAnimationFrame(() => {
            if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
          });
        }
      } else {
        error = result.error ?? 'Failed to fetch logs.';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to fetch logs.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Service Logs</h2>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadLogs()} disabled={loading || !tokenStored}>
        {#if loading}
          <span class="spinner"></span>
        {/if}
        Refresh
      </button>
    </div>
  </div>

  <div class="controls">
    <div class="control-group">
      <label for="log-service" class="control-label">Service</label>
      <select id="log-service" class="control-input" bind:value={selectedService}>
        <option value="">All services</option>
        {#each services as svc}
          <option value={svc}>{svc}</option>
        {/each}
      </select>
    </div>

    <div class="control-group">
      <label for="log-tail" class="control-label">Lines</label>
      <select id="log-tail" class="control-input" bind:value={tailLines}>
        <option value={50}>50</option>
        <option value={100}>100</option>
        <option value={250}>250</option>
        <option value={500}>500</option>
        <option value={1000}>1000</option>
      </select>
    </div>

    <div class="control-group control-group--toggle">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={autoScroll} />
        <span>Auto-scroll</span>
      </label>
    </div>

    <button class="btn btn-primary btn-sm" onclick={() => void loadLogs()} disabled={loading || !tokenStored}>
      {#if loading}
        <span class="spinner"></span>
      {/if}
      Load Logs
    </button>
  </div>

  <div class="panel-body panel-body--flush">
    {#if error}
      <div class="error-banner">
        <span>{error}</span>
      </div>
    {/if}

    {#if logs}
      <pre class="log-output" bind:this={logContainer}>{logs}</pre>
    {:else if !loading}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <p>Select a service and click "Load Logs" to view container output.</p>
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

  .panel-body--flush {
    padding: 0;
  }

  /* ── Controls ─────────────────────────────────────────────────── */

  .controls {
    display: flex;
    align-items: flex-end;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    flex-wrap: wrap;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .control-group--toggle {
    justify-content: flex-end;
  }

  .control-label {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .control-input {
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: inherit;
    min-width: 140px;
  }

  .control-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    height: 32px;
  }

  .toggle-label input {
    accent-color: var(--color-primary);
  }

  /* ── Log Output ───────────────────────────────────────────────── */

  .log-output {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.6;
    color: var(--color-text);
    background: var(--color-bg);
    padding: var(--space-4) var(--space-5);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-y: auto;
    max-height: 600px;
    tab-size: 4;
  }

  /* ── Error ────────────────────────────────────────────────────── */

  .error-banner {
    padding: var(--space-3) var(--space-5);
    background: var(--color-danger-bg);
    border-bottom: 1px solid var(--color-danger-border, rgba(255, 107, 107, 0.25));
    color: var(--color-danger);
    font-size: var(--text-sm);
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

  .btn-primary {
    background: var(--color-primary);
    color: #000;
    border-color: var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
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
    .controls {
      flex-direction: column;
      align-items: stretch;
    }

    .control-input {
      min-width: unset;
      width: 100%;
    }

    .log-output {
      max-height: 400px;
      font-size: 10px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
