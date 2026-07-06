<script lang="ts">
  import type { ServiceEntry } from '$lib/types.js';
  import { parseImageTag, containerStatusColor, fmtState } from './container-format.js';
  import IconExpand from '@openpalm/ui-kit/components/icons/IconExpand.svelte';

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
    <IconExpand size={14} class={selected ? 'ct-chevron-open' : ''} />
  </span>
</button>

<style>
  .ct-service-name {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    color: var(--s-ink);
  }

  .ct-mono {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-2);
  }

  .ct-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .ct-indicator--success {
    background: var(--s-moss);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--s-moss) 20%, transparent);
  }

  .ct-indicator--danger {
    background: var(--s-seal);
  }

  .ct-indicator--warning {
    background: var(--s-seal);
  }

  .ct-indicator--idle {
    background: var(--s-ink-3);
  }

  .ct-chevron-open {
    transform: rotate(180deg);
  }

  .ct-not-created {
    color: var(--s-ink-3);
    font-style: italic;
  }

  .container-table-row {
    display: flex;
    align-items: center;
    padding: var(--s-sp-3) var(--s-sp-6);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    font-size: var(--s-type-deed);
    width: 100%;
    background: none;
    border-left: none;
    border-right: none;
    border-top: none;
    font-family: var(--s-font-display);
    color: var(--s-ink);
    text-align: left;
  }

  .container-table-row:last-child {
    border-bottom: none;
  }

  .container-table-row--clickable {
    cursor: pointer;
  }

  .container-table-row--clickable:hover {
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
  }

  .container-table-row--clickable:focus-visible {
    outline: var(--s-hair) solid var(--s-ink-2);
    outline-offset: -2px;
  }

  @media (max-width: 768px) {
    .container-table-row {
      flex-wrap: wrap;
      gap: var(--s-sp-1);
      padding: var(--s-sp-3) var(--s-sp-4);
    }
  }
</style>
