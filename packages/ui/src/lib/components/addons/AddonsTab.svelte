<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import EmptyState from '$lib/components/common/EmptyState.svelte';
  import {
    fetchAddons,
    toggleAddon,
    saveVoiceProfile,
    fetchAddonCredentials,
    saveAddonCredentials,
    fetchSecretFile,
    fetchSecretFiles,
    saveSecretFile,
    fetchRemoteAccessStatus,
    type AddonCredentialField,
    type AddonEntry,
    type RemoteAccessStatus,
    type VoiceAddonInfo,
  } from '$lib/api.js';
  import { isAuthError, toMessage } from '$lib/api/errors.js';
  import { notifications } from '$lib/notifications.svelte.js';
  import { refreshAdvertisedVoiceUrl } from '$lib/voice/providers.js';
  import VoiceProfileSelector from '$lib/components/voice/VoiceProfileSelector.svelte';
  import RemoteStatusCard from '$lib/components/addons/RemoteStatusCard.svelte';
  import SecretSelect from '$lib/components/common/SecretSelect.svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import IconAddons from '$lib/components/icons/IconAddons.svelte';
  import Drawer from '$lib/components/common/Drawer.svelte';

  interface Props {
    onAuthError: () => void;
    focusAddon?: 'voice' | 'remote';
  }

  let { onAuthError, focusAddon }: Props = $props();

  // Human-readable label for a raw addon identifier (the raw name stays as a
  // tooltip). Known acronyms keep their casing; everything else is Title Cased.
  const ADDON_ACRONYMS: Record<string, string> = { api: 'API', ssh: 'SSH', ui: 'UI' };
  function formatAddonName(name: string): string {
    return name
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => ADDON_ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  let addons = $state<AddonEntry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let actionLoading = $state<string | null>(null);

  // ── Voice addon: hardware profile + background bring-up job ─────────────
  // Voice is the one addon whose enable actually starts a container (and on
  // first enable pulls a multi-GB image in the background). The list endpoint
  // returns its profiles/selection/activeJob; while a job is in flight we
  // poll so the row badge tracks pulling → starting → healthy/error.
  let voiceInfo = $state<VoiceAddonInfo | null>(null);
  let voiceProfile = $state('');
  let voiceProfileDirty = $state(false);
  let voicePollTimer: ReturnType<typeof setTimeout> | null = null;

  const voiceJobRunning = $derived(
    voiceInfo?.activeJob?.state === 'pulling' || voiceInfo?.activeJob?.state === 'starting'
  );

  function scheduleVoicePoll(): void {
    if (voicePollTimer) return;
    voicePollTimer = setTimeout(() => {
      voicePollTimer = null;
      void loadAddons().then(() => {
        if (voiceJobRunning) scheduleVoicePoll();
      });
    }, 3000);
  }

  onDestroy(() => {
    if (voicePollTimer) clearTimeout(voicePollTimer);
  });

  async function applyVoiceProfile(): Promise<void> {
    if (!voiceProfile) return;
    actionLoading = 'voice';
    try {
      const result = await saveVoiceProfile(voiceProfile);
      voiceProfileDirty = false;
      if (result.status === 202) {
        notifications.push('success', 'Voice image is downloading in the background.');
        scheduleVoicePoll();
      } else if (!result.ok) {
        notifications.push('error', result.voiceAddon?.error ?? 'Voice profile change failed.');
      } else {
        notifications.push('success', 'Voice hardware profile saved.');
      }
      await loadAddons();
    } catch (err) {
      if (isAuthError(err)) { onAuthError(); return; }
      notifications.push('error', toMessage(err, String(err)));
    } finally {
      actionLoading = null;
    }
  }

  // Per-addon credentials editor state (lazy — populated when expanded).
  let expanded = $state<string | null>(null);
  let credFields = $state<Record<string, AddonCredentialField[]>>({});
  let credValues = $state<Record<string, Record<string, string>>>({});
  // For sensitive fields: the NAME of the selected secret (the SecretSelect
  // binds here). On selection we fetch the value into credValues behind the
  // scenes — the raw value is never rendered.
  let credSecretRef = $state<Record<string, Record<string, string>>>({});
  let credLoading = $state<string | null>(null);
  let credSaving = $state<string | null>(null);

  async function onSecretChosen(addonName: string, key: string, secretName: string): Promise<void> {
    if (!secretName) {
      credValues[addonName][key] = '';
      return;
    }
    try {
      const { value } = await fetchSecretFile(secretName);
      credValues[addonName][key] = value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifications.push('error', `Could not read secret: ${msg}`);
    }
  }

  // ── Remote addon: row-level status chip ──────────────────────────────────
  // A one-shot read per list refresh, not a poll: the drawer's status card
  // owns live observation; the row chip just answers "is the front door up"
  // at a glance. Compact labels — the card carries the full sentence.
  let remoteStatus = $state<RemoteAccessStatus | null>(null);

  const REMOTE_ROW_LABELS: Record<RemoteAccessStatus['state'], string> = {
    off: 'Off',
    'awaiting-config': 'Needs setup',
    'awaiting-authentication': 'Sign in',
    'pending-external': 'Waiting',
    starting: 'Starting…',
    up: 'Up',
    degraded: 'Degraded',
    error: 'Error',
  };

  async function refreshRemoteRowStatus(): Promise<void> {
    const remote = addons.find((a) => a.name === 'remote');
    if (!remote?.enabled) {
      remoteStatus = null;
      return;
    }
    try {
      remoteStatus = await fetchRemoteAccessStatus();
    } catch {
      // The chip is a convenience; a failed read shows nothing rather than
      // an error badge that outranks the row's own enabled/disabled truth.
      remoteStatus = null;
    }
  }

  async function loadAddons(): Promise<void> {
    loading = true;
    error = '';
    try {
      const list = await fetchAddons();
      addons = list.addons;
      voiceInfo = list.voice ?? null;
      if (!voiceProfileDirty) voiceProfile = voiceInfo?.selectedProfile ?? '';
      if (voiceJobRunning) scheduleVoicePoll();
      void refreshRemoteRowStatus();
    } catch (err) {
      if (isAuthError(err)) { onAuthError(); return; }
      error = toMessage(err, String(err));
    } finally {
      loading = false;
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    actionLoading = name;
    try {
      const result = await toggleAddon(
        name,
        enabled,
        name === 'voice' && enabled && voiceProfile ? { profile: voiceProfile } : undefined
      );
      if (result.status === 202 && name === 'voice') {
        notifications.push('success', 'Voice image is downloading in the background — this can take several minutes.');
        scheduleVoicePoll();
      } else if (result.status === 202) {
        // Enabled; the container is starting behind the response. A first
        // enable pulls the image, so this can take minutes — Containers is
        // where it actually shows up.
        notifications.push(
          'success',
          `${name} is enabled and starting in the background — a first-time image download can take several minutes. Watch the Containers tab.`
        );
      } else if (!result.ok) {
        error = result.voiceAddon?.error ?? `Could not ${enabled ? 'enable' : 'disable'} ${name}.`;
      }
      // The chat client resolves the OpenPalm Voice provider through the
      // runtime advertisement — drop its cache so the toggle takes effect
      // without a reload.
      if (name === 'voice') void refreshAdvertisedVoiceUrl();
      if (name === 'voice') voiceProfileDirty = false;
      await loadAddons();
    } catch (err) {
      if (isAuthError(err)) { onAuthError(); return; }
      error = toMessage(err, String(err));
    } finally {
      actionLoading = null;
    }
  }

  function closeCredentials(): void {
    expanded = null;
  }

  async function openCredentials(name: string): Promise<void> {
    expanded = name;
    if (!credFields[name]) {
      credLoading = name;
      try {
        const fields = await fetchAddonCredentials(name);
        credFields[name] = fields;
        const seed: Record<string, string> = {};
        const refSeed: Record<string, string> = {};
        for (const f of fields) {
          seed[f.key] = f.sensitive ? '' : f.value;
          if (f.sensitive) refSeed[f.key] = '';
        }
        credValues[name] = seed;
        credSecretRef[name] = refSeed;
      } catch (err) {
        if (isAuthError(err)) { onAuthError(); return; }
        notifications.push('error', `Could not load credentials: ${toMessage(err, String(err))}`);
      } finally {
        credLoading = null;
      }
    }
  }

  async function saveCredentials(name: string): Promise<void> {
    credSaving = name;
    try {
      // Drop empty values for sensitive fields (user didn't change them);
      // leave non-sensitive empties so the user can clear a value.
      const fields = credFields[name] ?? [];
      const sensitiveKeys = new Set(fields.filter((f) => f.sensitive).map((f) => f.key));
      const submitted: Record<string, string> = {};
      const current = credValues[name] ?? {};
      for (const [k, v] of Object.entries(current)) {
        if (sensitiveKeys.has(k) && v === '') continue;
        submitted[k] = v;
      }
      if (Object.keys(submitted).length === 0) {
        notifications.push('error', 'Nothing to save.');
        return;
      }
      const { updated } = await saveAddonCredentials(name, submitted);
      notifications.push('success', `Saved ${updated.length} field(s). Recreate the addon container to apply.`);
      // Re-fetch to refresh `set` flags
      const fresh = await fetchAddonCredentials(name);
      credFields[name] = fresh;
      const reset = { ...current };
      for (const f of fresh) if (f.sensitive) reset[f.key] = '';
      credValues[name] = reset;
    } catch (err) {
      if (isAuthError(err)) { onAuthError(); return; }
      notifications.push('error', `Save failed: ${toMessage(err, String(err))}`);
    } finally {
      credSaving = null;
    }
  }

  onMount(() => {
    void loadAddons().then(() => {
      if (focusAddon && addons.some((addon) => addon.name === focusAddon)) {
        void openCredentials(focusAddon);
      }
    });
  });
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Addons</h2>
      <p class="panel-subtitle">Optional features · capabilities</p>
    </div>
    <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()} disabled={loading}>
      {#if loading}
        <Spinner />
      {/if}
      Refresh
    </button>
  </div>
  <div class="panel-body panel-body--flush">
    {#if loading && addons.length === 0}
      <div class="loading-state">
        <Spinner />
        <span>Loading addons...</span>
      </div>
    {:else if error}
      <div class="error-state">
        <span>{error}</span>
        <button class="btn btn-secondary btn-sm" onclick={() => loadAddons()}>Retry</button>
      </div>
    {:else if addons.length === 0}
      <EmptyState>
        {#snippet icon()}
          <IconAddons size={40} />
        {/snippet}
        <p>No addons found in registry/addons/.</p>
      </EmptyState>
    {:else}
      <div class="addon-table">
        <div class="addon-table-header">
          <span class="addon-col addon-col--name">Addon</span>
          <span class="addon-col addon-col--status">Status</span>
          <span class="addon-col addon-col--actions"></span>
        </div>
        {#each addons as addon (addon.name)}
          <div class="addon-row">
            <span class="addon-col addon-col--name addon-name" title={addon.name}>
              {formatAddonName(addon.name)}
              {#if addon.experimental}
                <!-- Advisory, not a gate: enabling is unchanged. It says the
                     clean-startup promise is withheld for this one. -->
                <span
                  class="badge badge-experimental"
                  title="Experimental — ships, but not fully supported. It depends on third-party pieces OpenPalm does not build and cannot fully verify, so it may fail to start or break when they change. Enabling it works exactly like any other addon."
                >Experimental</span>
              {/if}
            </span>
            <span class="addon-col addon-col--status">
              <span class="badge" class:badge-enabled={addon.enabled} class:badge-disabled={!addon.enabled}>
                {addon.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {#if addon.name === 'voice' && voiceInfo?.activeJob}
                {@const job = voiceInfo.activeJob}
                <span
                  class="badge badge-job"
                  class:badge-enabled={job.state === 'healthy'}
                  class:badge-error={job.state === 'error'}
                  title={job.error ?? undefined}
                >
                  {job.state === 'pulling' ? 'Downloading…' : job.state === 'starting' ? 'Starting…' : job.state}
                </span>
              {/if}
              {#if addon.name === 'remote' && addon.enabled && remoteStatus && remoteStatus.state !== 'off'}
                <span
                  class="badge badge-job"
                  class:badge-enabled={remoteStatus.state === 'up'}
                  class:badge-error={remoteStatus.state === 'error' || remoteStatus.state === 'degraded'}
                  title={remoteStatus.message}
                >
                  {REMOTE_ROW_LABELS[remoteStatus.state]}
                </span>
              {/if}
            </span>
            <span class="addon-col addon-col--actions">
              <button
                class="btn btn-sm btn-secondary"
                onclick={() => void openCredentials(addon.name)}
                disabled={!addon.available}
              >
                Configure
              </button>
              <button
                class="btn btn-sm"
                class:btn-danger={addon.enabled}
                class:btn-outline={!addon.enabled}
                disabled={actionLoading === addon.name || !addon.available}
                onclick={() => toggle(addon.name, !addon.enabled)}
              >
                {#if actionLoading === addon.name}
                  <Spinner />
                {:else}
                  {addon.enabled ? 'Disable' : 'Enable'}
                {/if}
              </button>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Credentials editor opens in a drawer instead of expanding inline. -->
  {#if expanded}
    {@const aid = expanded}
    <Drawer open={true} title="{formatAddonName(aid)} settings" onClose={closeCredentials}>
      {#if aid === 'remote'}
        <!-- Observed provider state (remote-access-providers.md §5): where
             the Tailscale sign-in link surfaces (it otherwise lives only in
             the container logs) and where the real tailnet URL appears once
             the tunnel reports up. Renders the provider-agnostic
             RemoteAccessStatus vocabulary, so a later provider changes the
             registry, not this drawer. -->
        <div class="engine-section">
          <span class="creds-label">Status</span>
          <RemoteStatusCard />
        </div>
      {/if}
      {#if aid === 'voice' && voiceInfo && voiceInfo.profiles.length > 0}
        <!-- Host capability config: which compose profile (CPU/CUDA/ROCm)
             runs the voice container. Client TTS/STT preferences live in the
             chat UI's connection settings, not here. -->
        <div class="engine-section voice-profile-block">
          <span class="creds-label">Hardware profile</span>
          <VoiceProfileSelector
            profiles={voiceInfo.profiles}
            selectedProfile={voiceProfile}
            onchange={(id) => { voiceProfile = id; voiceProfileDirty = true; }}
          />
          <div class="voice-profile-actions">
            <button
              class="btn btn-sm btn-secondary"
              disabled={actionLoading === 'voice' || !voiceProfile || voiceProfile === voiceInfo.selectedProfile}
              onclick={() => void applyVoiceProfile()}
            >
              {#if actionLoading === 'voice'}<Spinner />{/if}
              Apply profile
            </button>
          </div>
          <p class="creds-desc">
            Applying while the addon is enabled restarts the voice container on the new profile.
          </p>
        </div>
      {/if}
      {#if credLoading === aid}
        <div class="creds-loading"><Spinner /> Loading credentials…</div>
      {:else if (credFields[aid]?.length ?? 0) === 0}
        <p class="creds-empty">This addon has no configurable env vars (compose overlay only).</p>
      {:else}
        {#snippet credFieldRow(rowAid: string, field: AddonCredentialField)}
          <div class="creds-row">
            {#if field.boolean}
              <!-- Boolean fields render as a checkbox, not a labeled text row —
                   a text box you'd have to type "true" into is not "easy to
                   toggle". The value written is still the literal string
                   "true"/"false" (credValues stays Record<string, string> so
                   the POST payload shape is unchanged for every field type). -->
              <label class="creds-checkbox" for="cred-{rowAid}-{field.key}">
                <input
                  id="cred-{rowAid}-{field.key}"
                  type="checkbox"
                  checked={credValues[rowAid][field.key] === 'true'}
                  onchange={(e) => {
                    credValues[rowAid][field.key] = e.currentTarget.checked ? 'true' : 'false';
                  }}
                />
                <code>{field.key}</code>
              </label>
              {#if field.description}<p class="creds-desc">{field.description}</p>{/if}
            {:else}
              <label class="creds-label" for="cred-{rowAid}-{field.key}">
                <code>{field.key}</code>
                {#if field.sensitive}<span class="creds-tag">sensitive</span>{/if}
                {#if field.sensitive && field.set}<span class="creds-tag creds-tag--set">set</span>{/if}
              </label>
              {#if field.description}<p class="creds-desc">{field.description}</p>{/if}
              {#if field.sensitive}
                <SecretSelect
                  id="cred-{rowAid}-{field.key}"
                  bind:value={credSecretRef[rowAid][field.key]}
                  onChange={(secretName) => void onSecretChosen(rowAid, field.key, secretName)}
                  {fetchSecretFiles}
                  {saveSecretFile}
                />
                {#if field.set}<p class="creds-desc">A value is already set — choose a secret to replace it.</p>{/if}
              {:else}
                <input
                  id="cred-{rowAid}-{field.key}"
                  type="text"
                  class="form-input"
                  placeholder={field.default}
                  bind:value={credValues[rowAid][field.key]}
                  autocomplete="off"
                />
              {/if}
            {/if}
          </div>
        {/snippet}
        {#if aid === 'remote'}
          <!-- The status card above is the remote addon's PRIMARY surface —
               the default setup needs no fields at all (leave everything
               blank, click Connect on the card). The schema fields are
               genuinely advanced, so they collapse. OP_REMOTE_PUBLIC is
               filtered entirely: public-unauthenticated exposure (Funnel)
               gets no button — it stays a documented hand-edit
               (remote-access-providers.md §6), and public exposure with an
               auth gate is a future provider's job. -->
          <details class="creds-advanced">
            <summary>Advanced settings</summary>
            <p class="creds-hint">Values are written to <code>state/stack.env</code> and read by the addon container on next recreate. Most people never need these.</p>
            {#each (credFields[aid] ?? []).filter((f) => f.key !== 'OP_REMOTE_PUBLIC') as field (field.key)}
              {@render credFieldRow(aid, field)}
            {/each}
          </details>
        {:else}
          <p class="creds-hint">Values are written to <code>state/stack.env</code> and read by the addon container on next recreate.</p>
          {#each credFields[aid] ?? [] as field (field.key)}
            {@render credFieldRow(aid, field)}
          {/each}
        {/if}
      {/if}
      {#snippet footer()}
        <button class="btn btn-secondary btn-sm" onclick={closeCredentials}>Cancel</button>
        <button
          class="btn btn-primary btn-sm"
          disabled={!expanded || credSaving === expanded || (credFields[expanded]?.length ?? 0) === 0}
          onclick={() => expanded && void saveCredentials(expanded)}
        >
          {#if credSaving === expanded}<Spinner />{/if} Save
        </button>
      {/snippet}
    </Drawer>
  {/if}
</div>

<style>
  /* ── Table ────────────────────────────────────────────────────── */

  .addon-table {
    display: flex;
    flex-direction: column;
    width: 100%;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
  }

  .addon-table-header {
    display: flex;
    align-items: center;
    padding: var(--s-sp-2) var(--s-sp-5);
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
    text-transform: uppercase;
  }

  .addon-row {
    display: flex;
    align-items: center;
    padding: var(--s-sp-3) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .addon-row:last-child {
    border-bottom: none;
  }

  .addon-row:hover {
    background: color-mix(in srgb, var(--s-ink) 3%, var(--s-paper));
  }

  .addon-col {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .addon-col--name {
    flex: 3;
    min-width: 0;
  }

  .badge-experimental {
    background: color-mix(in srgb, var(--s-seal) 10%, transparent);
    color: var(--s-seal);
    border: var(--s-hair) solid color-mix(in srgb, var(--s-seal) 30%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--s-type-mark);
  }

  .addon-col--status {
    flex: 1;
    min-width: 0;
  }

  .addon-col--actions {
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  .addon-name {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* Narrow widths: let the row wrap so the name gets its own full-width line
     instead of being squeezed (and ellipsis-clipped) by the action buttons. */
  @media (max-width: 480px) {
    .addon-row { flex-wrap: wrap; }
    .addon-col--name { flex: 1 0 100%; }
    .addon-col--actions { justify-content: flex-start; }
  }

  /* ── States ───────────────────────────────────────────────────── */

  .error-state {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4) var(--s-sp-5);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-seal);
  }

  @media (max-width: 768px) {
    .addon-table-header {
      display: none;
    }

    .addon-row {
      flex-wrap: wrap;
      gap: var(--s-sp-2);
    }

    .addon-col--status {
      flex: 0 0 auto;
    }
  }

  .badge-job {
    margin-left: var(--s-sp-2);
  }

  .badge-error {
    color: var(--s-seal);
    border-color: var(--s-seal);
  }

  .voice-profile-block {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    padding-bottom: var(--s-sp-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }

  .voice-profile-actions {
    display: flex;
    gap: var(--s-sp-2);
  }

  /* ── Credentials editor (in a drawer) ───────────────────────────── */

  .creds-loading {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    color: var(--s-ink-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
  }

  .creds-empty,
  .creds-hint {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

  .creds-advanced {
    border-top: var(--s-hair) solid var(--s-line-soft);
    padding-top: var(--s-sp-3);
  }

  .creds-advanced summary {
    cursor: pointer;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    user-select: none;
  }

  .creds-advanced[open] summary {
    margin-bottom: var(--s-sp-3);
  }

  .creds-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }

  .creds-checkbox {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    cursor: pointer;
  }

  .creds-checkbox code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .creds-checkbox input[type='checkbox'] {
    appearance: none;
    width: 1rem;
    height: 1rem;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: none;
    flex-shrink: 0;
    position: relative;
    cursor: pointer;
  }

  .creds-checkbox input[type='checkbox']:checked {
    background: var(--s-seal);
    border-color: var(--s-seal);
  }

  .creds-checkbox input[type='checkbox']:checked::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 1px;
    width: 8px;
    height: 5px;
    border: 1.4px solid white;
    border-top: 0;
    border-right: 0;
    transform: rotate(-45deg);
  }

  .creds-label {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .creds-label code {
    font-family: var(--s-font-mono);
    background: var(--s-paper-deep);
    color: var(--s-ink-2);
    padding: 1px 6px;
    border-radius: 2px;
  }

  .creds-tag {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    padding: 2px 8px;
    border-radius: 2px;
    border: var(--s-hair) solid var(--s-line);
    background: none;
    color: var(--s-ink-3);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }

  .creds-tag--set {
    color: var(--s-moss);
    border-color: var(--s-moss);
  }

  .creds-desc {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

  .form-input {
    width: 100%;
    border: 0;
    border-bottom: var(--s-hair) solid var(--s-line);
    border-radius: 0;
    padding: 0.5rem 0;
    background: none;
    color: var(--s-ink);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
  }
  .form-input:focus { outline: none; border-bottom-color: var(--s-seal); }
</style>
