<script lang="ts">
  /**
   * NetworkAccessStep — the wizard's access toggles.
   *
   * Rendered as a section of the Finish step (ReviewStep), not a screen of its
   * own: the default (everything closed) needs zero interaction, so a
   * dedicated screen would add a click for every user to serve a minority.
   *
   * Progressive disclosure. ONE question is always visible — can other devices
   * on your network use the assistant. That is the entire surface for a home
   * install; everything else is behind Advanced.
   *
   * The guardian toggles are NOT gated on "a guardian integration is enabled".
   * Publishing a front door is the statement of intent, and the toggle itself
   * makes it true: either guardian toggle activates the guardian's own compose
   * profile (guardian-required.ts) — no integration is enabled on the
   * operator's behalf. Gating them would make the operator guess which Extras
   * row to tick first.
   *
   * Self-contained (ReviewStep pattern): takes NO props, reads and writes the
   * setup-state store directly.
   */
  import {
    ACCESS_TOGGLE_DESCRIPTIONS,
    ACCESS_TOGGLE_LABELS,
    type AccessToggles,
  } from '@openpalm/lib/control-plane/access-toggles.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  const s = setupState;
  const access = $derived(s.access);

  let showAdvanced = $state(false);

  /** Everything except the one always-visible question. */
  const ADVANCED_KEYS: (keyof AccessToggles)[] = [
    'guardianNetwork',
    'guardianOpenaiApi',
    'assistantDirect',
  ];

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

  <button type="button" class="access-advanced" onclick={() => (showAdvanced = !showAdvanced)}>
    {showAdvanced ? 'Hide' : 'Show'} advanced
  </button>

  {#if showAdvanced}
    {#each ADVANCED_KEYS as key (key)}
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
