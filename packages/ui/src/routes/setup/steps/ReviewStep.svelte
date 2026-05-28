<script lang="ts">
  import { CHANNELS, TTS_OPTIONS, STT_OPTIONS, PROVIDERS } from '$lib/wizard/constants.js';
  import type { Provider, ModelSelection, ChannelState } from '$lib/wizard/types.js';
  import { isChannelEnabled as _isChannelEnabled, getCredValue as _getCredValue } from '$lib/wizard/helpers.js';
  import FriendlyError from '$lib/components/FriendlyError.svelte';
  import { friendlyError } from '$lib/wizard/error-messages.js';

  interface Props {
    uiLoginPassword: string;
    verifiedProviders: Provider[];
    modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
    activeTts: string;
    activeStt: string;
    voiceProfileLabel?: string;
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
    uiLoginPassword,
    verifiedProviders,
    modelSelection,
    activeTts,
    activeStt,
    voiceProfileLabel = '',
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

  function maskSecret(value: string): string {
    if (!value || value.length < 8) return '(not set)';
    return value.slice(0, 4) + '...' + value.slice(-4);
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

  let passwordCopied = $state(false);
  let copyFallback = $state(false);
  let passwordInputEl: HTMLInputElement | null = $state(null);

  function saveConfig(config: unknown): void {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'openpalm-setup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyPassword(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(uiLoginPassword);
        passwordCopied = true;
        setTimeout(() => { passwordCopied = false; }, 2000);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch {
      copyFallback = true;
      if (passwordInputEl) {
        passwordInputEl.focus();
        passwordInputEl.select();
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
    {#if !isRerun}
      <div class="review-row review-row--alert">
        <span class="review-row-label">UI Login Password</span>
        <span class="review-row-value">
          {#if copyFallback}
            <input
              bind:this={passwordInputEl}
              class="token-save-input"
              type="password"
              readonly
              value={uiLoginPassword}
              onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
            />
          {:else}
            <span class="token-save-box">{uiLoginPassword.substring(0,2)}*********</span>
          {/if}
        </span>
      </div>
      <div class="review-row review-row--alert">
        <span class="review-row-label">  <span class="token-save-hint">You'll need this to sign in. Also saved in <code>stack.env</code>.</span>
        </span>
        <span class="review-row-value"> 
       
          <button type="button" class="btn btn-secondary btn-sm" onclick={() => void copyPassword()}>
            {passwordCopied ? 'Copied!' : 'Copy password'}
          </button>
        </span>
      </div>
    {:else}
      <div class="review-row">
        <span class="review-row-label">UI Login Password</span>
        <span class="review-row-value">{maskSecret(uiLoginPassword)}</span>
      </div>
    {/if}
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
       <div class="review-row" style="padding:4px 0">
        <span class="review-row-label">Embedding Dims</span>
        <span class="review-row-value">{modelSelection.embedding.dims ?? 1536}</span>
      </div>
    {/if}
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
                <span class="review-row-value">{maskSecret(val)}</span>
              </div>
            {/if}
          {/each}
        {/if}
      {/if}
    {/each}
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
    {#if voiceProfileLabel && (activeTts === 'openpalm-voice' || activeStt === 'openpalm-voice')}
      <div class="review-row">
        <span class="review-row-label">Voice Container</span>
        <span class="review-row-value">{voiceProfileLabel}</span>
      </div>
    {/if}
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
</div>
{#if installError}
  <FriendlyError error={friendlyError(installError, 'setup-complete')} />
{/if}

<div class="step-actions" id="review-actions">
  <button type="button" class="btn btn-info" onclick={() => saveConfig(payload)}>
    Save configuration
  </button>
  <button class="btn btn-secondary" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-install" onclick={oninstall} disabled={installing}>
    {#if installing}<span class="spinner"></span> Installing...{:else}Install{/if}
  </button>
</div>

<style>
  .review-actions-secondary {
    display: flex;
    justify-content: center;
    margin: 12px 0 4px;
  }

  .review-warning {
    margin: 12px 0;
    padding: 10px 14px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    font-size: var(--text-sm, 0.875rem);
    color: #92400e;
  }

  .review-row--alert {
    align-items: flex-start;
  }
  .token-save-box {
    font-family: monospace;
    font-size: var(--text-sm, 0.875rem);
    background: #fff;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 4px 8px;
    word-break: break-all;
    user-select: all;
    display: inline-block;
  }
  .token-save-input {
    font-family: monospace;
    font-size: var(--text-sm, 0.875rem);
    background: #fff;
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 6px;
    padding: 4px 8px;
    width: 100%;
  }
  .token-save-hint {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-tertiary, #94a3b8);
    margin-left: 8px;
  }
  .token-save-hint code {
    font-family: monospace;
    background: var(--color-bg-secondary, #f1f5f9);
    padding: 1px 5px;
    border-radius: 4px;
  }
</style>
