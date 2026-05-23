<script lang="ts">
  import { PROVIDERS, PROVIDER_GROUPS } from '$lib/wizard/constants.js';
  import type { ProviderState, DetectedProvider, OpenCodeProvider, AuthMethod } from '$lib/wizard/types.js';
  import { friendlyError } from '$lib/wizard/error-messages.js';

  function friendlyProviderError(raw: string | undefined, providerName?: string): string {
    if (!raw) return 'Connection failed';
    const view = friendlyError(raw, 'provider-verify', providerName ? { providerName } : {});
    // Inline display: combine title + concise hint
    return view.hint ? `${view.title}. ${view.hint}` : view.title;
  }

  interface Props {
    opencodeAvailable: boolean;
    opencodeProviders: OpenCodeProvider[];
    opencodeAuth: Record<string, AuthMethod[]>;
    providerState: Record<string, ProviderState>;
    expandedProvider: string | null;
    detectedProviders: DetectedProvider[];
    detecting: boolean;
    ocFilterQuery: string;
    verifiedCount: number;
    onback: () => void;
    onnext: () => void;
    ontogglefallback: (id: string) => void;
    ontoggleopencode: (id: string) => void;
    onverify: (id: string) => void;
    onapikey: (id: string, key: string) => void;
    onbaseurl: (id: string, url: string) => void;
    onollamamode: (mode: 'running' | 'instack') => void;
    onoauthstart: (id: string, methodIndex: number) => void;
    onoauthcancel: (id: string) => void;
    onmarkready: (id: string) => void;
    ondeselect: (id: string) => void;
    onfilterchange: (q: string) => void;
    /** Number of providers detected on this host's OpenCode install (0 = none) */
    hostProviderCount?: number;
    /** Called when user chooses Import and clicks Continue — parent calls import-host then advances */
    onhostimport?: () => void;
    /** Optional warning to display (e.g. partial host import failures) */
    hostStatusWarning?: string | null;
    /** Whether the user has explicitly opted to install with no provider */
    allowEmptyInstall?: boolean;
    /** Called when the "install without provider" checkbox flips */
    onallowemptyinstallchange?: (v: boolean) => void;
  }

  let {
    opencodeAvailable,
    opencodeProviders,
    opencodeAuth,
    providerState,
    expandedProvider,
    detectedProviders,
    detecting,
    ocFilterQuery,
    verifiedCount,
    onback,
    onnext,
    ontogglefallback,
    ontoggleopencode,
    onverify,
    onapikey,
    onbaseurl,
    onollamamode,
    onoauthstart,
    onoauthcancel,
    onmarkready,
    ondeselect,
    onfilterchange,
    hostProviderCount = 0,
    onhostimport,
    hostStatusWarning = null,
    allowEmptyInstall = false,
    onallowemptyinstallchange,
  }: Props = $props();

  // When host providers are detected, default to Import mode.
  // Use explicit state so the user can toggle between import and manual
  // without the prop value re-driving the choice.
  let importModeExplicit = $state<'import' | 'manual' | null>(null);
  const importMode = $derived(importModeExplicit ?? (hostProviderCount > 0 ? 'import' : 'manual'));

  function handleFilterInput(e: Event) {
    onfilterchange((e.currentTarget as HTMLInputElement).value);
  }

  // OpenCode mode: sort providers by connected first, then name
  let filteredOcProviders = $derived.by(() => {
    const query = ocFilterQuery.toLowerCase().trim();
    let list = opencodeProviders;
    if (query) {
      list = list.filter((p) =>
        p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)
      );
    }
    return [...list].sort((a, b) => {
      const aConn = providerState[a.id]?.verified ? 1 : 0;
      const bConn = providerState[b.id]?.verified ? 1 : 0;
      if (aConn !== bConn) return bConn - aConn;
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });
  });

  // In OpenCode mode, split providers into "recommended" (verified or in PROVIDERS recommended group)
  // and "the rest" so non-technical users see a short list by default.
  const RECOMMENDED_IDS = new Set(['ollama', 'huggingface', 'openai', 'google', 'model-runner', 'lmstudio']);

  let showAllOcProviders = $state(false);

  let ocRecommended = $derived.by(() =>
    filteredOcProviders.filter(
      (p) => providerState[p.id]?.verified || RECOMMENDED_IDS.has(p.id)
    )
  );
  let ocRest = $derived.by(() =>
    filteredOcProviders.filter(
      (p) => !providerState[p.id]?.verified && !RECOMMENDED_IDS.has(p.id)
    )
  );
  // When a filter query is active, skip the recommended/rest split
  let ocDisplayList = $derived(ocFilterQuery ? filteredOcProviders : ocRecommended);
  let ocRestCount = $derived(ocFilterQuery ? 0 : ocRest.length);
</script>

<h2>Where should your models run?</h2>
<p class="step-description">Select one or more providers. Click a card to configure it.</p>

{#if hostStatusWarning}
  <div class="host-status-warning" role="alert">⚠ {hostStatusWarning}</div>
{/if}

{#if hostProviderCount > 0}
  <div class="host-import-choice">
    <p class="host-import-desc">
      We found OpenCode on this host with <strong>{hostProviderCount}</strong> provider{hostProviderCount !== 1 ? 's' : ''} configured.
    </p>
    <label class="host-radio">
      <input type="radio" name="provider-source" value="import" checked={importMode === 'import'} onchange={() => { importModeExplicit = 'import'; }} />
      <span><strong>Import from host OpenCode</strong> <em>(recommended)</em></span>
    </label>
    <label class="host-radio">
      <input type="radio" name="provider-source" value="manual" checked={importMode === 'manual'} onchange={() => { importModeExplicit = 'manual'; }} />
      <span>Configure providers manually</span>
    </label>
  </div>
{/if}

{#if !hostProviderCount || importMode === 'manual'}
{#if detecting}
  <div class="loading-state" id="conn-detecting">
    <span class="spinner"></span>&nbsp;Detecting local providers...
  </div>
{/if}

<div class="provider-grid" id="provider-grid">
  {#if opencodeAvailable}
    <!-- OpenCode provider grid -->
    <div class="model-filter-row" style="margin-bottom:12px">
      <input type="text" class="model-filter-input" id="oc-provider-filter"
        placeholder="Search {opencodeProviders.length} providers…"
        value={ocFilterQuery}
        oninput={handleFilterInput}
        autocomplete="off">
    </div>

    {#each ocDisplayList as ocp}
      {@const st = providerState[ocp.id] ?? { selected: false, verified: false, verifying: false, error: false, apiKey: '', baseUrl: '', models: [], ollamaMode: null }}
      {@const modelCount = (st.models && st.models.length > 0) ? st.models.length : Object.keys(ocp.models ?? {}).length}
      {@const authMethods = opencodeAuth[ocp.id] ?? []}
      {@const isExpanded = expandedProvider === ocp.id}
      <div class="pcard {st.verified ? 'selected verified' : isExpanded ? 'selected' : ''} {isExpanded ? 'wide' : ''}"
        data-provider={ocp.id}>
        <!-- Header -->
        <div class="pcard-header" role="button" tabindex="0"
          onclick={() => ontoggleopencode(ocp.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggleopencode(ocp.id); }}>
          <div class="pcard-info">
            <div class="pcard-name">
              {ocp.name}
              {#if st.verified}<span class="vs vs-ok">✓</span>
              {:else if st.verifying}<span class="vs vs-wait">⟳</span>
              {:else if st.error}<span class="vs vs-err">✗</span>
              {/if}
            </div>
            <div class="pcard-desc">
              {modelCount} model{modelCount !== 1 ? 's' : ''}
              {#if authMethods.length > 0} · {authMethods.length} auth method{authMethods.length !== 1 ? 's' : ''}{/if}
            </div>
          </div>
          <div class="pcard-check" aria-hidden="true">
            {st.verified ? '✓' : ''}
          </div>
        </div>

        <!-- Expanded auth panel -->
        {#if isExpanded}
          <div class="pcard-auth">
            {#if st.verified}
              <div class="auth-feedback auth-feedback-ok">
                <span>Connected</span>
                <button class="auth-disconnect" type="button"
                  onclick={(e) => { e.stopPropagation(); ondeselect(ocp.id); }}>
                  Disconnect
                </button>
              </div>
            {:else}
              {#if st.error}
                <div class="auth-feedback auth-feedback-err">{friendlyProviderError(st.errorMessage, ocp.name)}</div>
              {/if}

              {#if authMethods.length > 0}
                {#each authMethods as method, idx}
                  {#if method.type === 'api'}
                    <div class="auth-row" style="margin-bottom:6px">
                      <input type="password" placeholder="API key" value={st.apiKey ?? ''}
                        oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                        onclick={(e) => e.stopPropagation()}>
                      <button class="auth-btn auth-btn-verify"
                        disabled={st.verifying}
                        onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                        {st.verifying ? 'Connecting...' : method.label}
                      </button>
                    </div>
                  {:else if method.type === 'oauth'}
                    <div class="auth-row" style="margin-bottom:6px">
                      <button class="auth-btn auth-btn-detect" style="width:100%"
                        disabled={st.verifying}
                        onclick={(e) => { e.stopPropagation(); onoauthstart(ocp.id, idx); }}>
                        {st.verifying ? 'Waiting...' : method.label}
                      </button>
                    </div>
                  {/if}
                {/each}
              {:else if (ocp.env ?? []).length > 0}
                <div class="auth-row">
                  <input type="password" placeholder={(ocp.env ?? [])[0]} value={st.apiKey ?? ''}
                    oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                    onclick={(e) => e.stopPropagation()}>
                  <button class="auth-btn auth-btn-verify"
                    disabled={st.verifying}
                    onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                    {st.verifying ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
              {:else if ocp.id === 'openai-compatible'}
                <div class="auth-row" style="margin-bottom:6px">
                  <input type="url" placeholder="https://your-server.example/v1" value={st.baseUrl ?? ''}
                    oninput={(e) => { e.stopPropagation(); onbaseurl(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                    onclick={(e) => e.stopPropagation()}>
                </div>
                <div class="auth-row" style="margin-bottom:6px">
                  <input type="password" placeholder="API key (optional)" value={st.apiKey ?? ''}
                    oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                    onclick={(e) => e.stopPropagation()}>
                </div>
                <div class="auth-row">
                  <button class="auth-btn auth-btn-verify"
                    disabled={st.verifying}
                    onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                    {st.verifying ? 'Checking...' : 'Connect'}
                  </button>
                </div>
              {:else if ocp.localUrl}
                <div class="auth-row">
                  <input type="url" placeholder={ocp.localUrl} value={st.baseUrl || ocp.localUrl}
                    oninput={(e) => { e.stopPropagation(); onbaseurl(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                    onclick={(e) => e.stopPropagation()}>
                  <button class="auth-btn {st.verified ? 'auth-btn-detected' : 'auth-btn-detect'}"
                    disabled={st.verifying}
                    onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                    {st.verifying ? 'Detecting...' : st.verified ? 'Connected ✓' : 'Detect'}
                  </button>
                </div>
              {:else}
                <div style="padding:4px 0;color:var(--color-text-secondary);font-size:var(--text-xs)">No authentication required</div>
                <button class="auth-btn auth-btn-detect"
                  onclick={(e) => { e.stopPropagation(); onmarkready(ocp.id); }}>
                  Mark as ready
                </button>
              {/if}

              {#if st.oauthPolling}
                <div style="text-align:center;padding:8px">
                  {#if st.oauthUrl}
                    <p style="margin-bottom:6px">
                      <a href={st.oauthUrl} target="_blank" rel="noopener" style="color:var(--color-accent)">Open authorization page →</a>
                    </p>
                  {/if}
                  {#if st.oauthInstructions}
                    <p style="margin-bottom:6px;white-space:pre-wrap;font-size:var(--text-xs)">{st.oauthInstructions}</p>
                  {/if}
                  <p><span class="spinner"></span> Waiting for authorization...</p>
                  <button class="auth-btn" style="margin-top:6px"
                    onclick={(e) => { e.stopPropagation(); onoauthcancel(ocp.id); }}>
                    Cancel
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if showAllOcProviders}
      {#each ocRest as ocp}
        {@const st = providerState[ocp.id] ?? { selected: false, verified: false, verifying: false, error: false, apiKey: '', baseUrl: '', models: [], ollamaMode: null }}
        {@const modelCount = (st.models && st.models.length > 0) ? st.models.length : Object.keys(ocp.models ?? {}).length}
        {@const authMethods = opencodeAuth[ocp.id] ?? []}
        {@const isExpanded = expandedProvider === ocp.id}
        <div class="pcard {st.verified ? 'selected verified' : isExpanded ? 'selected' : ''} {isExpanded ? 'wide' : ''}"
          data-provider={ocp.id}>
          <!-- Header -->
          <div class="pcard-header" role="button" tabindex="0"
            onclick={() => ontoggleopencode(ocp.id)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggleopencode(ocp.id); }}>
            <div class="pcard-info">
              <div class="pcard-name">
                {ocp.name}
                {#if st.verified}<span class="vs vs-ok">✓</span>
                {:else if st.verifying}<span class="vs vs-wait">⟳</span>
                {:else if st.error}<span class="vs vs-err">✗</span>
                {/if}
              </div>
              <div class="pcard-desc">
                {modelCount} model{modelCount !== 1 ? 's' : ''}
                {#if authMethods.length > 0} · {authMethods.length} auth method{authMethods.length !== 1 ? 's' : ''}{/if}
              </div>
            </div>
            <div class="pcard-check" aria-hidden="true">
              {st.verified ? '✓' : ''}
            </div>
          </div>

          <!-- Expanded auth panel -->
          {#if isExpanded}
            <div class="pcard-auth">
              {#if st.verified}
                <div class="auth-feedback auth-feedback-ok">
                  <span>Connected</span>
                  <button class="auth-disconnect" type="button"
                    onclick={(e) => { e.stopPropagation(); ondeselect(ocp.id); }}>
                    Disconnect
                  </button>
                </div>
              {:else}
                {#if st.error}
                  <div class="auth-feedback auth-feedback-err">{friendlyProviderError(st.errorMessage, ocp.name)}</div>
                {/if}

                {#if authMethods.length > 0}
                  {#each authMethods as method, idx}
                    {#if method.type === 'api'}
                      <div class="auth-row" style="margin-bottom:6px">
                        <input type="password" placeholder="API key" value={st.apiKey ?? ''}
                          oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                          onclick={(e) => e.stopPropagation()}>
                        <button class="auth-btn auth-btn-verify"
                          disabled={st.verifying}
                          onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                          {st.verifying ? 'Connecting...' : method.label}
                        </button>
                      </div>
                    {:else if method.type === 'oauth'}
                      <div class="auth-row" style="margin-bottom:6px">
                        <button class="auth-btn auth-btn-detect" style="width:100%"
                          disabled={st.verifying}
                          onclick={(e) => { e.stopPropagation(); onoauthstart(ocp.id, idx); }}>
                          {st.verifying ? 'Waiting...' : method.label}
                        </button>
                      </div>
                    {/if}
                  {/each}
                {:else if (ocp.env ?? []).length > 0}
                  <div class="auth-row">
                    <input type="password" placeholder={(ocp.env ?? [])[0]} value={st.apiKey ?? ''}
                      oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                      onclick={(e) => e.stopPropagation()}>
                    <button class="auth-btn auth-btn-verify"
                      disabled={st.verifying}
                      onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                      {st.verifying ? 'Connecting...' : 'Connect'}
                    </button>
                  </div>
                {:else if ocp.id === 'openai-compatible'}
                  <div class="auth-row" style="margin-bottom:6px">
                    <input type="url" placeholder="https://your-server.example/v1" value={st.baseUrl ?? ''}
                      oninput={(e) => { e.stopPropagation(); onbaseurl(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                      onclick={(e) => e.stopPropagation()}>
                  </div>
                  <div class="auth-row" style="margin-bottom:6px">
                    <input type="password" placeholder="API key (optional)" value={st.apiKey ?? ''}
                      oninput={(e) => { e.stopPropagation(); onapikey(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                      onclick={(e) => e.stopPropagation()}>
                  </div>
                  <div class="auth-row">
                    <button class="auth-btn auth-btn-verify"
                      disabled={st.verifying}
                      onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                      {st.verifying ? 'Checking...' : 'Connect'}
                    </button>
                  </div>
                {:else if ocp.localUrl}
                  <div class="auth-row">
                    <input type="url" placeholder={ocp.localUrl} value={st.baseUrl || ocp.localUrl}
                      oninput={(e) => { e.stopPropagation(); onbaseurl(ocp.id, (e.currentTarget as HTMLInputElement).value); }}
                      onclick={(e) => e.stopPropagation()}>
                    <button class="auth-btn {st.verified ? 'auth-btn-detected' : 'auth-btn-detect'}"
                      disabled={st.verifying}
                      onclick={(e) => { e.stopPropagation(); onverify(ocp.id); }}>
                      {st.verifying ? 'Detecting...' : st.verified ? 'Connected ✓' : 'Detect'}
                    </button>
                  </div>
                {:else}
                  <div style="padding:4px 0;color:var(--color-text-secondary);font-size:var(--text-xs)">No authentication required</div>
                  <button class="auth-btn auth-btn-detect"
                    onclick={(e) => { e.stopPropagation(); onmarkready(ocp.id); }}>
                    Mark as ready
                  </button>
                {/if}

                {#if st.oauthPolling}
                  <div style="text-align:center;padding:8px">
                    {#if st.oauthUrl}
                      <p style="margin-bottom:6px">
                        <a href={st.oauthUrl} target="_blank" rel="noopener" style="color:var(--color-accent)">Open authorization page →</a>
                      </p>
                    {/if}
                    {#if st.oauthInstructions}
                      <p style="margin-bottom:6px;white-space:pre-wrap;font-size:var(--text-xs)">{st.oauthInstructions}</p>
                    {/if}
                    <p><span class="spinner"></span> Waiting for authorization...</p>
                    <button class="auth-btn" style="margin-top:6px"
                      onclick={(e) => { e.stopPropagation(); onoauthcancel(ocp.id); }}>
                      Cancel
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}

    {#if ocRestCount > 0 && !ocFilterQuery}
      <button class="btn-show-all-providers" id="btn-show-all-providers"
        onclick={() => showAllOcProviders = !showAllOcProviders}>
        {showAllOcProviders ? 'Show fewer providers' : `Show all providers (${ocRestCount} more)`}
      </button>
    {/if}

    {#if filteredOcProviders.length === 0 && ocFilterQuery}
      <div style="text-align:center;padding:24px;color:var(--color-text-secondary)">
        No providers match "{ocFilterQuery}"
      </div>
    {/if}
  {:else}
    <!-- Fallback provider grid (hardcoded PROVIDERS) -->
    {#each PROVIDER_GROUPS as group}
      {@const members = PROVIDERS.filter((p) => p.group === group.id).sort((a, b) => a.order - b.order)}
      {#if members.length > 0}
        <div class="provider-group">
          <div class="provider-group-header">
            <h3 class="provider-group-label">{group.label}</h3>
            <span class="provider-group-desc">{group.desc}</span>
          </div>
          <div class="provider-group-cards">
            {#each members as p}
              {@const st = providerState[p.id] ?? { selected: false, verified: false, verifying: false, error: false, apiKey: '', baseUrl: '', models: [], ollamaMode: null }}
              {@const isExpanded = expandedProvider === p.id && st.selected}
              {@const badgeCls = p.kind === 'cloud' ? 'badge-cloud' : p.kind === 'local' ? 'badge-local' : 'badge-hybrid'}
              <div class="pcard {st.selected ? 'selected' : ''} {st.verified ? 'verified' : ''} {isExpanded ? 'wide' : ''}"
                data-provider={p.id}>
                <div class="pcard-header" role="button" tabindex="0"
                  data-toggle-provider={p.id}
                  onclick={() => ontogglefallback(p.id)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontogglefallback(p.id); }}>
                  <div class="pcard-icon">{p.icon}</div>
                  <div class="pcard-info">
                    <div class="pcard-name">
                      {p.name}
                      <span class="badge {badgeCls}">{p.kind}</span>
                      {#if st.verified}<span class="vs vs-ok">✓</span>
                      {:else if st.verifying}<span class="vs vs-wait">⟳</span>
                      {:else if st.error}<span class="vs vs-err">✗</span>
                      {/if}
                    </div>
                    <div class="pcard-desc">{p.desc}</div>
                  </div>
                  <div class="pcard-check" aria-hidden="true">
                    {st.selected ? '✓' : ''}
                  </div>
                </div>

                {#if isExpanded}
                  <div class="pcard-auth">
                    {#if p.id === 'ollama'}
                      {#if !st.ollamaMode}
                        <div class="ollama-mode-prompt">
                          <p>Is Ollama already running on this machine?</p>
                          <div class="ollama-mode-buttons">
                            <button class="ollama-mode-btn ollama-mode-btn-detect"
                              onclick={(e) => { e.stopPropagation(); onollamamode('running'); }}>
                              Yes, detect it
                            </button>
                            <button class="ollama-mode-btn ollama-mode-btn-stack"
                              onclick={(e) => { e.stopPropagation(); onollamamode('instack'); }}>
                              No, add to stack
                            </button>
                          </div>
                        </div>
                      {:else if st.ollamaMode === 'running'}
                        <div class="auth-row">
                          <input type="url" placeholder={p.baseUrl} value={st.baseUrl || p.baseUrl}
                            oninput={(e) => { e.stopPropagation(); onbaseurl(p.id, (e.currentTarget as HTMLInputElement).value); }}
                            onclick={(e) => e.stopPropagation()}>
                          <button class="auth-btn {st.verified ? 'auth-btn-detected' : 'auth-btn-detect'}"
                            disabled={st.verifying}
                            onclick={(e) => { e.stopPropagation(); onverify(p.id); }}>
                            {st.verifying ? 'Detecting...' : st.verified ? 'Connected ✓' : 'Detect'}
                          </button>
                        </div>
                      {:else}
                        <!-- instack mode -->
                        {#if st.verified}
                          <div class="auth-feedback auth-feedback-ok">
                            <span>Ollama will be added to your Docker stack with default models.</span>
                            <button class="auth-disconnect" type="button"
                              onclick={(e) => { e.stopPropagation(); ondeselect(p.id); }}>
                              Disconnect
                            </button>
                          </div>
                        {:else}
                          <div class="ollama-mode-prompt">
                            <p>Ollama runs as a container in your stack with recommended models pre-configured.</p>
                            <button class="auth-btn auth-btn-detect" style="margin-top:4px"
                              onclick={(e) => { e.stopPropagation(); onverify(p.id); }}>
                              Enable Ollama
                            </button>
                          </div>
                        {/if}
                      {/if}
                    {:else if p.needsUrl}
                      <div class="auth-row">
                        <input type="url" placeholder="https://your-server.example/v1" value={st.baseUrl || ''}
                          oninput={(e) => { e.stopPropagation(); onbaseurl(p.id, (e.currentTarget as HTMLInputElement).value); }}
                          onclick={(e) => e.stopPropagation()}>
                      </div>
                      {#if p.optionalKey}
                        <div class="auth-row" style="margin-top:6px">
                          <input type="password" placeholder={p.placeholder || 'API key (optional)'} value={st.apiKey}
                            oninput={(e) => { e.stopPropagation(); onapikey(p.id, (e.currentTarget as HTMLInputElement).value); }}
                            onclick={(e) => e.stopPropagation()}>
                        </div>
                      {/if}
                      <div class="auth-row" style="margin-top:6px">
                        <button class="auth-btn {st.verified ? 'auth-btn-verified' : 'auth-btn-verify'}"
                          disabled={st.verifying}
                          onclick={(e) => { e.stopPropagation(); onverify(p.id); }}>
                          {st.verifying ? 'Checking...' : st.verified ? 'Connected ✓' : 'Connect'}
                        </button>
                      </div>
                    {:else if p.needsKey}
                      <div class="auth-row">
                        <input type="password" placeholder={p.placeholder || 'API key'} value={st.apiKey}
                          oninput={(e) => { e.stopPropagation(); onapikey(p.id, (e.currentTarget as HTMLInputElement).value); }}
                          onclick={(e) => e.stopPropagation()}>
                        <button class="auth-btn {st.verified ? 'auth-btn-verified' : 'auth-btn-verify'}"
                          disabled={st.verifying}
                          onclick={(e) => { e.stopPropagation(); onverify(p.id); }}>
                          {st.verifying ? 'Checking...' : st.verified ? 'Verified ✓' : 'Verify'}
                        </button>
                      </div>
                    {:else}
                      <!-- Local provider with URL -->
                      <div class="auth-row">
                        <input type="url" placeholder={p.baseUrl || 'http://localhost:8080'} value={st.baseUrl || p.baseUrl || ''}
                          oninput={(e) => { e.stopPropagation(); onbaseurl(p.id, (e.currentTarget as HTMLInputElement).value); }}
                          onclick={(e) => e.stopPropagation()}>
                        <button class="auth-btn {st.verified ? 'auth-btn-detected' : 'auth-btn-detect'}"
                          disabled={st.verifying}
                          onclick={(e) => { e.stopPropagation(); onverify(p.id); }}>
                          {st.verifying ? 'Detecting...' : st.verified ? 'Connected ✓' : 'Detect'}
                        </button>
                      </div>
                    {/if}

                    <!-- Feedback for fallback mode -->
                    {#if st.verified && p.id !== 'ollama'}
                      <div class="auth-feedback auth-feedback-ok">
                        <span>Credentials verified</span>
                        <button class="auth-disconnect" type="button"
                          onclick={(e) => { e.stopPropagation(); ondeselect(p.id); }}>
                          Disconnect
                        </button>
                      </div>
                    {:else if st.error}
                      <div class="auth-feedback auth-feedback-err">
                        {friendlyProviderError(st.errorMessage, p.name) || ('Verification failed — check your ' + (p.needsKey ? 'credentials' : 'endpoint'))}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  {/if}
</div>

{/if}

{#if verifiedCount === 0 && (!hostProviderCount || importMode === 'manual')}
  <label class="allow-empty-row">
    <input type="checkbox" id="allow-empty-install" checked={allowEmptyInstall}
      onchange={(e) => onallowemptyinstallchange?.((e.currentTarget as HTMLInputElement).checked)}>
    <span>Install without an AI provider (assistant won't be able to chat until I add one from the dashboard)</span>
  </label>
{/if}

<div class="step-actions" id="step1-actions">
  <button class="btn btn-secondary" id="btn-step1-back" onclick={onback}>Back</button>
  {#if importMode === 'import' && hostProviderCount > 0}
    <span class="nav-info">Import {hostProviderCount} provider{hostProviderCount !== 1 ? 's' : ''} from host</span>
    <button class="btn btn-primary" id="btn-step1-next" onclick={onhostimport}>Continue</button>
  {:else}
    <span class="nav-info" id="provider-count-info">
      {#if verifiedCount > 0}
        <b>{verifiedCount}</b> provider{verifiedCount > 1 ? 's' : ''} ready
      {:else}
        Connect a provider to continue
      {/if}
    </span>
    <button class="btn btn-primary" id="btn-step1-next" onclick={onnext}
      disabled={verifiedCount === 0 && !allowEmptyInstall}>
      {verifiedCount > 0 ? 'Choose Models' : 'Skip for now'}
    </button>
  {/if}
</div>

<style>
  .host-import-choice {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 8px;
    background: var(--color-surface, #fff);
    margin-bottom: 16px;
  }

  .host-import-desc {
    font-size: 14px;
    color: var(--color-text-secondary, #64748b);
    margin: 0 0 4px;
  }

  .host-radio {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    cursor: pointer;
  }

  .host-radio input[type="radio"] {
    accent-color: var(--color-primary, #6366f1);
  }

  .btn-show-all-providers {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 8px 12px;
    background: none;
    border: 1px dashed var(--color-border, #e2e8f0);
    border-radius: 8px;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary, #64748b);
    cursor: pointer;
    text-align: center;
  }
  .btn-show-all-providers:hover {
    background: var(--color-surface, #f8fafc);
    color: var(--color-text, #1e293b);
  }

  .host-status-warning {
    margin: 0 0 12px;
    padding: 10px 14px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    color: #92400e;
    font-size: var(--text-sm, 0.875rem);
  }

  .allow-empty-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 12px 0;
    padding: 10px 14px;
    background: var(--color-surface, #f8fafc);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 8px;
    font-size: var(--text-sm, 0.875rem);
    cursor: pointer;
  }
  .allow-empty-row input { margin-top: 2px; }

  :global(.auth-feedback-ok) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  :global(.auth-disconnect) {
    background: none;
    border: 1px solid currentColor;
    color: inherit;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: var(--text-xs, 0.75rem);
    cursor: pointer;
    opacity: 0.7;
  }
  :global(.auth-disconnect:hover) { opacity: 1; }
</style>
