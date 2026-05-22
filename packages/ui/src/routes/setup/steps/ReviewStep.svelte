<script lang="ts">
  import { CHANNELS, TTS_OPTIONS, STT_OPTIONS, PROVIDERS } from '$lib/wizard/constants.js';
  import type { Provider, ModelSelection, ChannelState, RerankingOptions } from '$lib/wizard/types.js';
  import { isChannelEnabled as _isChannelEnabled, getCredValue as _getCredValue } from '$lib/wizard/helpers.js';
  import FriendlyError from '$lib/components/FriendlyError.svelte';
  import { friendlyError } from '$lib/wizard/error-messages.js';

  interface Props {
    adminToken: string;
    ownerName: string;
    ownerEmail: string;
    verifiedProviders: Provider[];
    modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
    activeTts: string;
    activeStt: string;
    channelSelection: Record<string, boolean | ChannelState>;
    ollamaEnabled: boolean;
    reranking: RerankingOptions;
    payload: unknown;
    installError: string;
    installing: boolean;
    onback: () => void;
    oninstall: () => void;
    ongostepedit: (step: number) => void;
  }

  let {
    adminToken,
    ownerName,
    ownerEmail,
    verifiedProviders,
    modelSelection,
    activeTts,
    activeStt,
    channelSelection,
    ollamaEnabled,
    reranking,
    payload,
    installError,
    installing,
    onback,
    oninstall,
    ongostepedit,
  }: Props = $props();

  let showJson = $state(false);

  function maskToken(token: string): string {
    if (!token || token.length < 8) return '(not set)';
    return token.slice(0, 4) + '...' + token.slice(-4);
  }

  function isChannelEnabled(chId: string, locked?: boolean): boolean {
    return _isChannelEnabled(channelSelection, chId, locked);
  }

  function getCredValue(chId: string, key: string): string {
    return _getCredValue(channelSelection, chId, key);
  }

  const ttsOpt = $derived(TTS_OPTIONS.find((o) => o.id === activeTts));
  const sttOpt = $derived(STT_OPTIONS.find((o) => o.id === activeStt));
  const activeChannels = $derived(CHANNELS.filter((ch) => isChannelEnabled(ch.id, ch.locked)));

  function findProvider(connId: string): Provider | undefined {
    return PROVIDERS.find((p) => p.id === connId);
  }
</script>

<h2>Review &amp; Install</h2>
<p class="step-description">Confirm your settings, then install.</p>

<div id="review-summary">
  <!-- Account -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Account</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(0)}>Edit</button>
    </div>
    <div class="review-row">
      <span class="review-row-label">Admin Token</span>
      <span class="review-row-value">{maskToken(adminToken)}</span>
    </div>
    {#if ownerName}
      <div class="review-row">
        <span class="review-row-label">Name</span>
        <span class="review-row-value">{ownerName}</span>
      </div>
    {/if}
    {#if ownerEmail}
      <div class="review-row">
        <span class="review-row-label">Email</span>
        <span class="review-row-value">{ownerEmail}</span>
      </div>
    {/if}
  </div>

  <!-- Providers -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Providers</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(1)}>Edit</button>
    </div>
    {#each verifiedProviders as p}
      <div class="review-row">
        <span class="review-row-label">{p.icon} {p.name}</span>
        <span class="review-row-value review-row-value-ok">Connected ✓</span>
      </div>
    {/each}
  </div>

  <!-- Models -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Models</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(2)}>Edit</button>
    </div>
    {#if modelSelection.llm}
      {@const llmProv = findProvider(modelSelection.llm.connId)}
      <div class="review-row">
        <span class="review-row-label">Chat Model</span>
        <span class="review-row-value">{modelSelection.llm.model}{llmProv ? ' (' + llmProv.name + ')' : ''}</span>
      </div>
    {/if}
    {#if modelSelection.small?.model}
      {@const smallProv = findProvider(modelSelection.small.connId)}
      <div class="review-row">
        <span class="review-row-label">Small Model</span>
        <span class="review-row-value">{modelSelection.small.model}{smallProv ? ' (' + smallProv.name + ')' : ''}</span>
      </div>
    {/if}
    {#if modelSelection.embedding}
      {@const embProv = findProvider(modelSelection.embedding.connId)}
      <div class="review-row">
        <span class="review-row-label">Embedding Model</span>
        <span class="review-row-value">{modelSelection.embedding.model}{embProv ? ' (' + embProv.name + ')' : ''}</span>
      </div>
      <div class="review-row">
        <span class="review-row-label">Embedding Dims</span>
        <span class="review-row-value">{modelSelection.embedding.dims ?? 1536}</span>
      </div>
    {/if}
  </div>

  <!-- Voice -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Voice</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(3)}>Edit</button>
    </div>
    <div class="review-row">
      <span class="review-row-label">Text-to-Speech</span>
      <span class="review-row-value">{ttsOpt ? ttsOpt.name : 'Disabled'}</span>
    </div>
    <div class="review-row">
      <span class="review-row-label">Speech-to-Text</span>
      <span class="review-row-value">{sttOpt ? sttOpt.name : 'Disabled'}</span>
    </div>
  </div>

  <!-- Channels -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Channels</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(4)}>Edit</button>
    </div>
    {#each activeChannels as ch}
      <div class="review-row">
        <span class="review-row-label">{ch.icon} {ch.name}</span>
        <span class="review-row-value review-row-value-ok">Enabled ✓</span>
      </div>
      {#if ch.credentials}
        {@const sel = channelSelection[ch.id]}
        {#if typeof sel === 'object' && sel !== null && sel.enabled}
          {#each ch.credentials as cred}
            {@const val = getCredValue(ch.id, cred.key)}
            {#if val}
              <div class="review-row">
                <span class="review-row-label" style="padding-left:24px">{cred.label}</span>
                <span class="review-row-value">{maskToken(val)}</span>
              </div>
            {/if}
          {/each}
        {/if}
      {/if}
    {/each}
  </div>

  <!-- Options -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Options</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(4)}>Edit</button>
    </div>
    {#if ollamaEnabled}
      <div class="review-row">
        <span class="review-row-label">Ollama In-Stack</span>
        <span class="review-row-value">Enabled</span>
      </div>
    {/if}
    {#if reranking.enabled}
      <div class="review-row">
        <span class="review-row-label">Reranking</span>
        <span class="review-row-value">Enabled ({reranking.mode})</span>
      </div>
      {#if reranking.mode === 'dedicated' && reranking.model}
        <div class="review-row">
          <span class="review-row-label">Reranking Model</span>
          <span class="review-row-value">{reranking.model}</span>
        </div>
      {/if}
      <div class="review-row">
        <span class="review-row-label">Reranking Top K / N</span>
        <span class="review-row-value">{reranking.topK} / {reranking.topN}</span>
      </div>
    {:else}
      <div class="review-row">
        <span class="review-row-label">Reranking</span>
        <span class="review-row-value">Disabled</span>
      </div>
    {/if}
  </div>
</div>

<div class="review-json-toggle" id="review-json-toggle">
  <button class="btn-json-toggle" type="button" onclick={() => showJson = !showJson}>
    {showJson ? 'Hide Setup JSON' : 'Show Setup JSON'}
  </button>
</div>

{#if showJson}
  <div class="review-json" id="review-json">
    <pre id="review-json-pre">{JSON.stringify(payload, null, 2)}</pre>
  </div>
{/if}

{#if installError}
  <FriendlyError error={friendlyError(installError, 'setup-complete')} />
{/if}

<div class="step-actions" id="review-actions">
  <button class="btn btn-secondary" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-install" onclick={oninstall} disabled={installing}>
    {#if installing}<span class="spinner"></span> Installing...{:else}Install{/if}
  </button>
</div>
