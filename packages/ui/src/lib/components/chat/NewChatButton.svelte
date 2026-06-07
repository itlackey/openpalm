<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat/chat-state.svelte.js';

  // Global "new chat" action (lives in the navbar next to the session picker).
  // On the chat page it starts a fresh session in place; from anywhere else
  // (e.g. admin) it routes to /chat and the chat page starts the new session
  // once it has loaded (?new=1 handshake).
  const onChat = $derived(
    (page.url?.pathname ?? '') === '/chat' || (page.url?.pathname ?? '').startsWith('/chat/')
  );

  let starting = $state(false);
  async function newChat(): Promise<void> {
    if (starting) return;
    starting = true;
    try {
      if (onChat) {
        await chat.startNewSession();
      } else {
        await goto('/chat?new=1');
      }
    } finally {
      starting = false;
    }
  }
</script>

<button
  type="button"
  class="newchat-btn"
  onclick={newChat}
  disabled={starting}
  aria-label="Start a new chat"
  title="New chat"
>
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5v14" /><path d="M5 12h14" />
  </svg>
</button>

<style>
  /* Icon-only square button, matching the navbar theme/voice/gear controls. */
  .newchat-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: none;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    cursor: pointer;
    transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
  }
  .newchat-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }
  .newchat-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .newchat-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .newchat-btn svg {
    flex-shrink: 0;
  }
</style>
