<script lang="ts">
  import { CHANNELS, SERVICES } from '$lib/wizard/constants.js';
  import type { ChannelState, RerankingOptions } from '$lib/wizard/types.js';
  import { isChannelEnabled as _isChannelEnabled, getCredValue as _getCredValue } from '$lib/wizard/helpers.js';

  interface Props {
    channelSelection: Record<string, boolean | ChannelState>;
    serviceSelection: Record<string, boolean>;
    hasOllama: boolean;
    ollamaEnabled: boolean;
    reranking: RerankingOptions;
    errorMessage: string;
    onback: () => void;
    onnext: () => void;
    onchanneltoggle: (id: string) => void;
    oncredentialchange: (chId: string, credKey: string, value: string) => void;
    onservicetoggle: (id: string) => void;
    onollamaenabledchange: (v: boolean) => void;
    onrerankingchange: (updates: Partial<RerankingOptions>) => void;
  }

  let {
    channelSelection,
    serviceSelection,
    hasOllama,
    ollamaEnabled,
    reranking,
    errorMessage,
    onback,
    onnext,
    onchanneltoggle,
    oncredentialchange,
    onservicetoggle,
    onollamaenabledchange,
    onrerankingchange,
  }: Props = $props();

  function isChannelEnabled(chId: string, locked?: boolean): boolean {
    return _isChannelEnabled(channelSelection, chId, locked);
  }

  function getCredValue(chId: string, key: string): string {
    return _getCredValue(channelSelection, chId, key);
  }
</script>

<h2>Options</h2>
<p class="step-description">Choose channels, services, and tweak settings before review.</p>

<!-- Channels -->
<div class="options-section">
  <h3 class="options-section-title">Channels</h3>
  <p class="options-section-desc">How you talk to your assistant. Web Chat is always on.</p>
  <div class="toggle-grid" id="channels-grid">
    {#each CHANNELS as ch}
      {@const isOn = isChannelEnabled(ch.id, ch.locked)}
      <div class="toggle-card {isOn ? 'on' : ''} {ch.locked ? 'locked' : ''} {ch.credentials && isOn ? 'wide' : ''}"
        data-channel={ch.id}>
        <div class="toggle-card-header" role="button" tabindex={ch.locked ? -1 : 0}
          onclick={() => { if (!ch.locked) onchanneltoggle(ch.id); }}
          onkeydown={(e) => { if (!ch.locked && (e.key === 'Enter' || e.key === ' ')) onchanneltoggle(ch.id); }}>
          <div class="toggle-card-icon">{ch.icon}</div>
          <div class="toggle-card-info">
            <div class="toggle-card-name">
              {ch.name}
              {#if ch.locked}<span class="badge badge-local">Always on</span>{/if}
            </div>
            <div class="toggle-card-desc">{ch.desc}</div>
          </div>
          <div class="toggle-card-switch">
            {#if ch.locked}
              <div class="toggle-track on locked"><div class="toggle-thumb"></div></div>
            {:else}
              <div class="toggle-track {isOn ? 'on' : ''}"><div class="toggle-thumb"></div></div>
            {/if}
          </div>
        </div>

        {#if ch.credentials && isOn}
          <div class="pcard-auth">
            {#each ch.credentials as cred}
              {@const inputType = cred.secret === false ? 'text' : 'password'}
              <div class="auth-row">
                <label class="channel-cred-label" for="cred-{ch.id}-{cred.key}">
                  {cred.label}
                  {#if cred.required}<span class="channel-cred-required">*</span>{/if}
                </label>
                <input id="cred-{ch.id}-{cred.key}" type={inputType} placeholder={cred.placeholder ?? ''} value={getCredValue(ch.id, cred.key)}
                  oninput={(e) => { e.stopPropagation(); oncredentialchange(ch.id, cred.key, (e.currentTarget as HTMLInputElement).value); }}
                  onclick={(e) => e.stopPropagation()}>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<!-- Services -->
<div class="options-section">
  <h3 class="options-section-title">Services</h3>
  <p class="options-section-desc">Extra capabilities for your stack.</p>
  <div class="toggle-grid" id="services-grid">
    {#each SERVICES as svc}
      {@const isOn = serviceSelection[svc.id]}
      <div class="toggle-card {isOn ? 'on' : ''}" data-service={svc.id}>
        <div class="toggle-card-header" role="button" tabindex="0"
          onclick={() => onservicetoggle(svc.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onservicetoggle(svc.id); }}>
          <div class="toggle-card-icon">{svc.icon}</div>
          <div class="toggle-card-info">
            <div class="toggle-card-name">
              {svc.name}
              {#if svc.recommended}<span class="badge badge-cloud">Recommended</span>{/if}
            </div>
            <div class="toggle-card-desc">{svc.desc}</div>
          </div>
          <div class="toggle-card-switch">
            <div class="toggle-track {isOn ? 'on' : ''}"><div class="toggle-thumb"></div></div>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>

<!-- Ollama addon (only shown when Ollama is a verified provider) -->
{#if hasOllama}
  <div class="addon-row" id="ollama-addon">
    <div class="addon-toggle-row">
      <label class="addon-toggle-label">
        <input type="checkbox" id="ollama-enabled" checked={ollamaEnabled}
          onchange={(e) => onollamaenabledchange((e.currentTarget as HTMLInputElement).checked)}>
        <span class="addon-label-text">Run Ollama inside the stack</span>
      </label>
      <span class="addon-help">Adds an Ollama container to the compose stack so you do not need a separate install.</span>
    </div>
  </div>
{/if}

<!-- Search Reranking -->
<div class="options-section">
  <h3 class="options-section-title">Search Reranking</h3>
  <p class="options-section-desc">Optionally rerank search results returned from the akm stash before they reach the assistant.</p>
  <div class="addon-toggle-row">
    <label class="addon-toggle-label">
      <input type="checkbox" id="reranking-enabled" checked={reranking.enabled}
        onchange={(e) => onrerankingchange({ enabled: (e.currentTarget as HTMLInputElement).checked })}>
      <span class="addon-label-text">Enable reranking</span>
    </label>
    <span class="addon-help">Improves recall by reranking search results using an LLM. Uses the chat model by default.</span>
  </div>

  {#if reranking.enabled}
    <div class="reranking-options" id="reranking-options">
      <div class="field-group">
        <label for="reranking-mode">Reranking Mode</label>
        <select id="reranking-mode" class="field-select"
          value={reranking.mode}
          onchange={(e) => onrerankingchange({ mode: (e.currentTarget as HTMLSelectElement).value as 'llm' | 'dedicated' })}>
          <option value="llm">LLM-based (use chat model)</option>
          <option value="dedicated">Dedicated reranker model</option>
        </select>
      </div>

      {#if reranking.mode === 'dedicated'}
        <div class="field-group" id="reranking-model-group">
          <label for="reranking-model">Reranking Model</label>
          <input id="reranking-model" type="text" placeholder="e.g. BAAI/bge-reranker-v2-m3"
            value={reranking.model}
            oninput={(e) => onrerankingchange({ model: (e.currentTarget as HTMLInputElement).value })}>
        </div>
      {/if}

      <div class="field-row">
        <div class="field-group field-group-half">
          <label for="reranking-top-k">Top K (candidates)</label>
          <input id="reranking-top-k" type="number" min="1" max="100"
            value={reranking.topK}
            oninput={(e) => onrerankingchange({ topK: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 20 })}>
        </div>
        <div class="field-group field-group-half">
          <label for="reranking-top-n">Top N (results)</label>
          <input id="reranking-top-n" type="number" min="1" max="50"
            value={reranking.topN}
            oninput={(e) => onrerankingchange({ topN: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 5 })}>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if errorMessage}
  <div class="field-error" role="alert">{errorMessage}</div>
{/if}

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step4-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step4-next" onclick={onnext}>Review</button>
</div>
