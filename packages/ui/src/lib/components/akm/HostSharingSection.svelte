<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHostAkmSharing,
    enableHostAkmSharing,
    disableHostAkmSharing,
    fetchHostAkmConfigStatus,
    importHostAkmConfig,
    type HostAkmSharing,
    type HostAkmConfigStatus,
  } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import Spinner from '$lib/components/common/Spinner.svelte';

  let hostSharing = $state<HostAkmSharing | null>(null);
  // Importing the host's akm engine config is a SEPARATE, manual action from
  // mounting the host stash. It used to ride along with the stash toggle,
  // which is how an operator who wanted shared knowledge silently got the
  // host's engine config — and, when the two akm versions disagreed, a broken
  // assistant. Same shape as importing host OpenCode providers.
  let hostConfig = $state<HostAkmConfigStatus | null>(null);
  let importing = $state(false);
  let loading = $state(true);
  let busy = $state(false);

  async function loadHostSharing(): Promise<void> {
    loading = true;
    try {
      hostSharing = await fetchHostAkmSharing();
    } catch {
      hostSharing = null;
    }
    try {
      hostConfig = await fetchHostAkmConfigStatus();
    } catch {
      // Advisory affordance: if we cannot read the host, offer nothing rather
      // than an error the operator can do nothing with.
      hostConfig = null;
    } finally {
      loading = false;
    }
  }

  async function runHostAkmImport(): Promise<void> {
    if (importing) return;
    importing = true;
    try {
      const result = await importHostAkmConfig();
      if (!result.changed) {
        notifications.push('success', 'Nothing to import — the assistant already has these settings.');
      } else {
        const what = result.imported.join(', ');
        notifications.push(
          'success',
          result.verified
            ? `Imported ${what} from your host akm config.`
            : `Imported ${what}. The assistant is not running, so it will apply on next start.`,
        );
      }
    } catch (e) {
      // The route rolls back on an unloadable config and returns akm's own
      // message, so this is worth showing verbatim.
      notifications.push('error', e instanceof Error ? e.message : 'Host akm import failed.');
    } finally {
      importing = false;
    }
  }

  async function toggleHostSharing(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (hostSharing?.enabled) {
        hostSharing = await disableHostAkmSharing();
        notifications.push('success', 'Host stash sharing disabled.');
      } else {
        hostSharing = await enableHostAkmSharing();
        notifications.push('success', 'Host stash sharing enabled.');
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
          assistant as a readable secondary source.
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
        </div>
      </section>

      {#if hostConfig?.available}
        <!-- Separate from the stash mount on purpose. Sharing a knowledge
             directory and adopting the host's engine configuration are two
             different decisions; bundling them is what silently replaced an
             operator's assistant config in the first place. -->
        <section class="config-section">
          <h3 class="subsection-title">Use your local AKM configuration</h3>
          <p class="section-note">
            Copy the engines and embedding connection from your own akm config
            (<code>{hostConfig.configPath}</code>) so the assistant uses the same
            providers you already run locally. Your existing assistant settings win —
            this only fills in what is missing, and your host config is never modified.
          </p>
          <div class="controls">
            <span class="hs-summary">
              {hostConfig.engineCount}
              {hostConfig.engineCount === 1 ? 'engine' : 'engines'}{hostConfig.hasEmbedding
                ? ' + embedding'
                : ''} available
            </span>
            <button
              class="btn btn-secondary btn-sm"
              onclick={() => void runHostAkmImport()}
              disabled={importing}
            >
              {#if importing}<Spinner />{/if}
              Import from host
            </button>
          </div>
        </section>
      {/if}
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
  .subsection-title {
    margin: 0 0 var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-ink);
  }

  .hs-summary {
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }

  .host-path {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
  }
</style>
