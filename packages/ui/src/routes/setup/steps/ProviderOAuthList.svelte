<script lang="ts">
  /**
   * ProviderOAuthList — OAuth provider list for CloudAttachPanel.
   *
   * Renders a compact vertical list of OAuth-capable providers,
   * filtered through WIZARD_EXCLUDED_PROVIDERS (no Anthropic).
   *
   * Takes NO props: reads the setup-state store directly (opencodeProviders /
   * opencodeAuth / providerState) and calls its OAuth methods
   * (startOpenCodeOAuth / cancelOAuth), mirroring Screen1ModelsStep / ReviewStep.
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
  import { pollOpenCodeOAuthCallback } from '$lib/setup-api.js';

  const s = setupState;

  const opencodeAvailable = $derived(s.opencodeAvailable);
  const opencodeProviders = $derived(s.opencodeProviders);
  const opencodeAuth = $derived(s.opencodeAuth);
  const providerState = $derived(s.providerState);
  const onoauthstart = (id: string, methodIndex: number): void => void s.startOpenCodeOAuth(id, methodIndex);
  const onoauthcancel = (id: string): void => s.cancelOAuth(id);

  // ── W2: manual authorization-code entry ─────────────────────────────────────
  // `method:'code'` providers show a page with a code the user copies back
  // here — the wizard had no way to submit it, so sign-in for those providers
  // never completed. The store's long-poll (startOpenCodeOAuth) can't tell us
  // which method a given flow is (OpenCode only reveals that in the authorize
  // response, which the store consumes without re-exposing it), so this input
  // is offered whenever instructions are shown rather than gated on method —
  // harmless for 'auto' flows, which complete via the popup and never need it.
  const codeInputs: Record<string, string> = $state({});
  const codeSubmitting: Record<string, boolean> = $state({});
  const codeErrors: Record<string, string> = $state({});

  async function submitOauthCode(id: string, methodIndex: number): Promise<void> {
    const code = (codeInputs[id] ?? '').trim();
    if (!code) { codeErrors[id] = 'Paste the code first.'; return; }
    codeSubmitting[id] = true;
    codeErrors[id] = '';
    try {
      const { ok, data } = await pollOpenCodeOAuthCallback(id, methodIndex, AbortSignal.timeout(20_000), code);
      if (ok && data?.ok) {
        // Stop the store's own long-poll (still waiting on the same flow with
        // no code) so it can't later overwrite this success with a stale
        // timeout error — see cancelOAuth's abort of the in-flight fetch.
        s.cancelOAuth(id);
        const st = providerState[id];
        if (st) { st.verified = true; st.error = false; }
        codeInputs[id] = '';
      } else {
        codeErrors[id] = data?.message ?? 'That code was not accepted. Try again.';
      }
    } catch (e) {
      codeErrors[id] = e instanceof Error ? e.message : 'Failed to submit the code.';
    } finally {
      codeSubmitting[id] = false;
    }
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
              <!-- W2: `method:'code'` providers need the code pasted back here —
                   there is no client-side way to tell 'auto' and 'code' flows
                   apart before this point, so the field is offered whenever the
                   provider sent instructions; an 'auto' flow that completes via
                   its popup simply never needs it. -->
              <div class="oauth-code-entry">
                <input
                  type="text"
                  class="oauth-code-input"
                  placeholder="Paste authorization code"
                  aria-label="{provider.name} authorization code"
                  value={codeInputs[provider.id] ?? ''}
                  disabled={codeSubmitting[provider.id]}
                  oninput={(e) => { codeInputs[provider.id] = (e.currentTarget as HTMLInputElement).value; }}
                />
                <button
                  type="button"
                  class="btn-oauth-code-submit"
                  disabled={codeSubmitting[provider.id] || !(codeInputs[provider.id] ?? '').trim()}
                  onclick={() => submitOauthCode(provider.id, methodIdx)}
                >
                  {codeSubmitting[provider.id] ? 'Submitting…' : 'Submit code'}
                </button>
              </div>
              {#if codeErrors[provider.id]}
                <span class="oauth-code-error" role="alert">{codeErrors[provider.id]}</span>
              {/if}
            {/if}
            <div class="oauth-waiting">
              <Spinner /> Waiting for authorization…
            </div>
            <button
              type="button"
              class="btn-oauth-cancel"
              onclick={() => onoauthcancel(provider.id)}
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
          <span class="oauth-error" role="alert">{st.errorMessage ?? 'Authorization failed'}</span>
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
