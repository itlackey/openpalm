<script lang="ts">
  import { onMount } from 'svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import {
    fetchAddons,
    toggleAddon,
    fetchAddonCredentials,
    saveAddonCredentials,
    fetchSecretFile,
    type AddonCredentialField,
  } from '$lib/api.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { type TabId } from '$lib/components/chrome/TabBar.svelte';
  import SecretSelect from '$lib/components/common/SecretSelect.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import IconAddons from '$lib/components/icons/IconAddons.svelte';
  import Drawer from '$lib/components/common/Drawer.svelte';

  interface Props {
    onAuthError: () => void;
    onNavigate?: (tab: TabId) => void;
  }

  let { onAuthError, onNavigate }: Props = $props();

  type AddonEntry = { name: string; enabled: boolean; available: boolean };

  // Human-readable label for a raw addon identifier (the raw name stays as a
  // tooltip). Known acronyms keep their casing; everything else is Title Cased.
  const ADDON_ACRONYMS: Record<string, string> = { api: 'API', ssh: 'SSH', ui: 'UI' };
  function formatAddonName(name: string): string {
    return name
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => ADDON_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  let addons = $state<AddonEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null);

  // Per-addon credentials editor state (lazy — populated when expanded).
  let expanded = $state<string | null>(null);
  let credFields = $state<Record<string, AddonCredentialField[]>>({});
  let credValues = $state<Record<string, Record<string, string>>>({});
  // For sensitive fields: the NAME of the selected secret (the SecretSelect
  // binds here). On selection we fetch the value into credValues behind the
  // scenes — the raw value is never rendered.
  let credSecretRef = $state<Record<string, Record<string, string>>>({});
  let credLoading = $state<string | null>(null);
  let credSaving = $state<string | null>(null);

  async function onSecretChosen(addonName: string, key: string, secretName: string): Promise<void> {
    if (!secretName) {
      credValues[addonName][key] = '';
      return;
    }
    try {
      const { value } = await fetchSecretFile(secretName);
      credValues[addonName][key] = value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifications.push('error', `Could not read secret: ${msg}`);
    }
  }

  async function loadAddons(): Promise<void> {
    loading = true;
    error = '';
    try {
      addons = await fetchAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    actionLoading = name;
    try {
      await toggleAddon(name, enabled);
      await loadAddons();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      error = msg;
    } finally {
      actionLoading = null;
    }
  }

  function closeCredentials(): void {
    expanded = null;
  }

  async function openCredentials(name: string): Promise<void> {
    expanded = name;
    if (!credFields[name]) {
      credLoading = name;
      try {
        const fields = await fetchAddonCredentials(name);
        credFields[name] = fields;
        const seed: Record<string, string> = {};
        const refSeed: Record<string, string> = {};
        for (const f of fields) {
          seed[f.key] = f.sensitive ? '' : f.value;
          if (f.sensitive) refSeed[f.key] = '';
        }
        credValues[name] = seed;
        credSecretRef[name] = refSeed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
        notifications.push('error', `Could not load credentials: ${msg}`);
      } finally {
        credLoading = null;
      }
    }
  }

  async function saveCredentials(name: string): Promise<void> {
    credSaving = name;
    try {
      // Drop empty values for sensitive fields (user didn't change them);
      // leave non-sensitive empties so the user can clear a value.
      const fields = credFields[name] ?? [];
      const sensitiveKeys = new Set(fields.filter((f) => f.sensitive).map((f) => f.key));
      const submitted: Record<string, string> = {};
      const current = credValues[name] ?? {};
      for (const [k, v] of Object.entries(current)) {
        if (sensitiveKeys.has(k) && v === '') continue;
        submitted[k] = v;
      }
      if (Object.keys(submitted).length === 0) {
        notifications.push('error', 'Nothing to save.');
        return;
      }
      const { updated } = await saveAddonCredentials(name, submitted);
      notifications.push('success', `Saved ${updated.length} field(s). Recreate the addon container to apply.`);
      // Re-fetch to refresh `set` flags
      const fresh = await fetchAddonCredentials(name);
      credFields[name] = fresh;
      const reset = { ...current };
      for (const f of fresh) if (f.sensitive) reset[f.key] = '';
      credValues[name] = reset;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401') || msg.includes('403')) { onAuthError(); return; }
      notifications.push('error', `Save failed: ${msg}`);
    } finally {
      credSaving = null;
    }
  }

  onMount(() => { void loadAddons(); });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Addons</h2>
      <p class="panel-subtitle">Optional features · capabilities</p>
    </div>
    <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()} disabled={loading}>
      {#if loading}
        <Spinner />
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body panel-body--flush">
    {#if loading && addons.length === 0}
      <div class="loading-state">
        <Spinner />
        <span>Loading addons...</span>
      </div>
    {:else if error}
      <div class="error-state">
        <span>{error}</span>
        <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()}>Retry</button>
      </div>
    {:else if addons.length === 0}
      <EmptyState>
        {#snippet icon()}
          <IconAddons size={40} />
        {/snippet}
        <p>No addons found in registry/addons/.</p>
      </EmptyState>
    {:else}
      <div class="addon-table">
        <div class="addon-table-header">
          <span class="addon-col addon-col--name">Addon</span>
          <span class="addon-col addon-col--status">Status</span>
          <span class="addon-col addon-col--actions"></span>
        </div>
        {#each addons as addon (addon.name)}
          <div class="addon-row">
            <span class="addon-col addon-col--name addon-name" title={addon.name}>{formatAddonName(addon.name)}</span>
            <span class="addon-col addon-col--status">
              <span class="badge" class:badge-enabled={addon.enabled} class:badge-disabled={!addon.enabled}>
                {addon.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </span>
            <span class="addon-col addon-col--actions">
              {#if addon.name === 'voice' && addon.enabled}
                <button
                  class="btn btn-sm btn-secondary"
                  aria-label="Configure Voice addon settings"
                  onclick={() => onNavigate?.('voice')}
                >
                  Configure
                </button>
              {:else}
                <button
                  class="btn btn-sm btn-secondary"
                  onclick={() => void openCredentials(addon.name)}
                  disabled={!addon.available}
                >
                  Credentials
                </button>
              {/if}
              <button
                class="btn btn-sm"
                class:btn-danger={addon.enabled}
                class:btn-outline={!addon.enabled}
                disabled={actionLoading === addon.name || !addon.available}
                onclick={() => toggle(addon.name, !addon.enabled)}
              >
                {#if actionLoading === addon.name}
                  <Spinner />
                {:else}
                  {addon.enabled ? 'Disable' : 'Enable'}
                {/if}
              </button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Credentials editor opens in a drawer instead of expanding inline. -->
  {#if expanded}
    {@const aid = expanded}
    <Drawer open={true} title="{formatAddonName(aid)} credentials" onClose={closeCredentials}>
      {#if credLoading === aid}
        <div class="creds-loading"><Spinner /> Loading credentials…</div>
      {:else if (credFields[aid]?.length ?? 0) === 0}
        <p class="creds-empty">This addon has no configurable env vars (compose overlay only).</p>
      {:else}
        <p class="creds-hint">Values are written to <code>knowledge/env/stack.env</code> and read by the addon container on next recreate.</p>
        {#each credFields[aid] ?? [] as field (field.key)}
          <div class="creds-row">
            <label class="creds-label" for="cred-{aid}-{field.key}">
              <code>{field.key}</code>
              {#if field.sensitive}<span class="creds-tag">sensitive</span>{/if}
              {#if field.sensitive && field.set}<span class="creds-tag creds-tag--set">set</span>{/if}
            </label>
            {#if field.description}<p class="creds-desc">{field.description}</p>{/if}
            {#if field.sensitive}
              <SecretSelect
                id="cred-{aid}-{field.key}"
                bind:value={credSecretRef[aid][field.key]}
                onChange={(secretName) => void onSecretChosen(aid, field.key, secretName)}
              />
              {#if field.set}<p class="creds-desc">A value is already set — choose a secret to replace it.</p>{/if}
            {:else}
              <input
                id="cred-{aid}-{field.key}"
                type="text"
                class="form-input"
                placeholder={field.default}
                bind:value={credValues[aid][field.key]}
                autocomplete="off"
              />
            {/if}
          </div>
        {/each}
      {/if}
      {#snippet footer()}
        <button class="btn btn-secondary btn-sm" onclick={closeCredentials}>Cancel</button>
        <button
          class="btn btn-primary btn-sm"
          disabled={!expanded || credSaving === expanded || (credFields[expanded]?.length ?? 0) === 0}
          onclick={() => expanded && void saveCredentials(expanded)}
        >
          {#if credSaving === expanded}<Spinner />{/if} Save
        </button>
      {/snippet}
    </Drawer>
  {/if}
</div>

<style>
  /* ── Table ────────────────────────────────────────────────────── */

  .addon-table {
    display: flex;
    flex-direction: column;
    width: 100%;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
  }

  .addon-table-header {
    display: flex;
    align-items: center;
    padding: var(--s-sp-2) var(--s-sp-5);
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
    text-transform: uppercase;
  }

  .addon-row {
    display: flex;
    align-items: center;
    padding: var(--s-sp-3) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .addon-row:last-child {
    border-bottom: none;
  }

  .addon-row:hover {
    background: color-mix(in srgb, var(--s-ink) 3%, var(--s-paper));
  }

  .addon-col {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .addon-col--name {
    flex: 3;
    min-width: 0;
  }

  .addon-col--status {
    flex: 1;
    min-width: 0;
  }

  .addon-col--actions {
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  .addon-name {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* Narrow widths: let the row wrap so the name gets its own full-width line
     instead of being squeezed (and ellipsis-clipped) by the action buttons. */
  @media (max-width: 480px) {
    .addon-row { flex-wrap: wrap; }
    .addon-col--name { flex: 1 0 100%; }
    .addon-col--actions { justify-content: flex-start; }
  }

  /* ── States ───────────────────────────────────────────────────── */

  .error-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4) var(--s-sp-5);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-seal);
  }

  @media (max-width: 768px) {
    .addon-table-header {
      display: none;
    }

    .addon-row {
      flex-wrap: wrap;
      gap: var(--s-sp-2);
    }

    .addon-col--status {
      flex: 0 0 auto;
    }
  }

  /* ── Credentials editor (in a drawer) ───────────────────────────── */

  .creds-loading {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
  }

  .creds-empty,
  .creds-hint {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

  .creds-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }

  .creds-label {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .creds-label code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .creds-tag {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    padding: 2px 8px;
    border-radius: 2px;
    border: var(--s-hair) solid var(--s-line);
    background: none;
    color: var(--s-ink-3);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }

  .creds-tag--set {
    color: var(--s-moss);
    border-color: var(--s-moss);
  }

  .creds-desc {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

  .form-input {
    width: 100%;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
    background: none;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }
  .form-input:focus { outline: none; border-bottom-color: var(--s-seal); }
</style>
