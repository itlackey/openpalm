<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import ChatNavbar from './ChatNavbar.svelte';

  type Props = {
    children?: Snippet;
    footer?: Snippet;
    drawerOpen?: boolean;
    showConversationControls?: boolean;
  };

  let {
    children,
    footer,
    drawerOpen = $bindable(false),
    showConversationControls = true,
  }: Props = $props();

  onMount(() => {
    document.documentElement.classList.add('chat-locked');
    document.body.classList.add('chat-locked');

    return () => {
      document.documentElement.classList.remove('chat-locked');
      document.body.classList.remove('chat-locked');
    };
  });
</script>

<div class="conversation-frame">
  <ChatNavbar bind:drawerOpen {showConversationControls} />
  <div class="conversation-frame-content">
    {@render children?.()}
  </div>
  {@render footer?.()}
</div>

<style>
  .conversation-frame {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
  }

  .conversation-frame-content {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1;
    view-transition-name: chat-content;
  }
</style>
