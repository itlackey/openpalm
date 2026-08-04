<script lang="ts">
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { resolveSessionTitle } from '$lib/session-title.js';
  import IconConversations from '$lib/components/icons/IconConversations.svelte';

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
  aria-label={`Conversation: ${triggerLabel}`}
  title={triggerLabel}
>
  <span class="icon-wrap" aria-hidden="true"><IconConversations class="trigger-icon" size={18} /></span>
  <span class="context">
    <span class="eyebrow">Conversation</span>
    <span class="value">
      <span class="dot" class:connected={liveConnected} aria-hidden="true"></span>
      <span class="label">{triggerLabel}</span>
    </span>
  </span>
  <span class="caret" aria-hidden="true">▾</span>
</button>

<style>
  /* Sized to SHRINK. The old fixed `width` plus a 52px height (exactly
     --nav-height, so flush with the navbar with nowhere for a border to go)
     meant the two pickers alone demanded ~560px and clipped rather than
     truncating, because .chat-locked hides overflow. Flexible width with
     min-width:0 lets the label ellipsize instead. */
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    padding: 0 var(--s-sp-3);
    min-width: 0;
    flex: 1 1 auto;
    height: 44px;
    background: none;
    border: var(--s-hair) solid transparent;
    border-radius: 8px;
    color: var(--s-ink-3);
    cursor: pointer;
    max-width: 304px;
    overflow: hidden;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .trigger:hover {
    color: var(--s-ink);
    border-color: var(--s-line);
    background: var(--s-paper-deep);
  }
  .trigger:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
  /* Open state speaks the same language as every other navbar control
     (IconButton marks "selected" with --s-seal in the FOREGROUND), rather than
     inventing a border-only accent for these two buttons alone. */
  .trigger.active {
    color: var(--s-seal);
    border-color: var(--s-line);
    background: var(--s-paper-deep);
  }
  .trigger.active .eyebrow,
  .trigger.active :global(.trigger-icon) {
    color: var(--s-seal);
  }

  .icon-wrap,
  :global(.trigger-icon) {
    flex-shrink: 0;
    color: var(--s-ink-3);
  }
  .icon-wrap {
    display: flex;
  }

  /* Dot: muted when disconnected, moss when connected/live */
  .dot {
    width: 6px;
    height: 6px;
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
    min-width: 0;
    overflow: hidden;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: 0.875rem;
    font-weight: 600;
  }
  /* `text-overflow` has no effect on a flex container, so the ellipsis has to
     live on the text's own element — without this the title is simply cut off
     mid-glyph. */
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
