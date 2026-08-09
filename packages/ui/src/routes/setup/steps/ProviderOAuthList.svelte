<script lang="ts">
  /**
   * ProviderOAuthList — OAuth provider list for CloudAttachPanel.
   *
   * Renders a compact vertical list of OAuth-capable providers,
   * filtered through WIZARD_EXCLUDED_PROVIDERS (no Anthropic).
   *
   * Takes NO props: reads the setup-state store directly (opencodeProviders /
   * opencodeAuth / providerState) and calls its OAuth methods
    * (startOpenCodeOAuth / submitOpenCodeOAuthCode / cancelOAuth), mirroring
    * Screen1ModelsStep / ReviewStep.
   *
   * The empty state distinguishes "OpenCode isn't reachable" from "everything
   * is already connected" (`opencodeAvailable`) and offers a retry in the
   * former case, rather than telling a first-run user with zero providers
   * they're done.
   */

  import { WIZARD_EXCLUDED_PROVIDERS } from '$lib/client/constants.js';
  import type { ProviderState } from '$lib/client/types.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  const s = setupState;

  const opencodeAvailable = $derived(s.opencodeAvailable);
  const opencodeProviders = $derived(s.opencodeProviders);
  const opencodeAuth = $derived(s.opencodeAuth);
  const providerState = $derived(s.providerState);
  const onoauthstart = (id: string, methodIndex: number): void => void s.startOpenCodeOAuth(id, methodIndex);
  const onoauthcancel = (id: string): void => s.cancelOAuth(id);

  // Authorization codes are transient component input. The store owns all
  // callback, cancellation, success, and failure state.
  const codeInputs: Record<string, string> = $state({});

  function cancelOauth(id: string): void {
    codeInputs[id] = '';
    onoauthcancel(id);
  }

  // Order recognizable consumer providers first; obscure ones fall to the end.
  const RECOGNIZABLE_FIRST = ['openai', 'google', 'github-copilot', 'groq', 'mistral', 'huggingface'];

  // Providers you can ADD here: OAuth-capable, not excluded, and NOT already
  // connected (connected ones live in the service picker above). Familiar names
  // lead; the long tail of obscure providers is collapsed behind "show all".
  const filteredProviders = $derived(
    opencodeProviders
      .filter((p) => {
        if (WIZARD_EXCLUDED_PROVIDERS.has(p.id)) return false;
        if (providerState[p.id]?.verified) return false;
        const methods = opencodeAuth[p.id] ?? [];
        return methods.some((m) => m.type === 'oauth');
      })
      .sort((a, b) => {
        const ia = RECOGNIZABLE_FIRST.indexOf(a.id);
        const ib = RECOGNIZABLE_FIRST.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
  );
  const OAUTH_CAP = 4;
  let showAllOauth = $state(false);
  const visibleOauth = $derived(showAllOauth ? filteredProviders : filteredProviders.slice(0, OAUTH_CAP));
  const hiddenOauthCount = $derived(Math.max(0, filteredProviders.length - OAUTH_CAP));

  function getState(id: string): ProviderState {
    return providerState[id] ?? {
      selected: false, verified: false, verifying: false,
      error: false, apiKey: '', baseUrl: '', models: [], ollamaMode: null,
    };
  }

  function oauthMethodIndex(id: string): number {
    return (opencodeAuth[id] ?? []).findIndex((m) => m.type === 'oauth');
  }
</script>

<div class="oauth-list" role="list">
  {#if filteredProviders.length === 0}
    {#if !opencodeAvailable}
      <!-- W1a: an empty catalog because the service is unreachable must not
           read as "you're all connected" — that told a first-run user with
           zero providers they were done. -->
      <div class="oauth-unavailable">
        <p class="oauth-empty">Can't reach the sign-in service right now.</p>
        <button type="button" class="oauth-retry" onclick={() => void s.checkOpenCodeAndInit()}>
          Retry
        </button>
      </div>
    {:else}
      <p class="oauth-empty">Nothing more to add — you're all connected.</p>
    {/if}
  {:else}
    {#each visibleOauth as provider (provider.id)}
      {@const st = getState(provider.id)}
      {@const methodIdx = oauthMethodIndex(provider.id)}
      <div class="oauth-row" role="listitem" data-provider={provider.id}>
        <span class="oauth-name">{provider.name}</span>

        {#if st.verified}
          <span class="oauth-status oauth-status--ok" aria-label="{provider.name} connected">Connected ✓</span>
        {:else if st.oauthPolling}
          <div class="oauth-polling">
            {#if st.oauthUrl}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external provider OAuth URL, not an internal route -->
              <a href={st.oauthUrl} target="_blank" rel="noopener" class="oauth-open-link">
                Open authorization page →
              </a>
            {/if}
            {#if st.oauthInstructions}
              <p class="oauth-instructions">{st.oauthInstructions}</p>
            {/if}
            {#if st.oauthMethod === 'code'}
              <div class="oauth-code-entry">
                <input
                  type="text"
                  class="oauth-code-input"
                  placeholder="Paste authorization code"
                  aria-label="{provider.name} authorization code"
                  value={codeInputs[provider.id] ?? ''}
                  disabled={st.verifying}
                  oninput={(e) => { codeInputs[provider.id] = (e.currentTarget as HTMLInputElement).value; }}
                />
                <button
                  type="button"
                  class="btn-oauth-code-submit"
                  disabled={st.verifying || !(codeInputs[provider.id] ?? '').trim()}
                  onclick={() => void s.submitOpenCodeOAuthCode(provider.id, methodIdx, codeInputs[provider.id] ?? '')}
                >
                  {st.verifying ? 'Submitting…' : 'Submit code'}
                </button>
              </div>
              {#if st.error}
                <!-- `||`, not `??`: a failed verify can set errorMessage to '' (non-Error
                     throw), and an empty alert reads as nothing at all. -->
                <span class="oauth-code-error" role="alert">{st.errorMessage || 'That code was not accepted. Try again.'}</span>
              {/if}
            {/if}
            {#if st.oauthMethod === 'auto'}
              <div class="oauth-waiting">
                <Spinner /> Waiting for authorization…
              </div>
            {/if}
            <button
              type="button"
              class="btn-oauth-cancel"
              onclick={() => cancelOauth(provider.id)}
            >
              Cancel
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            disabled={st.verifying}
            onclick={() => onoauthstart(provider.id, methodIdx)}
          >
            {st.verifying ? 'Signing in…' : 'Sign in'}
          </button>
        {/if}

        {#if st.error && !st.oauthPolling}
          <span class="oauth-error" role="alert">{st.errorMessage || 'Authorization failed'}</span>
        {/if}
      </div>
    {/each}
    {#if hiddenOauthCount > 0}
      <button type="button" class="oauth-more" onclick={() => { showAllOauth = !showAllOauth; }}>
        {showAllOauth ? 'Show fewer' : `Show ${hiddenOauthCount} more services`}
      </button>
    {/if}
  {/if}
</div>

<style>
  .oauth-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .oauth-empty {
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: 0;
    padding: 8px 0;
  }

  .oauth-unavailable {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .oauth-retry {
    padding: 4px 12px;
    background: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    cursor: pointer;
    min-height: 28px;
  }
  .oauth-retry:hover { border-color: var(--s-ink-3); }

  .oauth-code-entry {
    display: flex;
    gap: 6px;
    width: 100%;
  }

  .oauth-code-input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-size: var(--s-type-deed);
    font: inherit;
  }
  .oauth-code-input:focus-visible { outline: 2px solid var(--s-seal); outline-offset: 1px; }

  .btn-oauth-code-submit {
    padding: 4px 10px;
    background: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    cursor: pointer;
    min-height: 28px;
    flex-shrink: 0;
  }
  .btn-oauth-code-submit:hover:not(:disabled) { border-color: var(--s-ink-3); }
  .btn-oauth-code-submit:disabled { opacity: 0.55; cursor: not-allowed; }

  .oauth-code-error {
    width: 100%;
    font-size: var(--s-type-deed);
    color: var(--s-seal);
  }

  .oauth-more {
    align-self: flex-start;
    background: none;
    border: none;
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    color: var(--s-ink-2);
    cursor: pointer;
    padding: 8px 2px;
    border-radius: 2px;
  }
  .oauth-more:hover { color: var(--s-ink); }
  .oauth-more:focus-visible { outline: 2px solid var(--s-seal); outline-offset: 2px; }

  .oauth-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
    flex-wrap: wrap;
  }

  .oauth-name {
    flex: 1;
    min-width: 0;
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-ink);
  }

  .oauth-status--ok {
    font-size: var(--s-type-deed);
    color: var(--s-moss);
    font-weight: 400;
    white-space: nowrap;
  }

  /* Layout only — appearance comes from the design-system .btn classes. */
  .oauth-row :global(.btn) {
    flex-shrink: 0;
  }

  .oauth-polling {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  }

  .oauth-open-link {
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    text-underline-offset: 2px;
  }

  .oauth-instructions {
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    white-space: pre-wrap;
    margin: 0;
  }

  .oauth-waiting {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .btn-oauth-cancel {
    padding: 4px 10px;
    background: none;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    cursor: pointer;
    align-self: flex-start;
    min-height: 28px;
  }

  .btn-oauth-cancel:hover {
    border-color: var(--s-ink-3);
    color: var(--s-ink);
  }

  .oauth-error {
    width: 100%;
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    margin-top: 2px;
  }
</style>
