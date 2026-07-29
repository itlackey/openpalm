<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHostAkmSharing,
    enableHostAkmSharing,
    disableHostAkmSharing,
    type HostAkmSharing,
  } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import Spinner from '$lib/components/common/Spinner.svelte';

  let hostSharing = $state<HostAkmSharing | null>(null);
  let loading = $state(true);
  let busy = $state(false);

  async function loadHostSharing(): Promise<void> {
    loading = true;
    try {
      hostSharing = await fetchHostAkmSharing();
    } catch {
      hostSharing = null;
    } finally {
      loading = false;
    }
  }

  async function toggleHostSharing(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (hostSharing?.enabled) {
        hostSharing = await disableHostAkmSharing();
        notifications.push('success', 'Host stash sharing disabled. Restart the stack to apply.');
      } else {
        const res = await enableHostAkmSharing();
        hostSharing = res;
        const imported = res.profilesImported?.length
          ? ` Imported host profiles: ${res.profilesImported.join(', ')}.`
          : '';
        notifications.push('success', `Host stash sharing enabled.${imported} Restart the stack to apply.`);
      }
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to update host stash sharing.');
    } finally {
      busy = false;
    }
  }

  onMount(() => { void loadHostSharing(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Host knowledge sharing</h2>
  </div>
  <div class="panel-body">
    {#if loading}
      <div class="hs-loading"><Spinner /> Checking host stash…</div>
    {:else if hostSharing === null}
      <p class="section-note">Host stash sharing isn't available on this deployment.</p>
    {:else}
      <section class="config-section">
        <p class="section-note">
          Mount your personal AKM stash (<code>{hostSharing.hostStashPath}</code>) into the
          assistant as a readable secondary source. Enabling also imports your host LLM and
          agent connection profiles so the assistant can use the same providers you have
          configured locally.
        </p>

        <div class="controls">
          <div class="status-row">
            <span class="badge {hostSharing.enabled ? 'badge-enabled' : 'badge-disabled'}">
              {hostSharing.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <code class="host-path">{hostSharing.hostStashPath}</code>
          </div>
          <button
            class="btn btn-secondary btn-sm"
            onclick={() => void toggleHostSharing()}
            disabled={busy}
          >
            {#if busy}<Spinner />{/if}
            {hostSharing.enabled ? 'Disable host sharing' : 'Enable host sharing'}
          </button>
          <p class="hint">Takes effect after the next stack restart.</p>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .panel-header { margin-bottom: var(--s-sp-5); }
  .panel-header h2 {
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    font-weight: 400;
    color: var(--s-ink);
  }
  .config-section { display: flex; flex-direction: column; gap: var(--s-sp-3); }
  .section-note {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
    max-width: 68ch;
    line-height: 1.5;
  }
  .hs-loading {
    display: flex; align-items: center; gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-3);
  }
  .controls { display: flex; flex-direction: column; gap: var(--s-sp-3); }
  .status-row { display: flex; align-items: center; gap: var(--s-sp-3); flex-wrap: wrap; }
  .host-path {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
  }
  .hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }
</style>
