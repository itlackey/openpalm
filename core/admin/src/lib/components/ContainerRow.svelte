<script lang="ts">
  import type { DockerContainer } from '$lib/types.js';

  interface Props {
    container: DockerContainer;
    selected: boolean;
    onToggle: () => void;
    onStart: () => void;
    onStop: () => void;
    onRestart: () => void;
  }

  let { container, selected, onToggle, onStart, onStop, onRestart }: Props = $props();

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
    if (state === 'exited' || state === 'dead') return 'danger';
    if (state === 'restarting' || state === 'paused') return 'warning';
    return 'idle';
  }

  let img = $derived(parseImageTag(container.Image));
</script>

<button
  class="container-table-row container-table-row--clickable"
  aria-expanded={selected}
  onclick={onToggle}
>
  <span class="ct-col ct-col--name">
    <span class="ct-indicator ct-indicator--{containerStatusColor(container.State)}"></span>
    <span class="ct-service-name">{container.Service || container.Name}</span>
  </span>
  <span class="ct-col ct-col--image ct-mono">{img.name}</span>
  <span class="ct-col ct-col--tag">
    <span class="tag-badge">{img.tag}</span>
  </span>
  <span class="ct-col ct-col--status">
    <span class="badge badge-{containerStatusColor(container.State)}">
      {container.State}
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
    <div class="detail-actions">
      <button class="btn btn-secondary btn-sm" onclick={(e) => { e.stopPropagation(); onStart(); }}>Start</button>
      <button class="btn btn-secondary btn-sm" onclick={(e) => { e.stopPropagation(); onStop(); }}>Stop</button>
      <button class="btn btn-secondary btn-sm" onclick={(e) => { e.stopPropagation(); onRestart(); }}>Restart</button>
    </div>
  </div>
{/if}

<style>
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

  .tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-size: 0.6875rem;
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

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-success {
    color: var(--color-success);
    background: var(--color-success-bg);
  }

  .badge-danger {
    color: var(--color-danger);
    background: var(--color-danger-bg);
  }

  .badge-warning {
    color: var(--color-warning);
    background: var(--color-warning-bg);
  }

  .badge-idle {
    color: var(--color-text-tertiary);
    background: var(--color-bg-tertiary);
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
    font-size: 0.6875rem;
    color: var(--color-text-tertiary);
  }

  .detail-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
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

  @media (max-width: 768px) {
    .ct-col--image {
      flex: 1 1 100%;
    }

    .detail-grid {
      grid-template-columns: 1fr;
    }

    .container-detail {
      padding-left: var(--space-4);
    }
  }
</style>
