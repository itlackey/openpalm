<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import { fetchAuditLog } from '$lib/api.js';

  interface Props {
    tokenStored: boolean;
  }

  let { tokenStored }: Props = $props();

  let entries = $state<Record<string, unknown>[]>([]);
  let loading = $state(false);
  let error = $state('');
  let source = $state<'all' | 'admin' | 'guardian'>('all');
  let limit = $state(100);

  async function loadAudit(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    loading = true;
    error = '';
    try {
      const result = await fetchAuditLog(token, { source, limit });
      entries = result.audit;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load audit log.';
    } finally {
      loading = false;
    }
  }

  function formatTimestamp(entry: Record<string, unknown>): string {
    const ts = (entry.at ?? entry.ts ?? '') as string;
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      console.warn('[AuditTab] Failed to parse timestamp', e);
      return ts;
    }
  }

  function getAction(entry: Record<string, unknown>): string {
    return (entry.action ?? entry.status ?? '') as string;
  }

  function getActor(entry: Record<string, unknown>): string {
    return (entry.actor ?? entry.userId ?? '') as string;
  }

  function getSource(entry: Record<string, unknown>): string {
    return (entry._source ?? 'admin') as string;
  }

  function getDetails(entry: Record<string, unknown>): string {
    const skip = new Set(['at', 'ts', 'action', 'actor', 'status', 'userId', '_source', 'requestId', 'callerType', 'ok', 'channel', 'sessionId']);
    const details: string[] = [];
    for (const [k, v] of Object.entries(entry)) {
      if (skip.has(k) || v === undefined || v === null || v === '') continue;
      details.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return details.join(', ');
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Audit Log</h2>
    <div class="panel-header-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => void loadAudit()} disabled={loading || !tokenStored}>
        {#if loading}<span class="spinner"></span>{/if}
        Refresh
      </button>
    </div>
  </div>

  <div class="controls">
    <div class="control-group">
      <label for="audit-source" class="control-label">Source</label>
      <select id="audit-source" class="control-input" bind:value={source}>
        <option value="all">All</option>
        <option value="admin">Admin</option>
        <option value="guardian">Guardian</option>
      </select>
    </div>
    <div class="control-group">
      <label for="audit-limit" class="control-label">Limit</label>
      <select id="audit-limit" class="control-input" bind:value={limit}>
        <option value={50}>50</option>
        <option value={100}>100</option>
        <option value={250}>250</option>
        <option value={500}>500</option>
        <option value={1000}>1000</option>
      </select>
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => void loadAudit()} disabled={loading || !tokenStored}>
      {#if loading}<span class="spinner"></span>{/if}
      Load
    </button>
  </div>

  <div class="panel-body panel-body--flush">
    {#if error}
      <div class="error-banner"><span>{error}</span></div>
    {/if}

    {#if entries.length > 0}
      <div class="audit-table">
        <div class="audit-table-header">
          <span class="audit-col audit-col--time">Time</span>
          <span class="audit-col audit-col--source">Source</span>
          <span class="audit-col audit-col--action">Action</span>
          <span class="audit-col audit-col--actor">Actor</span>
          <span class="audit-col audit-col--details">Details</span>
        </div>
        {#each entries as entry, i (i)}
          <div class="audit-row" class:audit-row--failed={entry.ok === false}>
            <span class="audit-col audit-col--time">{formatTimestamp(entry)}</span>
            <span class="audit-col audit-col--source">
              <span class="badge badge-source">{getSource(entry)}</span>
            </span>
            <span class="audit-col audit-col--action">{getAction(entry)}</span>
            <span class="audit-col audit-col--actor">{getActor(entry)}</span>
            <span class="audit-col audit-col--details audit-details">{getDetails(entry)}</span>
          </div>
        {/each}
      </div>
    {:else if !loading}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
        <p>Click "Load" to view the audit log.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; }
  .panel-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); }
  .panel-header h2 { font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text); }
  .panel-header-actions { display: flex; align-items: center; gap: var(--space-3); }
  .panel-body--flush { padding: 0; }

  .controls { display: flex; align-items: flex-end; gap: var(--space-4); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); flex-wrap: wrap; }
  .control-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .control-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .control-input { height: 32px; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-text); font-size: var(--text-sm); font-family: inherit; min-width: 100px; }
  .control-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-subtle); }

  .audit-table { display: flex; flex-direction: column; width: 100%; overflow-x: auto; }
  .audit-table-header { display: flex; align-items: center; padding: var(--space-2) var(--space-5); background: var(--color-bg-tertiary); border-bottom: 1px solid var(--color-border); font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; min-width: 800px; }
  .audit-row { display: flex; align-items: flex-start; padding: var(--space-2) var(--space-5); border-bottom: 1px solid var(--color-bg-tertiary); font-size: var(--text-xs); min-width: 800px; }
  .audit-row:hover { background: var(--color-surface-hover); }
  .audit-row--failed { background: var(--color-danger-bg); }

  .audit-col { display: flex; align-items: center; gap: var(--space-1); }
  .audit-col--time { flex: 0 0 160px; color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 11px; }
  .audit-col--source { flex: 0 0 80px; }
  .audit-col--action { flex: 0 0 180px; font-weight: var(--font-medium); color: var(--color-text); }
  .audit-col--actor { flex: 0 0 100px; color: var(--color-text-secondary); }
  .audit-col--details { flex: 1; min-width: 0; }
  .audit-details { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-tertiary); word-break: break-all; }

  .badge { display: inline-flex; align-items: center; font-size: 10px; font-weight: var(--font-semibold); padding: 1px 6px; border-radius: var(--radius-full); text-transform: uppercase; letter-spacing: 0.03em; }
  .badge-source { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }

  .error-banner { padding: var(--space-3) var(--space-5); background: var(--color-danger-bg); border-bottom: 1px solid var(--color-danger-border, rgba(255,107,107,0.25)); color: var(--color-danger); font-size: var(--text-sm); }
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--space-10) var(--space-4); color: var(--color-text-tertiary); text-align: center; gap: var(--space-4); }
  .empty-state p { font-size: var(--text-sm); }

  .btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: 8px 16px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: var(--font-semibold); line-height: 1.4; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: all var(--transition-fast); white-space: nowrap; }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-primary { background: var(--color-primary); color: #000; border-color: var(--color-primary); }
  .btn-primary:hover:not(:disabled) { background: var(--color-primary-hover); border-color: var(--color-primary-hover); }
  .btn-secondary { background: var(--color-bg); color: var(--color-text); border-color: var(--color-border); }
  .btn-secondary:hover:not(:disabled) { background: var(--color-surface-hover); border-color: var(--color-border-hover); }
  .btn-sm { padding: 5px 12px; font-size: var(--text-xs); }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 768px) { .controls { flex-direction: column; align-items: stretch; } .control-input { min-width: unset; width: 100%; } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
