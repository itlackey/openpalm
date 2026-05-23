<script lang="ts">
  import { CHANNELS, TTS_OPTIONS, STT_OPTIONS, PROVIDERS } from '$lib/wizard/constants.js';
  import type { Provider, ModelSelection, ChannelState } from '$lib/wizard/types.js';
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
    payload: unknown;
    installError: string;
    installing: boolean;
    isRerun?: boolean;
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
    payload,
    installError,
    installing,
    isRerun = false,
    onback,
    oninstall,
    ongostepedit,
  }: Props = $props();

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

  let tokenCopied = $state(false);
  let copyFallback = $state(false);
  let tokenInputEl: HTMLInputElement | null = $state(null);

  async function copyAdminToken(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(adminToken);
        tokenCopied = true;
        setTimeout(() => { tokenCopied = false; }, 2000);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch {
      copyFallback = true;
      if (tokenInputEl) {
        tokenInputEl.focus();
        tokenInputEl.select();
      }
    }
  }
</script>

<h2>Review &amp; Install</h2>
<p class="step-description">Confirm your settings, then install.</p>

{#if verifiedProviders.length === 0}
  <div class="review-warning" role="alert">
    ⚠ No AI provider connected — your assistant won't be able to chat until you add one from the dashboard.
  </div>
{/if}

<div id="review-summary">
  <!-- Account -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Account</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(1)}>Edit</button>
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
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(2)}>Edit</button>
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
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(3)}>Edit</button>
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
        <span class="review-row-label">Memory Model</span>
        <span class="review-row-value">{modelSelection.embedding.model}{embProv ? ' (' + embProv.name + ')' : ''}</span>
      </div>
    {/if}
  </div>

  <!-- Voice -->
  <div class="review-card">
    <div class="review-card-title">
      <span>Voice</span>
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(4)}>Edit</button>
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
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(5)}>Edit</button>
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
      <button class="review-edit-btn" type="button" onclick={() => ongostepedit(5)}>Edit</button>
    </div>
    {#if ollamaEnabled}
      <div class="review-row">
        <span class="review-row-label">Ollama In-Stack</span>
        <span class="review-row-value">Enabled</span>
      </div>
    {/if}
  </div>
</div>

{#if !isRerun}
  <div class="token-save-panel" id="token-save-panel">
    <div class="token-save-header">
      <strong>Save your admin token</strong>
      <span class="token-save-sub">You'll need it to log in. Run <code>openpalm token</code> from a terminal anytime to see it again.</span>
    </div>
    {#if copyFallback}
      <input
        bind:this={tokenInputEl}
        class="token-save-input"
        type="text"
        readonly
        value={adminToken}
        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
      />
    {:else}
      <div class="token-save-box">{adminToken}</div>
    {/if}
    <button type="button" class="btn btn-secondary token-save-copy" onclick={() => void copyAdminToken()}>
      {tokenCopied ? 'Copied!' : 'Copy token'}
    </button>
  </div>
{/if}

<details id="review-json-details">
  <summary class="review-advanced-summary" id="review-json-toggle">Advanced</summary>
  <div class="review-json" id="review-json" style="margin-top:8px">
    {#if modelSelection.embedding}
      <div class="review-row" style="padding:4px 0">
        <span class="review-row-label">Embedding Dims</span>
        <span class="review-row-value">{modelSelection.embedding.dims ?? 1536}</span>
      </div>
    {/if}
    <pre id="review-json-pre">{JSON.stringify(payload, null, 2)}</pre>
  </div>
</details>

{#if installError}
  <FriendlyError error={friendlyError(installError, 'setup-complete')} />
{/if}

<div class="step-actions" id="review-actions">
  <button class="btn btn-secondary" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-install" onclick={oninstall} disabled={installing}>
    {#if installing}<span class="spinner"></span> Installing...{:else}Install{/if}
  </button>
</div>

<style>
  .review-advanced-summary {
    cursor: pointer;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary, #64748b);
    font-weight: 500;
    padding: 6px 0;
    list-style: none;
  }
  .review-advanced-summary::-webkit-details-marker { display: none; }
  .review-advanced-summary::before { content: '▶ '; font-size: 0.7em; }
  details[open] .review-advanced-summary::before { content: '▼ '; }

  .review-warning {
    margin: 12px 0;
    padding: 10px 14px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    font-size: var(--text-sm, 0.875rem);
    color: #92400e;
  }

  .token-save-panel {
    margin: 16px 0;
    padding: 14px 16px;
    background: #fef3c7;
    border: 1px solid #fcd34d;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .token-save-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: #78350f;
  }
  .token-save-sub {
    font-size: var(--text-xs, 0.75rem);
    color: #92400e;
    font-weight: 400;
  }
  .token-save-sub code {
    font-family: monospace;
    background: rgba(255,255,255,0.6);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .token-save-box {
    font-family: monospace;
    font-size: var(--text-sm, 0.875rem);
    background: #fff;
    border: 1px solid #fcd34d;
    border-radius: 6px;
    padding: 8px 10px;
    word-break: break-all;
    user-select: all;
  }
  .token-save-input {
    font-family: monospace;
    font-size: var(--text-sm, 0.875rem);
    background: #fff;
    border: 1px solid #fcd34d;
    border-radius: 6px;
    padding: 8px 10px;
    width: 100%;
  }
  .token-save-copy {
    align-self: flex-start;
  }
</style>
