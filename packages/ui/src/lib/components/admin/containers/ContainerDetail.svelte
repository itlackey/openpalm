<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  import type { ServiceEntry } from '$lib/types.js';
  import { parseImageTag, containerStatusColor, fmtState } from './container-format.js';

  type RowAction = 'start' | 'stop' | 'restart';

  interface Props {
    entry: ServiceEntry;
    actionInFlight: RowAction | null;
    confirmAction: RowAction | null;
    feedback: { type: 'success' | 'error'; message: string } | null;
    onRequestAction: (action: RowAction, e: MouseEvent) => void;
    onCancelConfirm: (e: MouseEvent) => void;
    onExecuteAction: (action: RowAction, e: MouseEvent) => void;
  }

  let {
    entry,
    actionInFlight,
    confirmAction,
    feedback,
    onRequestAction,
    onCancelConfirm,
    onExecuteAction
  }: Props = $props();

  let img = $derived(entry.docker ? parseImageTag(entry.docker.Image) : null);
  let isAnyActionInFlight = $derived(actionInFlight !== null);
  let isNotCreated = $derived(!entry.docker);
</script>

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
          <span class="badge badge-{containerStatusColor(container.State)}">{fmtState(container.State)}</span>
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

  {#if feedback}
    <div class="action-feedback action-feedback--{feedback.type}" role="status">
      {feedback.message}
    </div>
  {/if}

  {#if confirmAction}
    <div class="confirm-bar" role="alert">
      <span class="confirm-text">
        {confirmAction.charAt(0).toUpperCase() + confirmAction.slice(1)} <strong>{entry.service}</strong>?
      </span>
      <div class="confirm-actions">
        <button
          class="btn btn-danger btn-sm"
          onclick={(e) => onExecuteAction(confirmAction!, e)}
        >
          Confirm
        </button>
        <button
          class="btn btn-secondary btn-sm"
          onclick={(e) => onCancelConfirm(e)}
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <div class="detail-actions">
      {#if isNotCreated}
        <button class="btn btn-primary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => onRequestAction('start', e)}>
          {#if actionInFlight === 'start'}<Spinner size={12} />{/if}
          Start
        </button>
      {:else}
        <button class="btn btn-secondary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => onRequestAction('start', e)}>
          {#if actionInFlight === 'start'}<Spinner size={12} />{/if}
          Start
        </button>
        <button class="btn btn-danger btn-sm" disabled={isAnyActionInFlight} onclick={(e) => onRequestAction('stop', e)}>
          {#if actionInFlight === 'stop'}<Spinner size={12} />{/if}
          Stop
        </button>
        <button class="btn btn-secondary btn-sm" disabled={isAnyActionInFlight} onclick={(e) => onRequestAction('restart', e)}>
          {#if actionInFlight === 'restart'}<Spinner size={12} />{/if}
          Restart
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .container-detail {
    padding: var(--s-sp-4) var(--s-sp-6) var(--s-sp-4) calc(var(--s-sp-6) + 28px);
    background: var(--s-paper-deep);
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .detail-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-sp-3) var(--s-sp-6);
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .detail-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .detail-value {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .detail-mono {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-2);
    word-break: break-all;
  }

  .detail-digest {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-3);
  }

  .detail-actions {
    display: flex;
    gap: var(--s-sp-2);
    margin-top: var(--s-sp-4);
  }

  .detail-not-created {
    padding: var(--s-sp-2) 0;
  }

  .detail-not-created p {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .action-feedback {
    margin-top: var(--s-sp-3);
    padding: var(--s-sp-2) var(--s-sp-3);
    border-radius: 2px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }

  .action-feedback--success {
    color: var(--s-moss);
    border: var(--s-hair) solid var(--s-moss);
  }

  .action-feedback--error {
    color: var(--s-seal);
    border: var(--s-hair) solid var(--s-seal);
  }

  .confirm-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    margin-top: var(--s-sp-4);
    padding: var(--s-sp-3) var(--s-sp-4);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }

  .confirm-text {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }

  .confirm-actions {
    display: flex;
    gap: var(--s-sp-2);
    flex-shrink: 0;
  }

  @media (max-width: 768px) {
    .detail-grid {
      grid-template-columns: 1fr;
    }

    .container-detail {
      padding-left: var(--s-sp-4);
    }

    .confirm-bar {
      flex-direction: column;
      align-items: stretch;
    }

    .confirm-actions {
      justify-content: flex-end;
    }
  }
</style>
