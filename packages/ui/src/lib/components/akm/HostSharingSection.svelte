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

  // Host AKM sharing — lets the assistant read (and optionally write back to) the
  // operator's personal stash on this host. Lifted out of the AKM megaform into
  // its own Knowledge sub-tab. Uses its own API (not the akm config save), so it
  // is fully self-contained.
  interface Props {
    tokenStored: boolean;
  }
  let { tokenStored }: Props = $props();

  let hostSharing = $state<HostAkmSharing | null>(null);
  let loading = $state(true);
  let hostBusy = $state(false);
  let hostImportProfiles = $state(true);

  async function loadHostSharing(): Promise<void> {
    loading = true;
    try {
      hostSharing = await fetchHostAkmSharing();
    } catch {
      hostSharing = null; // endpoint unavailable — hide the panel
    } finally {
      loading = false;
    }
  }

  async function toggleHostSharing(): Promise<void> {
    if (hostBusy) return;
    hostBusy = true;
    try {
      if (hostSharing?.sharing.enabled) {
        hostSharing = await disableHostAkmSharing();
        notifications.push('success', 'Host AKM sharing disabled. Restart the stack to apply.');
      } else {
        const res = await enableHostAkmSharing({ writable: true, importProfiles: hostImportProfiles });
        hostSharing = res;
        const imported = res.profilesImported?.length ? ` Imported: ${res.profilesImported.join(', ')}.` : '';
        notifications.push('success', `Host AKM sharing enabled.${imported} Takes effect on the assistant's next AKM run / stack restart.`);
      }
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to update host AKM sharing.');
    } finally {
      hostBusy = false;
    }
  }

  async function reimportHostProfiles(): Promise<void> {
    if (hostBusy) return;
    hostBusy = true;
    try {
      const res = await enableHostAkmSharing({ writable: true, importProfiles: true });
      hostSharing = res;
      const imported = res.profilesImported?.length ? res.profilesImported.join(', ') : 'none';
      notifications.push('success', `Re-imported host profiles: ${imported}.`);
    } catch (e) {
      notifications.push('error', e instanceof Error ? e.message : 'Failed to re-import host profiles.');
    } finally {
      hostBusy = false;
    }
  }

  onMount(() => { if (tokenStored) void loadHostSharing(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <h2>Host knowledge sharing</h2>
  </div>
  <div class="panel-body">
    {#if loading}
      <div class="hs-loading"><Spinner /> Checking host stash…</div>
    {:else if hostSharing === null}
      <p class="section-note">Host AKM sharing isn't available on this deployment.</p>
    {:else}
      <section class="config-section">
        <p class="section-note">
          Let the assistant read (and, on explicit request, contribute back to) your
          personal AKM stash on this machine (<code>~/akm</code>). Each side keeps its own
          primary stash, database, and cache — only the knowledge files are shared, as a
          writable secondary source. Your files' ownership and primary stash are never changed.
        </p>
        <p class="hs-restart">⚠ Changes take effect after the next stack restart.</p>

        {#if !hostSharing.sharing.available}
          <p class="section-note">
            <span class="badge badge-neutral">Not detected</span>
            No personal AKM was found on this host (<code>~/.config/akm/config.json</code>).
            Run <code>akm init</code> on this machine to enable sharing.
          </p>
        {:else}
          <div class="controls controls--grid">
            <div class="control-group control-group--wide">
              <span class="control-label">Status</span>
              <div class="host-akm-status">
                <span class="badge {hostSharing.sharing.enabled ? 'badge-enabled' : 'badge-disabled'}">
                  {hostSharing.sharing.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {#if hostSharing.sharing.hostStashPath}
                  <code class="host-akm-path">{hostSharing.sharing.hostStashPath}</code>
                {/if}
              </div>
            </div>
            {#if !hostSharing.sharing.enabled}
              <div class="control-group control-group--wide">
                <label class="control-label control-label--checkbox">
                  <input type="checkbox" bind:checked={hostImportProfiles} disabled={hostBusy} />
                  Also import host LLM/agent profiles (read-only snapshot)
                </label>
              </div>
            {/if}
            <div class="control-group control-group--wide host-akm-actions">
              <button class="btn btn-secondary btn-sm" onclick={() => void toggleHostSharing()} disabled={hostBusy || !tokenStored}>
                {#if hostBusy}<Spinner />{/if}
                {hostSharing.sharing.enabled ? 'Disable host sharing' : 'Enable host sharing'}
              </button>
              {#if hostSharing.sharing.enabled}
                <button class="btn btn-secondary btn-sm" onclick={() => void reimportHostProfiles()} disabled={hostBusy || !tokenStored}>
                  Re-import host profiles
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .panel-header { margin-bottom: var(--space-5); }
  .panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); }
  .config-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; max-width: 68ch; }
  .hs-restart { font-size: var(--text-sm); color: var(--color-badge-warning-fg); font-weight: var(--font-medium); margin: 0; }
  .hs-loading { display: flex; align-items: center; gap: var(--space-2); color: var(--color-text-secondary); font-size: var(--text-sm); }
  .controls--grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }
  .control-group { display: flex; flex-direction: column; gap: var(--space-2); }
  .control-label { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); }
  .control-label--checkbox { flex-direction: row; align-items: center; gap: var(--space-2); font-weight: var(--font-normal); }
  .host-akm-status { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .host-akm-path { font-size: var(--text-xs); color: var(--color-text-secondary); }
  .host-akm-actions { flex-direction: row; gap: var(--space-2); flex-wrap: wrap; }
</style>
