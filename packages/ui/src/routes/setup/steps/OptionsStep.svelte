<script lang="ts">
  import { CHANNELS } from '$lib/wizard/constants.js';
  import type { ChannelState } from '$lib/wizard/types.js';
  import type { VoiceAddonProfile } from '$lib/api.js';
  import { isChannelEnabled as _isChannelEnabled, getCredValue as _getCredValue } from '$lib/wizard/helpers.js';
  import VoiceProfileSelector from '$lib/components/voice/VoiceProfileSelector.svelte';
  import FormField from '$lib/components/common/FormField.svelte';
  import SettingToggle from '$lib/components/common/SettingToggle.svelte';

  interface Props {
    channelSelection: Record<string, boolean | ChannelState>;
    imageTag: string;
    hostAkmEnabled: boolean;
    hostAkmAvailable: boolean;
    enableVoice: boolean;
    voiceProfiles: VoiceAddonProfile[];
    selectedVoiceProfile: string;
    ollamaEnabled: boolean;
    ollamaProfiles: VoiceAddonProfile[];
    selectedOllamaProfile: string;
    /** True when Ollama/LM Studio is already running on the host — the in-stack
     * Ollama addon is redundant, so its toggle is disabled with a note. */
    hostLocalRunning?: boolean;
    errorMessage: string;
    onback: () => void;
    onnext: () => void;
    onchanneltoggle: (id: string) => void;
    oncredentialchange: (chId: string, credKey: string, value: string) => void;
    onimagtagchange: (v: string) => void;
    onhostakmchange: (v: boolean) => void;
    onenablevoicechange: (v: boolean) => void;
    onvoiceprofilechange: (id: string) => void;
    onollamachange: (v: boolean) => void;
    onollamaprofilechange: (id: string) => void;
  }

  let {
    channelSelection,
    imageTag,
    hostAkmEnabled,
    hostAkmAvailable,
    enableVoice,
    voiceProfiles,
    selectedVoiceProfile,
    ollamaEnabled,
    ollamaProfiles,
    selectedOllamaProfile,
    hostLocalRunning = false,
    errorMessage,
    onback,
    onnext,
    onchanneltoggle,
    oncredentialchange,
    onimagtagchange,
    onhostakmchange,
    onenablevoicechange,
    onvoiceprofilechange,
    onollamachange,
    onollamaprofilechange,
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
      <div data-channel={ch.id}>
        <SettingToggle
          title={ch.name}
          description={ch.desc}
          icon={ch.icon}
          checked={isOn}
          locked={!!ch.locked}
          expanded={!!(ch.credentials && isOn)}
          onToggle={() => onchanneltoggle(ch.id)}
        >
          {#snippet titleSuffix()}
            {#if ch.locked}<span class="badge badge-success">Always on</span>{/if}
          {/snippet}
          {#snippet children()}
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
          {/snippet}
        </SettingToggle>
      </div>
    {/each}
  </div>
</div>

<!-- Add-ons -->
<div class="options-section">
  <h3 class="options-section-title">Add-ons</h3>
  <p class="options-section-desc">Optional features to extend your assistant.</p>
  <div class="toggle-grid" id="addons-grid">

    <!-- Voice -->
    <SettingToggle
      title="Voice"
      description="Bundled text-to-speech and speech-to-text. Requires a one-time local model download."
      icon="🎙️"
      checked={enableVoice}
      expanded={enableVoice && voiceProfiles.length > 0}
      onToggle={() => onenablevoicechange(!enableVoice)}
    >
      {#snippet children()}
        <VoiceProfileSelector profiles={voiceProfiles} selectedProfile={selectedVoiceProfile} onchange={onvoiceprofilechange} showDescription={false} />
      {/snippet}
    </SettingToggle>

    <!-- Ollama -->
    <SettingToggle
      title="Ollama"
      description={hostLocalRunning
        ? "Ollama or LM Studio is already running on your computer — the bundled Ollama isn't needed."
        : 'Run local AI models inside the stack. Downloads and serves models via Docker.'}
      icon="🦙"
      checked={ollamaEnabled && !hostLocalRunning}
      disabled={hostLocalRunning}
      expanded={ollamaEnabled && !hostLocalRunning && ollamaProfiles.length > 0}
      onToggle={() => onollamachange(!ollamaEnabled)}
    >
      {#snippet children()}
        <VoiceProfileSelector profiles={ollamaProfiles} selectedProfile={selectedOllamaProfile} onchange={onollamaprofilechange} showDescription={false} />
      {/snippet}
    </SettingToggle>

  </div>
</div>

<!-- Advanced settings disclosure -->
<details id="options-advanced-details">
  <summary class="options-advanced-summary" id="options-advanced-toggle">Advanced settings</summary>

  <!-- Image tag section -->
  <div class="options-section">
    <h3 class="options-section-title">Container Image</h3>
    <p class="options-section-desc">Tag or version of the OpenPalm images to deploy.</p>
    <FormField label="Image tag" for="image-tag" hint="Advanced — leave blank to use the default.">
      <input id="image-tag" class="form-input" type="text" placeholder="dev" value={imageTag}
        oninput={(e) => onimagtagchange((e.currentTarget as HTMLInputElement).value)}>
    </FormField>
  </div>

  <!-- Shared AKM (only shown when ~/akm exists on the host) -->
  {#if hostAkmAvailable}
    <div class="options-section">
      <h3 class="options-section-title">Share knowledge with my host AKM</h3>
      <p class="options-section-desc">Adds a source entry to your personal <code>~/.config/akm/config.json</code> and mounts <code>~/akm</code> into the assistant as a secondary source. Your files' ownership is not changed and your primary stash is unchanged — your <code>~/akm</code> data and cache stay yours.</p>
      <div class="toggle-grid">
        <SettingToggle
          title="Share knowledge with my host AKM (read + contribute)"
          description="The assistant reads your personal knowledge and can contribute back. Each side keeps its own primary stash, database, and cache — only the knowledge files are shared."
          icon="🧠"
          checked={hostAkmEnabled}
          onToggle={() => onhostakmchange(!hostAkmEnabled)}
        />
      </div>
    </div>
  {/if}

</details>

{#if errorMessage}
  <div class="feedback feedback--error" role="alert"><span>{errorMessage}</span></div>
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
</style>
