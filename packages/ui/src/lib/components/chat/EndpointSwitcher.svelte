<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';
  import IconServer from '$lib/components/icons/IconServer.svelte';

  // Navbar trigger that opens the assistant-endpoint chooser in a drawer.
  // The list body itself lives in EndpointList, shared with the chat side panel.
  let open = $state(false);

  const active = $derived(endpointsService.active);

  // Fire-and-forget one-shot load — onMount, not $effect (it's not state sync and
  // has no reactive deps that should re-trigger it).
  onMount(() => {
    void endpointsService.load();
  });
</script>

<button
  type="button"
  class="trigger"
  onclick={() => (open = true)}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label={active ? `Assistant endpoint: ${active.label}` : 'Assistant endpoints'}
  title={active ? `Connected to: ${active.label} (${active.url})` : 'Assistant endpoints'}
  disabled={endpointsService.loading}
>
  <IconServer size={14} class="trigger-icon" />
  <span class="dot" aria-hidden="true"></span>
  <span class="label">{active?.label ?? 'Endpoint…'}</span>
  <span class="caret" aria-hidden="true">▾</span>
</button>

<Drawer open={open} title="Assistant endpoint" onClose={() => (open = false)} width="26rem">
  <EndpointList onChosen={() => (open = false)} />
</Drawer>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: 0 var(--s-sp-3);
    height: 32px;
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
</style>
