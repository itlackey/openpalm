<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import IconButton from '@openpalm/ui-kit/components/common/IconButton.svelte';
  import IconAdd from '@openpalm/ui-kit/components/icons/IconAdd.svelte';

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
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- internal chat path with a query string, not a static route id
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
  <IconAdd size={18} />
{/snippet}
