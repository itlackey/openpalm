<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import DeviceSettingsNav from '$lib/components/chrome/DeviceSettingsNav.svelte';
  import VoiceClientSettings from '$lib/components/voice/VoiceClientSettings.svelte';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
  import {
    buildAdvancedPath,
    buildChatPath,
    buildReturnToPath,
    currentChatSessionId,
    resolveReturnToPath,
  } from '$lib/chat/navigation.js';
  import { hasCapability } from '$lib/runtime-context.svelte.js';

  const fallbackChatHref = $derived.by(() => {
    const sessionId = currentChatSessionId();
    const assistantId = endpointsService.activeId || null;
    return advancedModeService.enabled
      ? buildAdvancedPath(sessionId, assistantId)
      : buildChatPath(sessionId, assistantId);
  });
  const chatReturnHref = $derived(
    resolveReturnToPath(page.url.searchParams.get('returnTo'), fallbackChatHref),
  );
  const hostSettingsHref = $derived(
    buildReturnToPath(`${resolve('/host')}?tab=addons&addon=voice`, chatReturnHref),
  );

  onMount(() => {
    advancedModeService.init();
    void endpointsService.load();
  });
</script>

<svelte:head>
  <title>Voice on this device - OpenPalm</title>
</svelte:head>

<Navbar brandHref={chatReturnHref} showUtilities={false} />
<DeviceSettingsNav active="voice" {chatReturnHref} />

<main class="page">
  <header class="page-header">
    <h1>Voice on this device</h1>
    <p class="lede">
      These browser-owned settings apply across all assistants you connect to from this device. They
      do not change an assistant or host configuration.
    </p>
    {#if hasCapability('host:stack:read')}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- return-aware host path starts from a resolved internal route -->
      <a class="host-settings-link" href={hostSettingsHref}>Voice service on this host</a>
    {/if}
  </header>

  <VoiceClientSettings />
</main>

<style>
  .page {
    box-sizing: border-box;
    width: 100%;
    max-width: 760px;
    min-width: 0;
    margin: 0 auto;
    padding: var(--s-sp-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }
  .page-header h1 {
    margin: 0 0 var(--s-sp-2);
  }
  .host-settings-link {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    min-width: 44px;
    width: fit-content;
    margin-top: var(--s-sp-3);
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    text-decoration: none;
  }
  .host-settings-link:hover {
    color: var(--s-ink);
    border-color: var(--s-ink-3);
  }
  .host-settings-link:focus-visible {
    outline: 2px solid var(--s-ink);
    outline-offset: 2px;
  }
  .lede {
    margin: 0;
    color: var(--s-ink-3);
  }

  @media (max-width: 480px) {
    .page {
      padding: var(--s-sp-3);
    }
  }
</style>
