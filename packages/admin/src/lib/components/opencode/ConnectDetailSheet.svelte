<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';
  import { buildHeaders } from '$lib/api.js';
  import type { OpenCodeProviderSummary, OpenCodeAuthMethod } from '$lib/types.js';
  import ModalSheet from './ModalSheet.svelte';

  interface Props {
    open: boolean;
    provider: OpenCodeProviderSummary & { authMethods: OpenCodeAuthMethod[] };
    onBack: () => void;
    onConnected: () => void;
    onClose: () => void;
  }

  let { open, provider, onBack, onConnected, onClose }: Props = $props();

  let selectedMethodIndex = $state(0);
  let apiKey = $state('');
  let saving = $state(false);
  let error = $state('');
  let success = $state('');
  let oauthUrl = $state('');
  let oauthInstructions = $state('');
  let pollToken = $state('');
  let polling = $state(false);
  let connectedTimeout: ReturnType<typeof setTimeout> | null = $state(null);

  let hasAuthMethods = $derived(provider.authMethods.length > 0);
  let selectedMethod = $derived(provider.authMethods[selectedMethodIndex]);
  let envLabel = $derived(provider.env?.[0] ?? 'API_KEY');

  function clearConnectedTimeout() {
    if (connectedTimeout !== null) { clearTimeout(connectedTimeout); connectedTimeout = null; }
  }

  function scheduleConnected() {
    clearConnectedTimeout();
    connectedTimeout = setTimeout(() => { connectedTimeout = null; onConnected(); }, 2000);
  }

  async function submitApiKey() {
    if (!apiKey.trim()) { error = 'API key is required'; saving = false; return; }
    const token = getAdminToken() ?? '';
    const res = await fetch(
      `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth`,
      {
        method: 'POST',
        headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'api_key', apiKey: apiKey.trim(), envVar: provider.env?.[0] ?? '' }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to save');
    success = 'Connected successfully!';
    scheduleConnected();
  }

  async function submitOAuth() {
    const token = getAdminToken() ?? '';
    const res = await fetch(
      `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth`,
      {
        method: 'POST',
        headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'oauth', methodIndex: selectedMethodIndex }),
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to start OAuth');
    oauthUrl = data.url;
    oauthInstructions = data.instructions;
    pollToken = data.pollToken;
    if (data.method === 'auto' && data.url) window.open(data.url, '_blank');
    polling = true;
    void pollAuth();
  }

  async function handleSubmit() {
    saving = true; error = ''; success = '';
    try {
      if (!hasAuthMethods || selectedMethod?.type === 'api') await submitApiKey();
      else if (selectedMethod?.type === 'oauth') await submitOAuth();
    } catch (err) {
      error = err instanceof Error ? err.message : 'An error occurred';
    } finally {
      saving = false;
    }
  }

  async function pollAuth() {
    if (!pollToken) return;
    const token = getAdminToken() ?? '';
    let consecutiveErrors = 0;
    for (let i = 0; i < 120 && polling; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (!polling) break;
      try {
        const res = await fetch(
          `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth?pollToken=${encodeURIComponent(pollToken)}`,
          { headers: buildHeaders(token) }
        );
        consecutiveErrors = 0;
        const data = await res.json().catch(() => null) as { status?: string; message?: string } | null;
        if (!res.ok) { error = data?.message || `Authorization failed (HTTP ${res.status})`; polling = false; return; }
        if (!data) { error = 'Authorization failed'; polling = false; return; }
        if (data.status === 'complete') { success = 'Authorization successful!'; polling = false; scheduleConnected(); return; }
        if (data.status === 'error') { error = data.message || 'Authorization failed'; polling = false; return; }
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) { error = 'Unable to reach the server.'; polling = false; return; }
      }
    }
    if (polling) { error = 'Authorization timed out'; polling = false; }
  }

  function cancelPolling() {
    polling = false; pollToken = ''; oauthUrl = ''; oauthInstructions = '';
    clearConnectedTimeout();
  }
</script>

<ModalSheet
  {open}
  title={provider.name}
  backLabel={provider.name}
  onBack={() => { cancelPolling(); onBack(); }}
  onClose={() => { cancelPolling(); onClose(); }}
>
  {#snippet children()}
    <form id="connect-form" autocomplete="off" onsubmit={(e) => { e.preventDefault(); void handleSubmit(); }}>
      {#if hasAuthMethods}
        <p class="sheet-desc">How would you like to connect?</p>
        <div class="auth-method-group" role="radiogroup" aria-label="Authentication method">
          {#each provider.authMethods as method, i (i)}
            <button
              class="auth-method-card"
              class:auth-method-card--selected={selectedMethodIndex === i}
              role="radio"
              aria-checked={selectedMethodIndex === i}
              type="button"
              onclick={() => { selectedMethodIndex = i; error = ''; }}
            >
              <span style="font-weight: var(--font-medium)">{method.label}</span>
            </button>
          {/each}
        </div>

        {#if selectedMethod?.type === 'api'}
          <div class="form-field">
            <label class="form-label" for="api-key-input">API Key</label>
            <input id="api-key-input" name="apiKey" class="form-input" type="password" autocomplete="new-password" placeholder="Enter your API key..." bind:value={apiKey} />
          </div>
        {/if}
      {:else if provider.env?.length}
        <p class="sheet-desc">Enter your API key to connect.</p>
        <div class="form-field">
          <label class="form-label" for="env-key-input">{envLabel}</label>
          <input id="env-key-input" name="envKey" class="form-input" type="password" autocomplete="new-password" placeholder="Enter your API key..." bind:value={apiKey} />
        </div>
      {:else}
        <p class="sheet-desc">This provider does not require credentials.</p>
      {/if}

      {#if polling}
        <div style="text-align: center; padding: var(--space-4)">
          {#if oauthInstructions}<p style="margin-bottom: var(--space-3); white-space: pre-wrap">{oauthInstructions}</p>{/if}
          {#if oauthUrl}<p style="margin-bottom: var(--space-3)"><a href={oauthUrl} target="_blank" rel="noopener noreferrer" class="text-link">Open authorization page</a></p>{/if}
          <p class="field-status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span> Waiting for authorization...</p>
          <button class="btn btn-sm btn-ghost" type="button" onclick={cancelPolling}>Cancel</button>
        </div>
      {/if}

      {#if success}<div class="feedback feedback--success" role="status" aria-live="polite">{success}</div>{/if}
      {#if error}<div class="feedback feedback--error" role="alert" aria-live="assertive">{error}</div>{/if}
    </form>
  {/snippet}

  {#snippet footer()}
    {#if !polling && !success}
      <button class="btn btn-outline" type="button" onclick={() => { cancelPolling(); onBack(); }}>Cancel</button>
      <button class="btn btn-primary" type="submit" form="connect-form" disabled={saving || (!hasAuthMethods && !apiKey.trim()) || (hasAuthMethods && selectedMethod?.type === 'api' && !apiKey.trim())}>
        {saving ? 'Connecting...' : 'Connect'}
      </button>
    {/if}
  {/snippet}
</ModalSheet>

<style>
  .sheet-desc { font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-3); }
</style>
