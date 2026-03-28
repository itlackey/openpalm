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

  // OAuth state
  let oauthUrl = $state('');
  let oauthInstructions = $state('');
  let pollToken = $state('');
  let polling = $state(false);
  let connectedTimeout: ReturnType<typeof setTimeout> | null = $state(null);

  let selectedMethod = $derived(provider.authMethods[selectedMethodIndex]);

  function clearConnectedTimeout() {
    if (connectedTimeout !== null) {
      clearTimeout(connectedTimeout);
      connectedTimeout = null;
    }
  }

  function scheduleConnected() {
    clearConnectedTimeout();
    connectedTimeout = setTimeout(() => {
      connectedTimeout = null;
      onConnected();
    }, 2000);
  }

  // Stop the poll loop if the sheet is closed externally (e.g. onClose without cancelPolling).
  $effect(() => {
    if (!open) {
      polling = false;
      clearConnectedTimeout();
    }

    return () => {
      clearConnectedTimeout();
    };
  });

  async function handleSubmit() {
    if (!selectedMethod) return;
    saving = true;
    error = '';
    success = '';

    const token = getAdminToken() ?? '';
    const headers: HeadersInit = {
      ...buildHeaders(token),
      'Content-Type': 'application/json',
    };

    try {
      if (selectedMethod.type === 'api') {
        if (!apiKey.trim()) {
          error = 'API key is required';
          saving = false;
          return;
        }
        const res = await fetch(
          `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'api_key', apiKey: apiKey.trim() }),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to save');
        success = 'Connected successfully!';
        scheduleConnected();
      } else if (selectedMethod.type === 'oauth') {
        const res = await fetch(
          `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ mode: 'oauth', methodIndex: selectedMethodIndex }),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to start OAuth');
        oauthUrl = data.url;
        oauthInstructions = data.instructions;
        pollToken = data.pollToken;
        if (data.method === 'auto' && data.url) {
          window.open(data.url, '_blank');
        }
        polling = true;
        void pollAuth();
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'An error occurred';
    } finally {
      saving = false;
    }
  }

  async function pollAuth() {
    if (!pollToken) return;
    const token = getAdminToken() ?? '';
    const maxAttempts = 120; // 10 minutes at 5s intervals
    let consecutiveErrors = 0;
    for (let i = 0; i < maxAttempts && polling; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (!polling) break;
      try {
        const res = await fetch(
          `/admin/opencode/providers/${encodeURIComponent(provider.id)}/auth?pollToken=${encodeURIComponent(pollToken)}`,
          { headers: buildHeaders(token) }
        );
        consecutiveErrors = 0;
        const data = await res.json().catch((e: unknown) => {
          console.warn('[ConnectDetailSheet] Failed to parse poll response:', e);
          return null;
        }) as { status?: string; message?: string } | null;
        if (!res.ok) {
          error = data?.message || `Authorization failed (HTTP ${res.status})`;
          polling = false;
          return;
        }
        if (!data) {
          error = 'Authorization failed';
          polling = false;
          return;
        }
        if (data.status === 'complete') {
          success = 'Authorization successful!';
          polling = false;
          scheduleConnected();
          return;
        }
        if (data.status === 'error') {
          error = data.message || 'Authorization failed';
          polling = false;
          return;
        }
      } catch (e) {
        console.warn('[ConnectDetailSheet] OAuth poll error:', e);
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          error = 'Unable to reach the server. Please check your connection and try again.';
          polling = false;
          return;
        }
      }
    }
    if (polling) {
      error = 'Authorization timed out';
      polling = false;
    }
  }

  function cancelPolling() {
    polling = false;
    pollToken = '';
    oauthUrl = '';
    oauthInstructions = '';
    clearConnectedTimeout();
  }

  function handleBackClick() {
    cancelPolling();
    onBack();
  }

  function handleCloseClick() {
    cancelPolling();
    onClose();
  }
</script>

<ModalSheet
  {open}
  title="Connect {provider.name}"
  backLabel={provider.name}
  onBack={handleBackClick}
  onClose={handleCloseClick}
>
  {#snippet children()}
    <div style="margin-bottom: var(--space-4)">
      <p
        style="font-size: var(--text-sm); color: var(--color-text-secondary); margin-bottom: var(--space-3)"
      >
        How would you like to connect?
      </p>

      <div class="auth-method-group" role="radiogroup" aria-label="Authentication method">
        {#each provider.authMethods as method, i (i)}
          <button
            class="auth-method-card"
            class:auth-method-card--selected={selectedMethodIndex === i}
            role="radio"
            aria-checked={selectedMethodIndex === i}
            type="button"
            onclick={() => {
              selectedMethodIndex = i;
              error = '';
            }}
          >
            <span style="font-weight: var(--font-medium)">{method.label}</span>
          </button>
        {/each}
      </div>
    </div>

    {#if selectedMethod?.type === 'api'}
      <div class="form-field">
        <label class="form-label" for="api-key-input">API Key</label>
        <input
          id="api-key-input"
          class="form-input"
          type="password"
          placeholder="Enter your API key..."
          bind:value={apiKey}
        />
        <span class="field-hint">Your key is stored in vault/user/user.env</span>
      </div>
    {/if}

    {#if polling}
      <div style="text-align: center; padding: var(--space-4)">
        {#if oauthInstructions}
          <p style="margin-bottom: var(--space-3); white-space: pre-wrap">{oauthInstructions}</p>
        {/if}
        {#if oauthUrl}
          <p style="margin-bottom: var(--space-3)">
            <a href={oauthUrl} target="_blank" rel="noopener noreferrer" class="text-link">
              Open authorization page →
            </a>
          </p>
        {/if}
        <p class="field-status" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span> Waiting for authorization...
        </p>
        <button class="btn btn-sm btn-ghost" type="button" onclick={cancelPolling}>Cancel</button>
      </div>
    {/if}

    {#if success}
      <div class="feedback feedback--success" role="status" aria-live="polite">{success}</div>
    {/if}
    {#if error}
      <div class="feedback feedback--error" role="alert" aria-live="assertive">{error}</div>
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if !polling && !success}
      <button class="btn btn-outline" type="button" onclick={handleBackClick}>Cancel</button>
      <button
        class="btn btn-primary"
        type="button"
        onclick={handleSubmit}
        disabled={saving || (selectedMethod?.type === 'api' && !apiKey.trim())}
      >
        {saving ? 'Connecting...' : 'Connect'}
      </button>
    {/if}
  {/snippet}
</ModalSheet>
