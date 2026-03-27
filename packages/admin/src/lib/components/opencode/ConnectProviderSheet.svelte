<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import type { OpenCodeProviderSummary, OpenCodeAuthMethod } from '$lib/types.js';
  import ModalSheet from './ModalSheet.svelte';
  import ConnectDetailSheet from './ConnectDetailSheet.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
    onConnected: () => void;
  }

  let { open, onClose, onConnected }: Props = $props();

  type ConnectView =
    | { kind: 'picker'; filterQuery: string; category: string }
    | { kind: 'detail'; provider: ProviderEntry; filterQuery: string; category: string };

  type ProviderEntry = OpenCodeProviderSummary & { authMethods: OpenCodeAuthMethod[] };

  let view = $state<ConnectView>({ kind: 'picker', filterQuery: '', category: 'all' });
  let providers = $state<ProviderEntry[]>([]);
  let loading = $state(false);
  let error = $state('');

  $effect(() => {
    if (open) {
      view = { kind: 'picker', filterQuery: '', category: 'all' };
      void loadProviders();
    }
  });

  async function loadProviders() {
    loading = true;
    error = '';
    try {
      const token = getAdminToken() ?? '';
      const res = await fetch('/admin/opencode/providers', {
        headers: { 'x-admin-token': token, 'x-request-id': crypto.randomUUID(), 'x-requested-by': 'ui' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      providers = data.providers ?? [];
    } catch (e) {
      console.warn('[ConnectProviderSheet] Failed to load providers:', e);
      error = 'Failed to load providers. Is the assistant running?';
    } finally {
      loading = false;
    }
  }

  let filteredProviders = $derived.by(() => {
    let list = providers;
    if (view.kind === 'picker' && view.filterQuery) {
      const q = view.filterQuery.toLowerCase();
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
      );
    }
    return list;
  });

  function selectProvider(provider: ProviderEntry) {
    if (view.kind === 'picker') {
      view = { kind: 'detail', provider, filterQuery: view.filterQuery, category: view.category };
    }
  }

  function handleBack() {
    if (view.kind === 'detail') {
      view = { kind: 'picker', filterQuery: view.filterQuery, category: view.category };
    }
  }

  function handleConnected() {
    onConnected();
    onClose();
  }
</script>

{#if view.kind === 'picker'}
  <ModalSheet {open} wide title="Connect a Provider" {onClose}>
    {#snippet children()}
      <div class="form-field" style="margin-bottom: var(--space-4)">
        <input
          class="form-input"
          type="search"
          aria-label="Search providers"
          placeholder="Search providers..."
          bind:value={view.filterQuery}
        />
      </div>

      {#if loading}
        <p class="field-status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading providers...</p>
      {:else if error}
        <div class="feedback feedback--error" role="alert">
          {error}
          <button class="btn btn-sm btn-ghost" type="button" onclick={loadProviders}>Retry</button>
        </div>
      {:else if filteredProviders.length === 0}
        <p class="empty-state">No providers found.</p>
      {:else}
        <div class="provider-grid" aria-label="Available providers">
          {#each filteredProviders as provider (provider.id)}
            <button
              class="provider-card"
              class:provider-card--connected={provider.connected}
              type="button"
              aria-label="{provider.name}{provider.connected ? ' (connected)' : ''}"
              onclick={() => selectProvider(provider)}
            >
              <span style="font-weight: var(--font-semibold); font-size: var(--text-sm)"
                >{provider.name}</span
              >
              {#if provider.modelCount > 0}
                <span style="font-size: var(--text-xs); color: var(--color-text-tertiary)"
                  >{provider.modelCount} models</span
                >
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/snippet}
  </ModalSheet>
{:else if view.kind === 'detail'}
  <ConnectDetailSheet
    {open}
    provider={view.provider}
    onBack={handleBack}
    onConnected={handleConnected}
    {onClose}
  />
{/if}
