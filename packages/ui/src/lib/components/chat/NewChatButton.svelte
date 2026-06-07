<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import IconButton from '$lib/components/common/IconButton.svelte';

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

<IconButton
  icon={plus}
  ariaLabel="Start a new chat"
  title="New chat"
  disabled={starting}
  onclick={newChat}
/>

{#snippet plus()}
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5v14" /><path d="M5 12h14" />
  </svg>
{/snippet}
