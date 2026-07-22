<script lang="ts">
  import IconButton from '@openpalm/ui-kit/components/common/IconButton.svelte';
  import IconServer from '@openpalm/ui-kit/components/icons/IconServer.svelte';
  import IconSettings from '@openpalm/ui-kit/components/icons/IconSettings.svelte';
  import ConversationNav from '$lib/components/chrome/ConversationNav.svelte';

  type Props = {
    settingsHref: string;
    hostHref?: string | null;
    conversationHref?: string;
    settingsCurrent?: boolean;
    hostCurrent?: boolean;
    compact?: boolean;
    modeSessionId?: string | null;
    modeAssistantId?: string | null;
  };

  let {
    settingsHref,
    hostHref,
    conversationHref,
    settingsCurrent = false,
    hostCurrent = false,
    compact = false,
    modeSessionId,
    modeAssistantId,
  }: Props = $props();
</script>

<div class="surface-toolbar" class:compact>
  <ConversationNav
    {conversationHref}
    sessionId={modeSessionId}
    assistantId={modeAssistantId}
  />
  <!-- eslint-disable svelte/no-navigation-without-resolve -- caller supplies resolved internal destinations with return context -->
  <IconButton
    href={settingsHref}
    selected={settingsCurrent}
    ariaCurrent={settingsCurrent ? 'page' : undefined}
    icon={settingsIcon}
    ariaLabel="Open settings"
    title="Settings"
  />
  {#if hostHref}
    <IconButton
      href={hostHref}
      selected={hostCurrent}
      ariaCurrent={hostCurrent ? 'page' : undefined}
      icon={hostIcon}
      ariaLabel="Open host console"
      title="Host"
    />
  {/if}
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
</div>

{#snippet settingsIcon()}
  <IconSettings size={18} />
{/snippet}

{#snippet hostIcon()}
  <IconServer size={18} />
{/snippet}

<style>
  .surface-toolbar {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    min-width: 0;
    height: 52px;
    margin-left: auto;
  }
  @media (max-width: 999px) {
    .surface-toolbar:not(.compact) {
      order: 1;
      width: 100%;
      padding-left: 210px;
      padding-right: var(--s-sp-5);
      justify-content: flex-end;
    }
    .surface-toolbar.compact {
      width: auto;
    }
  }

  @media (max-width: 720px) {
    .surface-toolbar:not(.compact) {
      padding-left: 132px;
      padding-right: var(--s-sp-2);
    }
  }

  @media (max-width: 480px) {
    .surface-toolbar {
      gap: 0;
    }
    .surface-toolbar:not(.compact) {
      padding-right: var(--s-sp-1);
    }
  }
</style>
