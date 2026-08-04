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
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  /* min-width: 0 is load-bearing, not decoration. A flex item defaults to
     min-width: auto — its MIN-CONTENT width — so one unbreakable run of text
     in the thread (a path, a token, a URL) pushed this box wider than the
     viewport and every ancestor with it. On a phone that surfaced as content
     sheared off the right edge: the chat surface locks the document with
     overflow: hidden, so the overflowing text was clipped rather than
     reachable by scrolling. The messages themselves also wrap now (see
     .master-words / .you-words), but the flex chain must refuse to grow
     regardless of what any future child renders. */
  .conversation-frame-content {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    view-transition-name: chat-content;
  }
</style>
