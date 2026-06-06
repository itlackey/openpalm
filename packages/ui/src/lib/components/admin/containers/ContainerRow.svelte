<script lang="ts">
  import type { ServiceEntry } from '$lib/types.js';
  import { parseImageTag, containerStatusColor, fmtState } from './container-format.js';

  interface Props {
    entry: ServiceEntry;
    selected: boolean;
    onToggle: () => void;
  }

  let { entry, selected, onToggle }: Props = $props();

  let img = $derived(entry.docker ? parseImageTag(entry.docker.Image) : null);
</script>

<button
  class="container-table-row container-table-row--clickable"
  aria-expanded={selected}
  onclick={onToggle}
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
      {fmtState(entry.state)}
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

<style>
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

  @media (max-width: 768px) {
    .container-table-row {
      flex-wrap: wrap;
      gap: var(--space-1);
      padding: var(--space-3) var(--space-4);
    }
  }
</style>
