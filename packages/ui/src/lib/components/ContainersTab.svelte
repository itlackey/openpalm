<script lang="ts">
  import type { ContainerListResponse, ServiceEntry } from '$lib/types.js';

  interface Props {
    containerData: ContainerListResponse | null;
    serviceEntries: ServiceEntry[];
    loading: boolean;
    error: string;
    tokenStored: boolean;
    selectedContainerId: string | null;
    onToggleContainer: (id: string) => void;
    onStart: (id: string) => void;
    onStop: (id: string) => void;
    onRestart: (id: string) => void;
    onRefresh: () => void;
    onPullImages: () => void;
    lastUpdated: string | null;
    pullLoading: boolean;
  }

  let {
    containerData,
    serviceEntries,
    loading,
    error,
    tokenStored,
    selectedContainerId,
    onToggleContainer,
    onStart,
    onStop,
    onRestart,
    onRefresh,
    onPullImages,
    lastUpdated,
    pullLoading
  }: Props = $props();

  let hasEntries = $derived(serviceEntries.length > 0);

  // ── Per-entry row state (inlined from ContainerRow) ──────────────────
  type RowState = { inFlight: 'start' | 'stop' | 'restart' | null; confirm: 'start' | 'stop' | 'restart' | null; feedback: { type: 'success' | 'error'; message: string } | null };
  let rowState = $state<Record<string, RowState>>({});

  function parseImageTag(image: string): { name: string; tag: string } {
    const atIdx = image.indexOf('@');
    const base = atIdx > -1 ? image.slice(0, atIdx) : image;
    const colonIdx = base.lastIndexOf(':');
    if (colonIdx > -1) {
      return { name: base.slice(0, colonIdx), tag: base.slice(colonIdx + 1) };
    }
    return { name: base, tag: 'latest' };
  }

  function containerStatusColor(state: string): 'success' | 'danger' | 'warning' | 'idle' {
    if (state === 'running') return 'success';
    if (state === 'exited' || state === 'dead' || state === 'stopped') return 'danger';
    if (state === 'restarting' || state === 'paused') return 'warning';
    return 'idle';
  }

  function rowFor(id: string): RowState {
    if (!rowState[id]) rowState[id] = { inFlight: null, confirm: null, feedback: null };
    return rowState[id];
  }

  function requestRowAction(id: string, action: 'start' | 'stop' | 'restart', e: MouseEvent): void {
    e.stopPropagation();
    rowFor(id).confirm = action;
  }

  function cancelConfirm(id: string, e: MouseEvent): void {
    e.stopPropagation();
    rowFor(id).confirm = null;
  }

  async function executeAction(id: string, service: string, action: 'start' | 'stop' | 'restart', e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const row = rowFor(id);
    row.confirm = null;
    row.inFlight = action;
    row.feedback = null;
    try {
      if (action === 'start') onStart(service);
      else if (action === 'stop') onStop(service);
      else onRestart(service);
      row.feedback = { type: 'success', message: `${action.charAt(0).toUpperCase() + action.slice(1)} initiated` };
    } catch (err) {
      row.feedback = { type: 'error', message: `${action} failed: ${err instanceof Error ? err.message : err}` };
    }
    row.inFlight = null;
    setTimeout(() => {
      row.feedback = null;
    }, 3000);
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Container Status</h2>
    <div class="panel-header-actions">
      {#if lastUpdated}
        <span class="last-updated">Updated {lastUpdated}</span>
      {/if}
      <button class="btn btn-secondary btn-sm" onclick={onPullImages} disabled={pullLoading || !tokenStored}>
        {#if pullLoading}
          <span class="spinner"></span>
        {/if}
        Pull Images
      </button>
      <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={loading || !tokenStored}>
        {#if loading}
          <span class="spinner"></span>
        {/if}
        Refresh
      </button>
    </div>
  </div>
  <div class="panel-body panel-body--flush">
    {#if hasEntries}
      <div class="container-table">
        <div class="container-table-header">
          <span class="ct-col ct-col--name">Container</span>
          <span class="ct-col ct-col--image">Image</span>
          <span class="ct-col ct-col--tag">Tag</span>
          <span class="ct-col ct-col--status">Status</span>
          <span class="ct-col ct-col--actions"></span>
        </div>
        {#each serviceEntries as entry (entry.id)}
          {@const selected = selectedContainerId === entry.id}
          {@const entryActionInFlight = rowState[entry.id]?.inFlight ?? null}
          {@const entryConfirmAction = rowState[entry.id]?.confirm ?? null}
          {@const entryFeedback = rowState[entry.id]?.feedback ?? null}
          {@const img = entry.docker ? parseImageTag(entry.docker.Image) : null}
          {@const isAnyActionInFlight = entryActionInFlight !== null}
          {@const isNotCreated = !entry.docker}
          <button
            class="container-table-row container-table-row--clickable"
            aria-expanded={selected}
            onclick={() => onToggleContainer(entry.id)}
          >
            <span class="ct-col ct-col--name">
              <span class="ct-indicator ct-indicator--{containerStatusColor(entry.state)}"></span>
              <span class="ct-service-name">{entry.service}</span>
            </span>
            <span class="ct-col ct-col--image ct-mono">
              {#if img}
                {img.name}
              {:else}
                <span class="ct-not-created">--</span>
              {/if}
            </span>
            <span class="ct-col ct-col--tag">
              {#if img}
                <span class="tag-badge">{img.tag}</span>
              {:else}
                <span class="ct-not-created">--</span>
              {/if}
            </span>
            <span class="ct-col ct-col--status">
              <span class="badge badge-{containerStatusColor(entry.state)}">
                {entry.state}
              </span>
            </span>
            <span class="ct-col ct-col--actions">
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class:ct-chevron-open={selected}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>

          {#if selected}
            <div class="container-detail">
              {#if entry.docker}
                {@const container = entry.docker}
                <div class="detail-grid">
                  <div class="detail-item">
                    <span class="detail-label">Container ID</span>
                    <span class="detail-value detail-mono">{container.ID}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Name</span>
                    <span class="detail-value detail-mono">{container.Name || container.Names}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Image</span>
                    <span class="detail-value detail-mono">{container.Image}</span>
                  </div>
                  {#if img}
                    <div class="detail-item">
                      <span class="detail-label">Image Name</span>
                      <span class="detail-value detail-mono">{img.name}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Tag / Digest</span>
                      <span class="detail-value">
                        <span class="tag-badge tag-badge--lg">{img.tag}</span>
                        {#if container.Image.includes('@')}
                          <span class="detail-mono detail-digest">{container.Image.split('@')[1]?.slice(0, 19)}...</span>
                        {/if}
                      </span>
                    </div>
                  {/if}
                  <div class="detail-item">
                    <span class="detail-label">State</span>
                    <span class="detail-value">
                      <span class="badge badge-{containerStatusColor(container.State)}">{container.State}</span>
                    </span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Status</span>
                    <span class="detail-value">{container.Status}</span>
                  </div>
                  {#if container.Health}
                    <div class="detail-item">
                      <span class="detail-label">Health</span>
                      <span class="detail-value">
                        <span
                          class="badge"
                          class:badge-success={container.Health === 'healthy'}
                          class:badge-warning={container.Health === 'starting'}
                          class:badge-danger={container.Health === 'unhealthy'}
                          class:badge-idle={!['healthy', 'starting', 'unhealthy'].includes(container.Health)}
                        >
                          {container.Health}
                        </span>
                      </span>
                    </div>
                  {/if}
                  {#if container.Ports}
                    <div class="detail-item">
                      <span class="detail-label">Ports</span>
                      <span class="detail-value detail-mono">{container.Ports}</span>
                    </div>
                  {/if}
                  {#if container.RunningFor}
                    <div class="detail-item">
                      <span class="detail-label">Uptime</span>
                      <span class="detail-value">{container.RunningFor}</span>
                    </div>
                  {/if}
                  {#if container.CreatedAt}
                    <div class="detail-item">
                      <span class="detail-label">Created</span>
                      <span class="detail-value">{container.CreatedAt}</span>
                    </div>
                  {/if}
                  {#if container.Project}
                    <div class="detail-item">
                      <span class="detail-label">Project</span>
                      <span class="detail-value detail-mono">{container.Project}</span>
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="detail-not-created">
                  <p>Container has not been created yet. Use <strong>Start</strong> to create and start it.</p>
                </div>
              {/if}

              {#if entryFeedback}
                <div class="action-feedback action-feedback--{entryFeedback.type}" role="status">
                  {entryFeedback.message}
                </div>
              {/if}

              {#if entryConfirmAction}
                <div class="confirm-bar" role="alert">
                  <span class="confirm-text">
                    {entryConfirmAction.charAt(0).toUpperCase() + entryConfirmAction.slice(1)} <strong>{entry.service}</strong>?
                  </span>
                  <div class="confirm-actions">
                    <button
                      class="btn btn-danger btn-sm"
                      onclick={(e) => executeAction(entry.id, entry.service, entryConfirmAction!, e)}
                    >
                      Confirm
                    </button>
                    <button
                      class="btn btn-secondary btn-sm"
                      onclick={(e) => cancelConfirm(entry.id, e)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {:else}
                <div class="detail-actions">
                  {#if isNotCreated}
                    <button class="btn btn-primary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => requestRowAction(entry.id, 'start', e)}>
                      {#if entryActionInFlight === 'start'}<span class="spinner-inline"></span>{/if}
                      Start
                    </button>
                  {:else}
                    <button class="btn btn-secondary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => requestRowAction(entry.id, 'start', e)}>
                      {#if entryActionInFlight === 'start'}<span class="spinner-inline"></span>{/if}
                      Start
                    </button>
                    <button class="btn btn-danger btn-sm" disabled={isAnyActionInFlight} onclick={(e) => requestRowAction(entry.id, 'stop', e)}>
                      {#if entryActionInFlight === 'stop'}<span class="spinner-inline"></span>{/if}
                      Stop
                    </button>
                    <button class="btn btn-secondary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => requestRowAction(entry.id, 'restart', e)}>
                      {#if entryActionInFlight === 'restart'}<span class="spinner-inline"></span>{/if}
                      Restart
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="empty-state">
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
        {#if loading}
          <p>Loading container status...</p>
        {:else if error}
          <p class="text-danger">{error}</p>
          <button class="btn btn-secondary btn-sm" onclick={onRefresh} disabled={!tokenStored}>
            Try Again
          </button>
        {:else if containerData && !containerData.dockerAvailable}
          <p>Docker is not available on this host.</p>
          <p class="hint">Ensure Docker is running and the admin service has access to the Docker socket.</p>
        {:else}
          <p>No containers found. Services may not be installed yet.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .container-table {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .container-table-header {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-5);
    background: var(--color-bg-tertiary);
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    text-transform: none;
  }

  .ct-col {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ct-col--name {
    flex: 2;
    min-width: 0;
  }

  .ct-col--image {
    flex: 3;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ct-col--tag {
    flex: 1;
    min-width: 0;
  }

  .ct-col--status {
    flex: 1;
    min-width: 0;
  }

  .ct-col--actions {
    flex: 0 0 24px;
    justify-content: center;
    color: var(--color-text-tertiary);
  }

  .ct-service-name {
    font-weight: var(--font-medium);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .ct-mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .ct-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .ct-indicator--success {
    background: var(--color-success);
  }

  .ct-indicator--danger {
    background: var(--color-danger);
  }

  .ct-indicator--warning {
    background: var(--color-warning);
  }

  .ct-indicator--idle {
    background: var(--color-border);
  }

  .ct-chevron-open {
    transform: rotate(180deg);
  }

  .ct-not-created {
    color: var(--color-text-tertiary);
    font-style: italic;
  }

  .tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    font-size: var(--text-xs);  /* 12px — rubric minimum; was 0.6875rem ≈ 11px */
    font-family: var(--font-mono);
    font-weight: var(--font-medium);
    color: var(--color-info);
    background: var(--color-info-bg);
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .tag-badge--lg {
    padding: 2px 8px;
    font-size: var(--text-xs);
  }

  .container-table-row {
    display: flex;
    align-items: center;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--color-bg-tertiary);
    font-size: var(--text-sm);
    width: 100%;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    font-family: var(--font-sans);
    text-align: left;
  }

  .container-table-row:last-child {
    border-bottom: none;
  }

  .container-table-row--clickable {
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .container-table-row--clickable:hover {
    background: var(--color-surface-hover);
  }

  .container-table-row--clickable:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .container-detail {
    padding: var(--space-4) var(--space-5) var(--space-4) calc(var(--space-5) + 28px);
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3) var(--space-6);
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-label {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .detail-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .detail-mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    word-break: break-all;
  }

  .detail-digest {
    font-size: var(--text-xs);  /* 12px — was 0.6875rem ≈ 11px */
    color: var(--color-text-tertiary);
  }

  .detail-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .detail-not-created {
    padding: var(--space-2) 0;
  }

  .detail-not-created p {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .action-feedback {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }

  .action-feedback--success {
    background: var(--color-success-bg);
    color: var(--color-success);
    border: 1px solid var(--color-success-border);
  }

  .action-feedback--error {
    background: var(--color-danger-bg);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
  }

  .confirm-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-md);
  }

  .confirm-text {
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .confirm-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .spinner-inline {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .text-danger {
    color: var(--color-danger);
  }

  .empty-state .btn {
    margin-top: var(--space-2);
  }

  .empty-state .hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    max-width: 32ch;
  }

  .last-updated {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .container-table-header {
      display: none;
    }

    .container-table-row {
      flex-wrap: wrap;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-4);
    }

    .ct-col--name {
      flex: 1 1 auto;
    }

    .ct-col--image,
    .ct-col--tag {
      display: none;
    }

    .ct-col--status {
      flex: 0 0 auto;
    }

    .ct-col--actions {
      flex: 0 0 20px;
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }

    .container-detail {
      padding-left: var(--space-4);
    }

    .confirm-bar {
      flex-direction: column;
      align-items: stretch;
    }

    .confirm-actions {
      justify-content: flex-end;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner-inline {
      animation: none;
    }
  }
</style>
