<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import Drawer from '$lib/components/common/Drawer.svelte';
  import IconActivity from '$lib/components/icons/IconActivity.svelte';
  import ToolLog from '$lib/components/chat/ToolLog.svelte';
  import { chat } from '$lib/chat/chat-state.svelte.js';

  interface Props {
    drawerOpen?: boolean;
    railOpen?: boolean;
    conversationTitle: string;
    connectionLabel: string;
  }

  let {
    drawerOpen = $bindable(false),
    railOpen = $bindable(true),
    conversationTitle,
    connectionLabel
  }: Props = $props();

  const DRAWER_ID = 'conversation-activity-drawer';
  const RAIL_ID = 'conversation-activity-rail';
  let drawerShowing = $state(false);
  let wideLayout = $state(false);
  const usesRail = $derived(wideLayout && chat.toolLog.length > 0 && !drawerShowing);

  onMount(() => {
    const layout = window.matchMedia('(min-width: 1101px)');
    const updateLayout = (): void => {
      wideLayout = layout.matches;
      if (wideLayout && drawerShowing) closeDrawer();
    };
    updateLayout();
    layout.addEventListener('change', updateLayout);
    return () => layout.removeEventListener('change', updateLayout);
  });

  function toggleActivity(): void {
    if (usesRail) {
      railOpen = !railOpen;
      return;
    }
    if (drawerOpen && !drawerShowing) return;
    if (drawerShowing) {
      closeDrawer();
      return;
    }
    drawerOpen = true;
    drawerShowing = true;
  }

  function closeDrawer(): void {
    drawerShowing = false;
  }

  function finishDrawerClose(): void {
    drawerOpen = false;
  }

  // Close the activity drawer on navigation so it never lingers modal over the
  // navigated-to content (#473); a same-route session change does not remount.
  afterNavigate(() => {
    if (drawerOpen || drawerShowing) {
      drawerShowing = false;
      drawerOpen = false;
    }
  });
</script>

<button
  type="button"
  class="activity-trigger"
  class:active={usesRail ? railOpen : drawerShowing}
  aria-label={`Activity for ${conversationTitle}`}
  title={`Activity for ${conversationTitle}`}
  aria-haspopup={usesRail ? undefined : 'dialog'}
  aria-expanded={usesRail ? railOpen : drawerShowing}
  aria-controls={usesRail
    ? railOpen
      ? RAIL_ID
      : undefined
    : drawerShowing
      ? DRAWER_ID
      : undefined}
  inert={drawerOpen}
  onclick={toggleActivity}
>
  <IconActivity size={18} />
</button>

<Drawer
  id={DRAWER_ID}
  open={drawerShowing}
  title="Activity"
  onClose={closeDrawer}
  onClosed={finishDrawerClose}
  deferFocusRestore
  side="left"
  width="27rem"
>
  <div class="activity-panel">
    <div class="context-card">
      <span class="context-label">Current conversation</span>
      <strong>{conversationTitle}</strong>
      <span>{connectionLabel}</span>
    </div>
    {#if chat.toolLog.length > 0}
      <ToolLog items={chat.toolLog} showHeading={false} />
    {:else}
      <div class="empty-state">
        <span class="empty-icon"><IconActivity size={24} /></span>
        <strong>No activity yet</strong>
        <span>Tool and task activity for this conversation will appear here.</span>
      </div>
    {/if}
  </div>
</Drawer>

<style>
  .activity-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 99px;
    background: none;
    color: var(--s-ink-3);
    cursor: pointer;
  }
  .activity-trigger:hover,
  .activity-trigger.active {
    color: var(--s-seal);
  }
  .activity-trigger:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 1px;
  }
  .activity-panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-5);
  }
  .context-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-4);
    border-radius: 10px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    font-size: 0.8125rem;
    line-height: 1.45;
  }
  .context-card strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .context-label {
    color: var(--s-ink-3);
    font-family: var(--s-font-mono);
    font-size: 0.75rem;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-sp-2);
    padding: var(--s-sp-5);
    border: var(--s-hair) dashed var(--s-line-soft);
    border-radius: 10px;
    color: var(--s-ink-2);
    font-size: 0.875rem;
  }
  .empty-state strong {
    color: var(--s-ink);
    font-size: 1rem;
  }
  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 8px;
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
  }
</style>
