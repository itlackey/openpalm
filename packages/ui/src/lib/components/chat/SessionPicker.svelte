<script lang="ts">
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import SessionList from '$lib/components/chat/SessionList.svelte';

  // Navbar trigger that opens the session chooser in a drawer. The list body
  // lives in SessionList, shared with the chat side panel.
  let open = $state(false);

  const active = $derived(endpointsService.active);
  const endpointState = $derived(active ? (chat.byEndpoint.get(active.id) ?? null) : null);
  const sessions = $derived(endpointState?.sessions ?? []);
  const activeSessionId = $derived(chat.activeSessionId);
  const liveConnected = $derived(chat.liveConnected);

  const activeSummary = $derived(sessions.find((s) => s.id === activeSessionId) ?? null);
  const triggerLabel = $derived(
    activeSummary ? activeSummary.title || 'Untitled session' : 'New session'
  );
</script>

<button
  type="button"
  class="trigger"
  onclick={() => (open = true)}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-label="Sessions"
  title={triggerLabel}
>
  <!-- messages-square (Lucide) -->
  <svg class="trigger-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </svg>
  <span
    class="dot"
    class:connected={liveConnected}
    aria-hidden="true"
    title={liveConnected ? 'Live updates connected' : 'Live updates disconnected'}
  ></span>
  <span class="label">{triggerLabel}</span>
  <span class="caret" aria-hidden="true">▾</span>
</button>

<Drawer
  open={open}
  title="Sessions on {active?.label ?? 'this endpoint'}"
  onClose={() => (open = false)}
  width="26rem"
>
  <SessionList onChosen={() => (open = false)} />
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
  .trigger:hover {
    background: var(--color-surface-hover);
  }

  .trigger-icon {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text-tertiary);
    flex-shrink: 0;
    transition: background 120ms ease;
  }
  .dot.connected {
    background: var(--color-success, #16a34a);
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
