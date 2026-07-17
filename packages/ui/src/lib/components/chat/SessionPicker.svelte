<script lang="ts">
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { resolveSessionTitle } from '$lib/session-title.js';
  import IconConversations from '@openpalm/ui-kit/components/icons/IconConversations.svelte';

  interface Props {
    open: boolean;
    controls: string;
    onToggle: () => void;
  }
  let { open, controls, onToggle }: Props = $props();

  const active = $derived(endpointsService.active);
  const endpointState = $derived(active ? (chat.byEndpoint.get(active.id) ?? null) : null);
  const sessions = $derived(endpointState?.sessions ?? []);
  const activeSessionId = $derived(chat.activeSessionId);
  const liveConnected = $derived(chat.liveConnected);

  const activeSummary = $derived(sessions.find((s) => s.id === activeSessionId) ?? null);
  const triggerLabel = $derived(
    activeSummary ? resolveSessionTitle(activeSummary.title) : 'New session'
  );
</script>

<button
  type="button"
  class="trigger"
  class:active={open}
  onclick={onToggle}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={controls}
  aria-label="Conversation"
  title={triggerLabel}
>
  <IconConversations class="trigger-icon" size={18} />
  <span
    class="dot"
    class:connected={liveConnected}
    aria-hidden="true"
    title={liveConnected ? 'Live updates connected' : 'Live updates disconnected'}
  ></span>
  <span class="label">{triggerLabel}</span>
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
  .trigger:hover {
    color: var(--s-ink-2);
    border-color: var(--s-line);
  }
  .trigger:focus-visible {
    outline: var(--s-hair) solid var(--s-line);
    outline-offset: 2px;
  }
  .trigger.active {
    color: var(--s-seal);
    border-color: var(--s-seal);
  }

  :global(.trigger-icon) {
    flex-shrink: 0;
    color: var(--s-ink-3);
  }

  /* Dot: muted when disconnected, moss when connected/live */
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--s-ink-3);
    flex-shrink: 0;
    transition: background 120ms ease;
    opacity: 0.5;
  }
  .dot.connected {
    background: var(--s-moss);
    opacity: 1;
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
