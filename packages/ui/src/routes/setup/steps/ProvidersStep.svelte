<script lang="ts">
  import { PROVIDERS, PROVIDER_GROUPS } from '$lib/wizard/constants.js';
  import type { ProviderState, DetectedProvider, OpenCodeProvider, AuthMethod } from '$lib/wizard/types.js';

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
</script>

<h2>Where should your models run?</h2>
<p class="step-description">Select one or more providers. Click a card to configure it.</p>

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

    {#each filteredOcProviders as ocp}
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
          <div class="pcard-check" role="button" tabindex="0"
            onclick={(e) => { e.stopPropagation(); if (st.verified) ondeselect(ocp.id); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); if (st.verified) ondeselect(ocp.id); } }}>
            {st.verified ? '✓' : ''}
          </div>
        </div>

        <!-- Expanded auth panel -->
        {#if isExpanded}
          <div class="pcard-auth">
            {#if st.verified}
              <div class="auth-feedback auth-feedback-ok">Connected</div>
            {:else}
              {#if st.error}
                <div class="auth-feedback auth-feedback-err">{st.errorMessage ?? 'Connection failed'}</div>
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
                  <div class="pcard-check" role="button" tabindex="0"
                    onclick={(e) => { e.stopPropagation(); if (st.selected) ondeselect(p.id); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); if (st.selected) ondeselect(p.id); } }}>
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
                          <div class="auth-feedback auth-feedback-ok">Ollama will be added to your Docker stack with default models.</div>
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
                      <div class="auth-feedback auth-feedback-ok">Credentials verified</div>
                    {:else if st.error}
                      <div class="auth-feedback auth-feedback-err">
                        Verification failed — {st.errorMessage ?? ('check your ' + (p.needsKey ? 'credentials' : 'endpoint'))}
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
        Connect a provider, or skip and configure later
      {/if}
    </span>
    <button class="btn btn-primary" id="btn-step1-next" onclick={onnext}>
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
</style>
