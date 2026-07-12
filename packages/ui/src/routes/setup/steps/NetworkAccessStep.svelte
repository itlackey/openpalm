<script lang="ts">
  /**
   * NetworkAccessStep — the wizard's network access preset selector (#563 D5).
   *
   * Rendered as a section of the Finish step (ReviewStep), not a fourth
   * screen: the default choice ("This PC only") requires zero interaction, so
   * a dedicated screen would add a click for every user to serve the
   * non-default minority.
   *
   * Self-contained (ReviewStep pattern): takes NO props, reads/writes the
   * setup-state store directly so the deferred #506 design pass can promote
   * it to its own screen without any logic changes.
   */
  import {
    NETWORK_ACCESS_PRESETS,
    NETWORK_PRESET_LABELS,
    type NetworkAccessPreset,
  } from '@openpalm/lib/control-plane/network-preset.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  const s = setupState;
  const networkPreset = $derived(s.networkPreset);
  const opencodePassword = $derived(s.opencodePassword);
  const homeOpenAck = $derived(s.homeOpenAck);

  // Plain-language exposure sentence per preset — always visible (not just on
  // selection), per D5. `.local` names/URLs are illustrative examples; the
  // real names derive from the operator's compose project name and are shown
  // authoritatively post-install (Dashboard → Assistant).
  const EXPOSURE_COPY: Record<NetworkAccessPreset, string> = {
    'this-pc': 'Nothing here is reachable from other devices — only this computer can use the assistant.',
    'home-password':
      'Devices on your network can open the assistant (e.g. http://openpalm.local:3800) and sign in with this password. Connected apps use the same password.',
    'home-open':
      'Anyone on your network can use the assistant without a password. The built-in browser chat client stays disabled in this mode — LAN users get OpenCode\'s own web UI instead.',
    'shared-guardian':
      "Only the guardian's protected front door is reachable (e.g. http://openpalm-guardian.local); the assistant itself stays private on this PC. Enables the built-in chat portal when no other portal is selected, so the front door actually runs. Connecting apps and devices need credentials you issue from the dashboard (Pair a device / API key).",
  };

  function selectPreset(preset: NetworkAccessPreset): void {
    s.handleNetworkPresetChange(preset);
  }

  function onPasswordInput(e: Event): void {
    s.handleOpencodePasswordInput((e.currentTarget as HTMLInputElement).value);
  }

  function onAckChange(e: Event): void {
    s.handleHomeOpenAckChange((e.currentTarget as HTMLInputElement).checked);
  }
</script>

<div class="network-step">
  <p class="network-step-label">Network access</p>

  {#if networkPreset === null}
    <p class="network-custom-notice">
      Custom network settings detected — kept as-is unless you pick a preset below.
    </p>
  {/if}

  <div class="network-option-list" role="radiogroup" aria-label="Network access preset">
    {#each NETWORK_ACCESS_PRESETS as preset (preset)}
      <div class="network-option">
        <button
          type="button"
          class="network-option-row"
          class:network-option-row--selected={networkPreset === preset}
          role="radio"
          aria-checked={networkPreset === preset}
          onclick={() => selectPreset(preset)}
        >
          <div class="network-option-dot"><div class="network-option-dot-inner"></div></div>
          <div class="network-option-body">
            <div class="network-option-title">{NETWORK_PRESET_LABELS[preset]}</div>
            <div class="network-option-sub">{EXPOSURE_COPY[preset]}</div>
          </div>
        </button>

        {#if preset === 'home-password' && networkPreset === 'home-password'}
          <div class="network-option-detail">
            <label class="field" for="network-opencode-password">
              <span>Password</span>
              <input
                id="network-opencode-password"
                class="control-input mono"
                type="text"
                autocomplete="new-password"
                spellcheck="false"
                value={opencodePassword}
                oninput={onPasswordInput}
              />
            </label>
          </div>
        {/if}

        {#if preset === 'home-open' && networkPreset === 'home-open'}
          <div class="network-option-detail">
            <p class="network-risk-warning" role="alert">
              Anyone on your network will be able to use the assistant without a password — only choose this on
              a network you trust.
            </p>
            <label class="field-inline">
              <input type="checkbox" checked={homeOpenAck} onchange={onAckChange} />
              <span>I understand this exposes the assistant to everyone on my network without a password.</span>
            </label>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <p class="network-mdns-note">
    <code>.local</code> names are broadcast by the host <code>openpalm</code> process while it runs — the exact
    names appear after install in Dashboard → Assistant.
  </p>
</div>

<style>
  .network-step {
    margin-top: 24px;
  }

  .network-step-label {
    font-size: var(--s-type-deed);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-bottom: 10px;
  }

  .network-custom-notice {
    margin: 0 0 12px;
    padding: 10px 14px;
    background: var(--s-paper-deep);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    line-height: 1.5;
    color: var(--s-ink-2);
  }

  .network-option-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .network-option-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    padding: 12px 14px;
    border-radius: 2px;
    border: var(--s-hair) solid transparent;
    background: none;
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }

  .network-option-row:hover {
    background: var(--s-paper-deep);
  }

  .network-option-row--selected {
    background: color-mix(in srgb, var(--s-seal) 6%, var(--s-paper));
    border-color: color-mix(in srgb, var(--s-seal) 20%, transparent);
  }

  .network-option-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--s-line);
    flex-shrink: 0;
    margin-top: 2px;
    display: grid;
    place-items: center;
  }

  .network-option-row--selected .network-option-dot {
    border-color: var(--s-seal);
  }

  .network-option-dot-inner {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
  }

  .network-option-row--selected .network-option-dot-inner {
    background: var(--s-seal);
  }

  .network-option-body {
    flex: 1;
    min-width: 0;
  }

  .network-option-title {
    font-size: var(--s-type-deed);
    font-weight: 600;
    color: var(--s-ink);
  }

  .network-option-sub {
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin-top: 2px;
    line-height: 1.4;
  }

  .network-option-detail {
    padding: 4px 14px 12px 42px;
  }

  .field {
    display: grid;
    gap: 4px;
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .control-input {
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    background: none;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
    width: 100%;
  }

  .control-input:focus {
    outline: none;
    border-bottom-color: var(--s-ink-2);
  }

  .mono {
    font-family: var(--s-font-mono);
  }

  .network-risk-warning {
    margin: 0 0 10px;
    padding: 10px 14px;
    background: rgba(242, 92, 92, 0.12);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    line-height: 1.5;
  }

  .field-inline {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }

  .network-mdns-note {
    margin: 14px 0 0;
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    line-height: 1.5;
  }
</style>
