<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import type { OpenCodeProviderSummary } from '$lib/types.js';
  import ModalSheet from './ModalSheet.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  type ModelEntry = { id: string; name: string; family: string; status: string };

  type ProviderWithModels = {
    id: string;
    name: string;
    models: ModelEntry[];
  };

  let providers = $state<ProviderWithModels[]>([]);
  let filterQuery = $state('');
  let loading = $state(false);
  let error = $state('');
  let currentModel = $state('');
  let selectedModel = $state('');
  let saving = $state(false);
  let saveSuccess = $state('');
  let closeTimeout: ReturnType<typeof setTimeout> | null = $state(null);

  function clearCloseTimeout() {
    if (closeTimeout !== null) {
      clearTimeout(closeTimeout);
      closeTimeout = null;
    }
  }

  function closeSheet() {
    clearCloseTimeout();
    onClose();
  }

  $effect(() => {
    if (open) {
      filterQuery = '';
      void loadModels();
    } else {
      clearCloseTimeout();
    }

    return () => {
      clearCloseTimeout();
    };
  });

  async function loadModels() {
    loading = true;
    error = '';
    const token = getAdminToken() ?? '';
    const headers: HeadersInit = { 'x-admin-token': token, 'x-request-id': crypto.randomUUID(), 'x-requested-by': 'ui' };

    try {
      // TODO: N+1 optimization — if the providers endpoint does not return inline models,
      // this will require a separate fetch per provider. Consider a batch endpoint that
      // returns all providers with their models in a single round-trip.
      const [providersRes, configRes] = await Promise.all([
        fetch('/admin/opencode/providers', { headers }),
        fetch('/admin/opencode/model', { headers }),
      ]);

      if (providersRes.ok) {
        const pData = await providersRes.json();
        const rawProviders = (pData.providers ?? []) as Array<OpenCodeProviderSummary & { models?: ModelEntry[] }>;
        providers = rawProviders
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            models: (provider.models ?? []) as ModelEntry[],
          }))
          .filter((provider) => provider.models.length > 0);
      }

      if (configRes.ok) {
        const cData = await configRes.json();
        currentModel = cData.model ?? '';
        selectedModel = currentModel;
      }
    } catch (e) {
      console.warn('[ManageModelsSheet] Failed to load models:', e);
      error = 'Failed to load models. Is the assistant running?';
    } finally {
      loading = false;
    }
  }

  let filteredProviders = $derived.by(() => {
    if (!filterQuery) return providers;
    const q = filterQuery.toLowerCase();
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
        ),
      }))
      .filter((p) => p.models.length > 0);
  });

  async function handleSave() {
    if (!selectedModel || selectedModel === currentModel) {
      closeSheet();
      return;
    }
    saving = true;
    error = '';
    saveSuccess = '';
    try {
      const token = getAdminToken() ?? '';
      const res = await fetch('/admin/opencode/model', {
        method: 'POST',
        headers: {
          'x-admin-token': token,
          'x-request-id': crypto.randomUUID(),
          'x-requested-by': 'ui',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: selectedModel }),
      });
      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch (e) {
        console.warn('[ManageModelsSheet] Failed to parse model save response', e);
        throw new Error(`${res.status} ${res.statusText}`);
      }
      if (!res.ok) throw new Error((data.message as string) || 'Failed to save');
      saveSuccess = (data.message as string) || 'Model updated';
      currentModel = selectedModel;
      clearCloseTimeout();
      closeTimeout = setTimeout(() => {
        closeTimeout = null;
        closeSheet();
      }, 2000);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }
</script>

<ModalSheet {open} wide title="Manage Models" onClose={closeSheet}>
  {#snippet children()}
    <div class="form-field" style="margin-bottom: var(--space-4)">
      <input
        class="form-input"
        type="search"
        aria-label="Filter models"
        placeholder="Filter models..."
        bind:value={filterQuery}
      />
    </div>

    {#if loading}
      <p class="field-status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Loading models...</p>
    {:else if error}
      <div class="feedback feedback--error" role="alert">
        {error}
        <button class="btn btn-sm btn-ghost" type="button" onclick={loadModels}>Retry</button>
      </div>
    {:else if filteredProviders.length === 0}
      <p class="empty-state">No models available.</p>
    {:else}
      {#each filteredProviders as provider (provider.id)}
        <details class="provider-group" open>
          <summary>{provider.name} ({provider.models.length})</summary>
          <div>
            {#each provider.models as model (model.id)}
              <label class="model-row">
                <input
                  type="radio"
                  name="default-model"
                  value={model.id}
                  bind:group={selectedModel}
                  style="accent-color: var(--color-primary)"
                />
                <span class="model-row-name">{model.name || model.id}</span>
                {#if model.id === currentModel}
                  <span
                    style="font-size: var(--text-xs); color: var(--color-primary); font-weight: var(--font-medium)"
                    >current</span
                  >
                {/if}
              </label>
            {/each}
          </div>
        </details>
      {/each}
    {/if}

    {#if saveSuccess}
      <div class="feedback feedback--success" role="status" aria-live="polite">{saveSuccess}</div>
    {/if}
  {/snippet}

  {#snippet footer()}
    <button class="btn btn-outline" type="button" onclick={closeSheet}>Cancel</button>
    <button
      class="btn btn-primary"
      type="button"
      onclick={handleSave}
      disabled={saving || selectedModel === currentModel}
    >
      {saving ? 'Saving...' : 'Set Default Model'}
    </button>
  {/snippet}
</ModalSheet>
