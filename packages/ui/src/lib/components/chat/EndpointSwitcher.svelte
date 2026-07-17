<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import IconServer from '@openpalm/ui-kit/components/icons/IconServer.svelte';

  interface Props {
    open: boolean;
    controls: string;
    onToggle: () => void;
  }
  let { open, controls, onToggle }: Props = $props();

  const active = $derived(endpointsService.active);

  onMount(() => {
    void endpointsService.load();
  });
</script>

<button
  type="button"
  class="trigger"
  class:active={open}
  onclick={onToggle}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={controls}
  aria-label="Assistant"
  title={active ? `Connected to: ${active.label} (${active.url})` : 'Assistant endpoints'}
  disabled={endpointsService.loading}
>
  <IconServer size={18} class="trigger-icon" />
  <span class="dot" aria-hidden="true"></span>
  <span class="label">{active?.label ?? 'Assistant'}</span>
  <span class="caret" aria-hidden="true">▾</span>
</button>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: 0 var(--s-sp-3);
    min-width: 44px;
    height: 44px;
    background: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .trigger:hover:not(:disabled) {
    color: var(--s-ink-2);
    border-color: var(--s-line);
  }
  .trigger:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: 2px;
  }
  .trigger:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .trigger.active {
    color: var(--s-seal);
    border-color: var(--s-seal);
  }

  :global(.trigger-icon) {
    flex-shrink: 0;
    color: var(--s-ink-3);
  }

  /* Moss dot = connected/active */
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--s-moss);
    flex-shrink: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }

  .caret {
    font-size: 9px;
    opacity: 0.5;
  }

  @media (max-width: 720px) {
    .trigger {
      width: 44px;
      padding: 0;
      justify-content: center;
      border-color: transparent;
    }
    .label,
    .dot,
    .caret {
      display: none;
    }
  }
</style>
