<script lang="ts">
  import { CHANNELS } from '$lib/wizard/constants.js';
  import type { ChannelState } from '$lib/wizard/types.js';
  import { isChannelEnabled as _isChannelEnabled, getCredValue as _getCredValue } from '$lib/wizard/helpers.js';

  interface Props {
    channelSelection: Record<string, boolean | ChannelState>;
    hasOllama: boolean;
    ollamaEnabled: boolean;
    imageTag: string;
    hostAkmEnabled: boolean;
    hostAkmAvailable: boolean;
    errorMessage: string;
    onback: () => void;
    onnext: () => void;
    onchanneltoggle: (id: string) => void;
    oncredentialchange: (chId: string, credKey: string, value: string) => void;
    onollamaenabledchange: (v: boolean) => void;
    onimagtagchange: (v: string) => void;
    onhostakmchange: (v: boolean) => void;
  }

  let {
    channelSelection,
    hasOllama,
    ollamaEnabled,
    imageTag,
    hostAkmEnabled,
    hostAkmAvailable,
    errorMessage,
    onback,
    onnext,
    onchanneltoggle,
    oncredentialchange,
    onollamaenabledchange,
    onimagtagchange,
    onhostakmchange,
  }: Props = $props();

  function isChannelEnabled(chId: string, locked?: boolean): boolean {
    return _isChannelEnabled(channelSelection, chId, locked);
  }

  function getCredValue(chId: string, key: string): string {
    return _getCredValue(channelSelection, chId, key);
  }
</script>

<h2>Options</h2>
<p class="step-description">Configure channels and deployment options.</p>

<!-- Channels -->
<div class="options-section">
  <h3 class="options-section-title">Channels</h3>
  <p class="options-section-desc">Additional ways to reach your assistant.</p>
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

<!-- Advanced settings disclosure -->
<details id="options-advanced-details">
  <summary class="options-advanced-summary" id="options-advanced-toggle">Advanced settings</summary>

  <!-- Image tag section -->
  <div class="options-section">
    <h3 class="options-section-title">Container Image</h3>
    <p class="options-section-desc">Tag or version of the OpenPalm images to deploy.</p>
    <div class="field-group">
      <label for="image-tag">Image tag</label>
      <div class="field-hint">Advanced — leave blank to use the default.</div>
      <input id="image-tag" type="text" placeholder="dev" value={imageTag}
        oninput={(e) => onimagtagchange((e.currentTarget as HTMLInputElement).value)}>
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

  <!-- Host AKM section (only shown when ~/akm exists on the host) -->
  {#if hostAkmAvailable}
    <div class="options-section">
      <h3 class="options-section-title">Shared AKM Environment</h3>
      <p class="options-section-desc">Mount your host akm stash, index, and cache into the assistant container so the assistant and your local akm share the same knowledge base.</p>
      <div class="addon-toggle-row">
        <label class="addon-toggle-label">
          <input type="checkbox" id="host-akm-enabled" checked={hostAkmEnabled}
            onchange={(e) => onhostakmchange((e.currentTarget as HTMLInputElement).checked)}>
          <span class="addon-label-text">Share host AKM environment</span>
        </label>
        <span class="addon-help">Lets the assistant read and write to your personal knowledge files on this computer.</span>
      </div>
    </div>
  {/if}

</details>

{#if errorMessage}
  <div class="field-error" role="alert">{errorMessage}</div>
{/if}

<div class="step-actions">
  <button class="btn btn-secondary" id="btn-step4-back" onclick={onback}>Back</button>
  <button class="btn btn-primary" id="btn-step4-next" onclick={onnext}>Review</button>
</div>

<style>
  .options-advanced-summary {
    cursor: pointer;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary, #64748b);
    font-weight: 500;
    padding: 8px 0;
    list-style: none;
    margin-top: 8px;
  }
  .options-advanced-summary::-webkit-details-marker { display: none; }
  .options-advanced-summary::before { content: '▶ '; font-size: 0.7em; }
  details[open] .options-advanced-summary::before { content: '▼ '; }
  .field-hint {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary, #64748b);
    margin: 2px 0 4px;
  }
</style>
