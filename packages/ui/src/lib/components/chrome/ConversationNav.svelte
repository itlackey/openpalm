<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import IconButton from '$lib/components/common/IconButton.svelte';
  import IconChat from '$lib/components/icons/IconChat.svelte';
  import IconTerminal from '$lib/components/icons/IconTerminal.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath } from '$lib/conversation-paths.js';

  type Props = {
    conversationHref?: string;
    sessionId?: string | null;
    assistantId?: string | null;
  };

  let {
    conversationHref,
    sessionId = null,
    assistantId = null,
  }: Props = $props();

  const pathname = $derived(page.url?.pathname ?? '');
  const onChat = $derived(pathname === '/chat' || pathname.startsWith('/chat/'));
  const onAdvanced = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));
  const onConversationSurface = $derived(onChat || onAdvanced);
  const conversationContext = $derived.by(() => {
    if (!conversationHref) return null;
    try {
      const target = new URL(conversationHref, 'http://openpalm.invalid');
      if (target.pathname !== '/chat' && target.pathname !== '/advanced') return null;
      return target;
    } catch {
      return null;
    }
  });
  const contextSessionId = $derived(
    conversationContext?.searchParams.get('session') ?? sessionId
  );
  const contextAssistantId = $derived(
    conversationContext?.searchParams.get('assistant') ?? assistantId
  );
  const chatHref = $derived(
    buildChatPath(
      onConversationSurface ? sessionId : contextSessionId,
      onConversationSurface
        ? page.url.searchParams.get('assistant') ?? assistantId
        : contextAssistantId
    )
  );
  const advancedHref = $derived(
    buildAdvancedPath(
      onConversationSurface
        ? page.url.searchParams.get('session') ?? sessionId
        : contextSessionId,
      onConversationSurface
        ? page.url.searchParams.get('assistant') ?? assistantId
        : contextAssistantId
    )
  );

  onMount(() => {
    advancedModeService.init();
  });

  function navigate(event: MouseEvent, advanced: boolean, target: string, current: boolean): void {
    advancedModeService.setEnabled(advanced);
    if (current) {
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (typeof document !== 'undefined' && 'startViewTransition' in document) {
      event.preventDefault();
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- target is built by typed internal navigation helpers
      document.startViewTransition(() => goto(target));
    }
  }
</script>

<div class="conversation-nav" role="group" aria-label="Conversation views">
  <IconButton
    href={chatHref}
    selected={onChat}
    ariaCurrent={onChat ? 'page' : undefined}
    onclick={(event) => navigate(event, false, chatHref, onChat)}
    icon={chatIcon}
    ariaLabel="Chat"
    title="Chat"
  />
  <IconButton
    href={advancedHref}
    selected={onAdvanced}
    ariaCurrent={onAdvanced ? 'page' : undefined}
    onclick={(event) => navigate(event, true, advancedHref, onAdvanced)}
    icon={advancedIcon}
    ariaLabel="Advanced"
    title="Advanced"
  />
</div>

{#snippet chatIcon()}
  <IconChat size={18} />
{/snippet}

{#snippet advancedIcon()}
  <IconTerminal size={18} />
{/snippet}

<style>
  .conversation-nav {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
  }
</style>
