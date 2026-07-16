<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import ModeSwitch from '$lib/components/chrome/ModeSwitch.svelte';
  import EndpointSwitcher from '$lib/components/chat/EndpointSwitcher.svelte';
  import SessionPicker from '$lib/components/chat/SessionPicker.svelte';
  import VoiceControl from '$lib/components/chat/VoiceControl.svelte';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import { buildAdvancedPath, buildChatPath, currentChatSessionId } from '$lib/chat/navigation.js';

  // Chat-surface chrome COMPOSITION (#555): the Navbar shell plus the global chat controls —
  //   - assistant switcher (EndpointSwitcher)
  //   - session picker (SessionPicker)
  //   - mic + speaker (VoiceControl) — VoiceControl.initVoice() runs here so
  //     STT and TTS work across the surfaces that mount this chrome. Do not
  //     move it into a page-scoped toolbar.
  // The admin surface mounts the shell directly and must stay free of these
  // chat imports; only conversation-adjacent surfaces (/advanced,
  // /connections) mount this composition. (/chat renders its own corner
  // chrome and hides the navbar entirely.)
  const pathname = $derived(page.url?.pathname ?? '');
  // The chat selectors appear only on the conversation surfaces; on
  // /connections the page itself is the switcher.
  const onConversationSurface = $derived(
    pathname === '/chat' ||
    pathname.startsWith('/chat/') ||
    pathname === '/advanced' ||
    pathname.startsWith('/advanced/')
  );

  const preferredChatHref = $derived.by(() => {
    const sessionId = page.url.searchParams.get('session') ?? currentChatSessionId();
    return advancedModeService.enabled ? buildAdvancedPath(sessionId) : buildChatPath(sessionId);
  });

  onMount(() => {
    advancedModeService.init();
  });
</script>

<Navbar brandHref={preferredChatHref}>
  {#if onConversationSurface}
    <!-- Hidden ≥1024px: the chat side panel hosts these selectors there. -->
    <span class="chat-selectors">
      <EndpointSwitcher />
      <SessionPicker />
    </span>
  {/if}
  <ModeSwitch />
  <VoiceControl />
</Navbar>

<style>
  /* The assistant + session selectors live in the navbar only below 1024px;
     at wider widths the chat side panel hosts them, so hide the triggers. */
  .chat-selectors {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
  }
  @media (min-width: 1024px) {
    .chat-selectors {
      display: none;
    }
  }
</style>
