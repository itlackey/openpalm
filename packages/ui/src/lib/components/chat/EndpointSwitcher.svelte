<script lang="ts">
  import { onMount } from 'svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import EndpointList from '$lib/components/chat/EndpointList.svelte';

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
  <!-- server icon (Lucide) -->
  <svg class="trigger-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
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
    gap: var(--space-2);
    padding: 0 var(--space-3);
    height: 40px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
  }
  .trigger:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
  .trigger:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .trigger-icon {
    display: none;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-success, #16a34a);
    flex-shrink: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }

  .caret {
    font-size: 10px;
    opacity: 0.6;
  }
</style>
