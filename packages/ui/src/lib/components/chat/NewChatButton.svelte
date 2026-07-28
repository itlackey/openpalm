<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { buildConversationPath } from '$lib/chat/navigation.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import IconAdd from '$lib/components/icons/IconAdd.svelte';

  let starting = $state(false);
  async function newChat(): Promise<void> {
    if (starting || chat.sending) return;
    starting = true;
    try {
      const sessionId = await chat.startNewSession();
      if (!sessionId) return;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic mode-preserving path built internally
      await goto(buildConversationPath(page.url.pathname, sessionId, endpointsService.activeId));
    } finally {
      starting = false;
    }
  }
</script>

<IconButton
  icon={plus}
  ariaLabel="Start a new conversation"
  title="New conversation"
  disabled={starting || chat.sending}
  onclick={newChat}
/>

{#snippet plus()}
  <IconAdd size={18} />
{/snippet}
