<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import IconServer from '$lib/components/icons/IconServer.svelte';

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
  aria-label={active ? `Assistant: ${active.label}` : 'Choose assistant'}
  title={active ? `Connected to: ${active.label} (${active.url})` : 'Assistant endpoints'}
  disabled={endpointsService.loading}
>
  <span class="icon-wrap" aria-hidden="true"><IconServer size={18} class="trigger-icon" /></span>
  <span class="context">
    <span class="eyebrow">Assistant</span>
    <span class="value"><span class="dot" aria-hidden="true"></span>{active?.label ?? 'Choose assistant'}</span>
  </span>
  <span class="caret" aria-hidden="true">▾</span>
</button>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: 0 var(--s-sp-3);
    min-width: 44px;
    height: 52px;
    background: color-mix(in srgb, var(--s-paper-deep) 52%, transparent);
    border: var(--s-hair) solid transparent;
    border-radius: 8px;
    color: var(--s-ink-3);
    cursor: pointer;
    width: clamp(180px, 17vw, 248px);
    max-width: 248px;
    overflow: hidden;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .trigger:hover:not(:disabled) {
    color: var(--s-ink);
    border-color: var(--s-line-soft);
    background: var(--s-paper-deep);
  }
  .trigger:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  .trigger:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .trigger.active {
    border-color: var(--s-seal);
    background: var(--s-paper-deep);
  }

  .icon-wrap,
  :global(.trigger-icon) {
    flex-shrink: 0;
    color: var(--s-ink-3);
  }
  .icon-wrap {
    display: flex;
  }

  /* Moss dot = connected/active */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--s-moss);
    flex-shrink: 0;
  }

  .context {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    text-align: left;
  }
  .eyebrow {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
    line-height: 1.2;
  }
  .value {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .caret {
    font-size: 0.75rem;
    opacity: 0.5;
  }

  @media (max-width: 999px) {
    .trigger {
      width: 100%;
      max-width: none;
      height: 56px;
      border: var(--s-hair) solid transparent;
      border-top-color: var(--s-line-soft);
      border-right-color: var(--s-line-soft);
      border-radius: 0;
      background: transparent;
    }
  }

  @media (max-width: 479px) {
    .trigger {
      height: 44px;
      min-height: 44px;
    }
  }
</style>
