<script lang="ts">
  /**
   * NetworkAccessStep — the wizard's access toggles.
   *
   * Rendered as a section of the Finish step (ReviewStep), not a screen of its
   * own: the default (everything closed) needs zero interaction, so a
   * dedicated screen would add a click for every user to serve a minority.
   *
   * Progressive disclosure. ONE question is always visible — can other devices
   * on your network use the assistant. The guardian toggles appear only once a
   * guardian-backed integration is selected, because publishing a front door
   * to a service that is not deployed does nothing. Direct assistant exposure
   * sits under Advanced: the built-in client never uses it, so it exists for a
   * second desktop app or a third-party OpenCode client.
   *
   * Self-contained (ReviewStep pattern): takes NO props, reads and writes the
   * setup-state store directly.
   */
  import {
    ACCESS_TOGGLE_DESCRIPTIONS,
    ACCESS_TOGGLE_LABELS,
    type AccessToggles,
  } from '@openpalm/lib/control-plane/access-toggles.js';
  import { GUARDIAN_INGRESS_ADDON_IDS } from '@openpalm/lib/control-plane/addon-ids.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  const s = setupState;
  const access = $derived(s.access);

  // The guardian is profile-gated behind ingress addons, so its toggles are
  // meaningless until one is selected — publishing a port to a service that
  // will not be deployed is exactly the kind of dead switch this redesign
  // removes.
  const guardianSelected = $derived(
    GUARDIAN_INGRESS_ADDON_IDS.some((id) => {
      const selection = s.portalSelection[id];
      return typeof selection === 'object' && selection !== null && selection.enabled === true;
    }),
  );

  let showAdvanced = $state(false);

  const GUARDIAN_KEYS: (keyof AccessToggles)[] = ['guardianNetwork', 'guardianOpenaiApi'];

  function set(key: keyof AccessToggles, value: boolean): void {
    s.setAccessToggle(key, value);
  }
</script>

<div class="network-step">
  <p class="network-step-label">Network access</p>

  <label class="access-row" for="access-networkAccess">
    <input
      id="access-networkAccess"
      type="checkbox"
      checked={access.networkAccess}
      onchange={(e) => set('networkAccess', e.currentTarget.checked)}
    />
    <span class="access-body">
      <span class="access-title">{ACCESS_TOGGLE_LABELS.networkAccess}</span>
      <span class="access-sub">{ACCESS_TOGGLE_DESCRIPTIONS.networkAccess}</span>
    </span>
  </label>

  {#if guardianSelected}
    {#each GUARDIAN_KEYS as key (key)}
      <label class="access-row" for={`access-${key}`}>
        <input
          id={`access-${key}`}
          type="checkbox"
          checked={access[key]}
          onchange={(e) => set(key, e.currentTarget.checked)}
        />
        <span class="access-body">
          <span class="access-title">{ACCESS_TOGGLE_LABELS[key]}</span>
          <span class="access-sub">{ACCESS_TOGGLE_DESCRIPTIONS[key]}</span>
        </span>
      </label>
    {/each}
  {/if}

  <button type="button" class="access-advanced" onclick={() => (showAdvanced = !showAdvanced)}>
    {showAdvanced ? 'Hide' : 'Show'} advanced
  </button>

  {#if showAdvanced}
    <label class="access-row" for="access-assistantDirect">
      <input
        id="access-assistantDirect"
        type="checkbox"
        checked={access.assistantDirect}
        onchange={(e) => set('assistantDirect', e.currentTarget.checked)}
      />
      <span class="access-body">
        <span class="access-title">{ACCESS_TOGGLE_LABELS.assistantDirect}</span>
        <span class="access-sub">{ACCESS_TOGGLE_DESCRIPTIONS.assistantDirect}</span>
      </span>
    </label>
    {#if access.assistantDirect}
      <p class="network-risk-warning" role="alert">
        The assistant API is protected by a generated key sent over plain HTTP, which anything already on
        your network can read. Prefer the guardian on a network you do not control.
      </p>
    {/if}
  {/if}

  <p class="network-mdns-note">
    <code>.local</code> names are broadcast by the host <code>openpalm</code> process while it runs — the exact
    names appear after install in Dashboard → Assistant.
  </p>
</div>

<style>
  .access-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 0;
    cursor: pointer;
  }

  .access-body { display: flex; flex-direction: column; gap: 2px; }
  .access-title { font-family: var(--s-font-display); color: var(--s-ink); }
  .access-sub { font-size: var(--s-type-deed); color: var(--s-ink-3); }

  .access-advanced {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 4px 0;
    color: var(--s-ink-3);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    text-decoration: underline;
    cursor: pointer;
  }

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


  .network-mdns-note {
    margin: 14px 0 0;
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    line-height: 1.5;
  }
</style>
