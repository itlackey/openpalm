<script lang="ts">
  import { fetchAddons, toggleAddon } from '$lib/api.js';
  import { getAdminToken } from '$lib/auth.js';

  interface Props {
    onAuthError: () => void;
  }

  let { onAuthError }: Props = $props();

  type AddonEntry = { name: string; enabled: boolean; hasCompose: boolean };

  let addons = $state<AddonEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null);

  async function loadAddons(): Promise<void> {
    const token = getAdminToken();
    if (!token) { onAuthError(); return; }
    loading = true;
    error = '';
    try {
      addons = await fetchAddons(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    const token = getAdminToken();
    if (!token) { onAuthError(); return; }
    actionLoading = name;
    try {
      await toggleAddon(token, name, enabled);
      await loadAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      actionLoading = null;
    }
  }

  $effect(() => { loadAddons(); });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-semibold">Addons</h2>
    <button class="text-sm text-blue-600 hover:underline" onclick={() => loadAddons()}>
      Refresh
    </button>
  </div>

  {#if loading}
    <p class="text-sm text-gray-500">Loading addons...</p>
  {:else if error}
    <p class="text-sm text-red-600">{error}</p>
  {:else if addons.length === 0}
    <p class="text-sm text-gray-500">No addons found in stack/addons/.</p>
  {:else}
    <div class="divide-y rounded border">
      {#each addons as addon}
        <div class="flex items-center justify-between p-3">
          <div>
            <span class="font-medium">{addon.name}</span>
            {#if !addon.hasCompose}
              <span class="ml-2 text-xs text-amber-600">(missing compose.yml)</span>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs {addon.enabled ? 'text-green-600' : 'text-gray-400'}">
              {addon.enabled ? 'enabled' : 'disabled'}
            </span>
            <button
              class="rounded px-3 py-1 text-sm {addon.enabled ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}"
              disabled={actionLoading === addon.name || !addon.hasCompose}
              onclick={() => toggle(addon.name, !addon.enabled)}
            >
              {#if actionLoading === addon.name}
                ...
              {:else}
                {addon.enabled ? 'Disable' : 'Enable'}
              {/if}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
