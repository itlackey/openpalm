<script lang="ts">
  import ModeSwitch from '$lib/components/chrome/ModeSwitch.svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';

  // Chat content toolbar. The global controls (assistant, session, mic, speaker)
  // live in the navbar; this strip carries the page-contextual bits: the
  // Chat↔Advanced mode switch and a prominent New-chat action.
  let starting = $state(false);
  async function newChat(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      await chat.startNewSession();
    } finally {
      starting = false;
    }
  }
</script>

<div class="chat-toolbar">
  <ModeSwitch />
  <button
    type="button"
    class="new-chat"
    onclick={newChat}
    disabled={starting}
    aria-label="Start a new chat"
    title="New chat"
  >
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
    <span class="new-chat-label">New chat</span>
  </button>
</div>

<style>
  .chat-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    flex-wrap: wrap;
  }

  .new-chat {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 36px;
    flex-shrink: 0;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .new-chat:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }
  .new-chat:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .new-chat:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .new-chat svg {
    flex-shrink: 0;
  }

  @media (max-width: 480px) {
    .chat-toolbar {
      padding: var(--space-2) var(--space-3);
    }
  }
</style>
