<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    fetchVersions,
    patchVersions,
    applyChanges,
    applyServiceUpdate,
    downloadUiVersion,
    type ComponentVersionInfo,
  } from '$lib/api.js';
  import {
    desktopNotifyEnabled,
    desktopReplyPreviewEnabled,
    setDesktopNotifyEnabled,
    setDesktopReplyPreviewEnabled,
  } from '$lib/desktop-notifications.js';

  // ── Component metadata ────────────────────────────────────────────────────
  // Maps version key → human label + compose service name for scoped updates.
  // The service name is the compose service to pull/recreate (§4.3 "one container").
  const COMPONENTS: { key: string; label: string; service: string }[] = [
    { key: 'OP_ASSISTANT_VERSION', label: 'Assistant', service: 'assistant' },
    { key: 'OP_GUARDIAN_VERSION',  label: 'Guardian',  service: 'guardian' },
    { key: 'OP_PORTAL_VERSION',    label: 'Portal',    service: 'portal' },
    { key: 'OP_VOICE_VERSION',     label: 'Voice',     service: 'voice' },
  ];

  // ── Data ──────────────────────────────────────────────────────────────────
  let platformVersion = $state('');
  let channel = $state<'latest' | 'next'>('latest');
  let components = $state<Record<string, ComponentVersionInfo>>({});
  let loading = $state(true);
  let loadError = $state('');

  // ── Per-row pin editing ───────────────────────────────────────────────────
  // Key → the draft tag string while the user is editing (undefined = not editing)
  let editingPin = $state<Record<string, string | undefined>>({});

  // ── Per-row update state ──────────────────────────────────────────────────
  let rowApplying = $state<Record<string, boolean>>({});
  // Separate maps for update vs pin feedback so the two actions don't overwrite
  // each other's messages (§6: errors shown on the screen that triggered them).
  let rowUpdateError = $state<Record<string, string>>({});
  let rowUpdateSuccess = $state<Record<string, string>>({});
  let rowPinError = $state<Record<string, string>>({});
  let rowPinSuccess = $state<Record<string, string>>({});

  // ── Channel toggle state ──────────────────────────────────────────────────
  let channelError = $state('');

  // ── "Update everything" state ─────────────────────────────────────────────
  let allApplying = $state(false);
  let allError = $state('');
  let allSuccess = $state('');

  // ── UI (control plane) update state ──────────────────────────────────────
  let uiApplying = $state(false);
  let uiError = $state('');
  let uiMessage = $state('');

  // ── Electron bridge ───────────────────────────────────────────────────────
  let inElectron = $state(false);
  let notificationsEnabled = $state(false);
  let replyPreviewEnabled = $state(false);
  let launchOnLoginSupported = $state(false);
  let launchOnLoginEnabled = $state(false);
  let launchOnLoginSaving = $state(false);

  onMount(() => {
    inElectron = typeof window.openpalm !== 'undefined';
    notificationsEnabled = desktopNotifyEnabled();
    replyPreviewEnabled = desktopReplyPreviewEnabled();
    void loadVersions();
    void hydrateLaunchOnLogin();
  });

  async function loadVersions(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      const data = await fetchVersions();
      platformVersion = data.platformVersion;
      channel = data.channel ?? 'latest';
      components = data.components ?? {};
    } catch (e) {
      const err = e as { message?: string };
      loadError = `Failed to load versions: ${err.message ?? String(e)}`;
    }
    loading = false;
  }

  async function hydrateLaunchOnLogin(): Promise<void> {
    const status = await window.openpalm?.launchOnLoginStatus?.();
    if (!status) return;
    launchOnLoginSupported = status.supported;
    launchOnLoginEnabled = status.enabled;
  }

  // ── Version display helpers ───────────────────────────────────────────────

  function runningDisplay(info: ComponentVersionInfo | undefined): string {
    // §5: when no container exists, show 'not installed', not '—' (truthful state)
    if (!info?.running) return 'not installed';
    const v = info.running.plainVersion || info.running.tag.split(':').pop() || '—';
    const stopped = info.running.containerState !== 'running';
    return stopped ? `${v} (stopped)` : v;
  }

  function pinnedDisplay(info: ComponentVersionInfo | undefined): string {
    if (!info) return '—';
    return info.pinned ?? 'latest (tracking)';
  }

  function availableDisplay(info: ComponentVersionInfo | undefined): string {
    if (!info?.available) return '—';
    return info.available;
  }

  function hasUpdate(info: ComponentVersionInfo | undefined): boolean {
    if (!info?.available || !info.running) return false;
    const running = info.running.plainVersion || info.running.tag.split(':').pop() || '';
    return bare(info.available) !== bare(running);
  }

  function bare(v: string): string {
    return v.replace(/^v/, '');
  }

  // ── Row pin actions ───────────────────────────────────────────────────────

  function startEditPin(key: string): void {
    const info = components[key];
    editingPin[key] = info?.pinned ?? '';
  }

  function cancelEditPin(key: string): void {
    delete editingPin[key];
    editingPin = { ...editingPin };
  }

  async function savePin(key: string): Promise<void> {
    const draft = editingPin[key];
    if (draft === undefined) return;
    // Empty string = unpin (track latest)
    const value = draft.trim() || null;
    rowPinError[key] = '';
    rowPinSuccess[key] = '';
    try {
      // null means "track latest" → send 'latest' to the server (moving tag sentinel)
      await patchVersions({ [key]: value ?? 'latest' });
      // Update local state immediately (inline, no splash — §4.1 trivial change)
      components = {
        ...components,
        [key]: {
          ...components[key]!,
          pinned: value,
        },
      };
      rowPinSuccess[key] = value ? `Pinned to ${value}` : 'Tracking latest';
      cancelEditPin(key);
    } catch (e) {
      const err = e as { message?: string };
      rowPinError[key] = `Pin failed: ${err.message ?? String(e)}`;
    }
  }

  // ── Single-service update ─────────────────────────────────────────────────

  async function updateService(key: string, service: string): Promise<void> {
    if (rowApplying[key] || allApplying) return;
    rowApplying[key] = true;
    rowUpdateError[key] = '';
    rowUpdateSuccess[key] = '';
    try {
      const result = await applyServiceUpdate(service);
      if (!result.overallSuccess) {
        rowUpdateError[key] = result.failed.length > 0
          ? result.failed.map((f) => `${f.service}: ${f.reason}`).join('; ')
          : !result.dockerAvailable
            ? 'Docker is unavailable'
            : result.error ?? 'Update failed';
      } else {
        rowUpdateSuccess[key] = `Updated (${result.restarted.join(', ') || service})`;
        // Reload versions to show the new running image (truthful state, §5)
        void reloadVersions();
      }
    } catch (e) {
      const err = e as { message?: string };
      rowUpdateError[key] = err.message ?? String(e);
    }
    rowApplying[key] = false;
  }

  // ── Update everything ─────────────────────────────────────────────────────

  async function updateAll(): Promise<void> {
    if (allApplying || Object.values(rowApplying).some(Boolean)) return;
    allApplying = true;
    allError = '';
    allSuccess = '';
    try {
      const result = await applyChanges();
      if (!result.overallSuccess) {
        allError = result.failed.length > 0
          ? `Failed: ${result.failed.map((f) => `${f.service}: ${f.reason}`).join('; ')}`
          : !result.dockerAvailable
            ? 'Docker is unavailable — stack not restarted'
            : result.error ?? 'Update failed';
      } else {
        allSuccess = result.restarted.length > 0
          ? `Updated: ${result.restarted.join(', ')}`
          : 'Stack is up to date';
        void reloadVersions();
      }
    } catch (e) {
      const err = e as { message?: string };
      allError = err.message ?? String(e);
    }
    allApplying = false;
  }

  // Reload versions after an update to show the new running reality (§5)
  async function reloadVersions(): Promise<void> {
    try {
      const data = await fetchVersions();
      platformVersion = data.platformVersion;
      channel = data.channel ?? 'latest';
      components = data.components ?? {};
    } catch {
      // Silent — the data we have is still accurate enough
    }
  }

  // ── UI (control-plane) update ─────────────────────────────────────────────

  async function updateUi(): Promise<void> {
    if (uiApplying) return;
    uiApplying = true;
    uiError = '';
    uiMessage = '';
    try {
      // Use available if known, else "latest"
      const target = 'latest';
      const result = await downloadUiVersion(target);
      if (result.pendingRestart) {
        void window.openpalm?.restartUiServer?.();
        uiMessage = `Updating UI — restarting…`;
      } else if (result.restarting) {
        setTimeout(() => { location.href = '/'; }, 4_000);
        uiMessage = `UI updated — reloading in a moment…`;
      } else {
        uiMessage = `UI downloaded. Restart the admin UI to apply it.`;
      }
    } catch (e) {
      const err = e as { message?: string };
      uiError = err.message ?? String(e);
    }
    uiApplying = false;
  }

  // ── Electron desktop settings ─────────────────────────────────────────────

  async function onLaunchOnLoginChange(event: Event): Promise<void> {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    if (!window.openpalm?.setLaunchOnLogin) {
      launchOnLoginEnabled = false;
      return;
    }
    launchOnLoginSaving = true;
    try {
      const status = await window.openpalm.setLaunchOnLogin(enabled);
      launchOnLoginSupported = status.supported;
      launchOnLoginEnabled = status.enabled;
    } finally {
      launchOnLoginSaving = false;
    }
  }

  const anyApplying = $derived(allApplying || uiApplying || Object.values(rowApplying).some(Boolean));
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Updates</h2>
      <p class="panel-subtitle">Update individual components or everything at once.</p>
      <p class="control-plane-line">
        Control plane: <strong>{platformVersion || '—'}</strong>
      </p>
    </div>

    <div class="header-actions">
      <button
        class="btn btn-primary"
        onclick={updateAll}
        disabled={anyApplying}
        aria-busy={allApplying}
      >
        {#if allApplying}
          <Spinner /> Updating everything…
        {:else}
          Update everything
        {/if}
      </button>
      <button
        class="btn btn-outline"
        onclick={updateUi}
        disabled={anyApplying}
        aria-busy={uiApplying}
      >
        {#if uiApplying}
          <Spinner /> Updating UI…
        {:else}
          Update UI
        {/if}
      </button>
    </div>
  </div>

  {#if allError}
    <p class="msg msg-error" role="alert">{allError}</p>
  {/if}
  {#if allSuccess}
    <p class="msg msg-success" role="status">{allSuccess}</p>
  {/if}
  {#if uiError}
    <p class="msg msg-error" role="alert">UI update failed: {uiError}</p>
  {/if}
  {#if uiMessage}
    <p class="msg msg-success" role="status">{uiMessage}</p>
  {/if}

  <div class="panel-body">
    {#if loadError}
      <p class="msg msg-error" role="alert">{loadError}</p>
    {/if}

    {#if loading}
      <p class="loading-line"><Spinner /> Loading versions…</p>
    {:else}
      <!-- ── Container image components ────────────────────────────────────── -->
      <section aria-label="Container images">
        <table class="comp-table" aria-label="Component versions">
          <thead>
            <tr>
              <th scope="col" class="col-name">Component</th>
              <th scope="col" class="col-running">Running</th>
              <th scope="col" class="col-pin">Pin</th>
              <th scope="col" class="col-avail">Available</th>
              <th scope="col" class="col-action"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each COMPONENTS as comp (comp.key)}
              {@const info = components[comp.key]}
              {@const isUpdating = rowApplying[comp.key] ?? false}
              {@const updateAvailable = hasUpdate(info)}
              <tr class:row-has-update={updateAvailable}>
                <td class="col-name">
                  <span class="comp-label">{comp.label}</span>
                </td>
                <td class="col-running">
                  <code class="ver">{runningDisplay(info)}</code>
                  {#if info?.running?.healthStatus && info.running.healthStatus !== 'none' && info.running.healthStatus !== ''}
                    <span class="health-dot health-{info.running.healthStatus}" aria-label="Health: {info.running.healthStatus}"></span>
                  {/if}
                </td>
                <td class="col-pin">
                  {#if editingPin[comp.key] !== undefined}
                    <!-- Inline pin editor — trivial change, no splash (§4.1) -->
                    <div class="pin-edit-row">
                      <input
                        class="pin-input"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="tag or leave empty for latest"
                        bind:value={editingPin[comp.key]}
                        aria-label="Pin version for {comp.label}"
                        onkeydown={(e) => {
                          if (e.key === 'Enter') void savePin(comp.key);
                          if (e.key === 'Escape') cancelEditPin(comp.key);
                        }}
                      />
                      <button class="btn-inline btn-save" onclick={() => savePin(comp.key)}>Save</button>
                      <button class="btn-inline btn-cancel" onclick={() => cancelEditPin(comp.key)}>Cancel</button>
                    </div>
                  {:else}
                    <button class="pin-chip" onclick={() => startEditPin(comp.key)} title="Edit pin for {comp.label}">
                      <span class="pin-chip-text">{pinnedDisplay(info)}</span>
                      <span class="pin-edit-icon" aria-hidden="true">✏</span>
                    </button>
                  {/if}
                  <!-- Pin action feedback stays in col-pin (§6: on the screen that triggered it) -->
                  {#if rowPinSuccess[comp.key]}
                    <span class="inline-success">{rowPinSuccess[comp.key]}</span>
                  {/if}
                  {#if rowPinError[comp.key]}
                    <span class="inline-error" role="alert">{rowPinError[comp.key]}</span>
                  {/if}
                </td>
                <td class="col-avail">
                  {#if updateAvailable}
                    <code class="ver ver-new">{availableDisplay(info)}</code>
                  {:else}
                    <code class="ver">{availableDisplay(info)}</code>
                  {/if}
                </td>
                <td class="col-action">
                  <button
                    class="btn btn-sm"
                    class:btn-primary={updateAvailable}
                    class:btn-ghost={!updateAvailable}
                    onclick={() => updateService(comp.key, comp.service)}
                    disabled={isUpdating || anyApplying}
                    aria-busy={isUpdating}
                    aria-label="Update {comp.label}"
                  >
                    {#if isUpdating}
                      <Spinner />
                    {:else if updateAvailable}
                      Update
                    {:else}
                      Recheck
                    {/if}
                  </button>
                  <!-- Update action feedback next to the Update button (§6: on the screen that triggered it) -->
                  {#if rowUpdateSuccess[comp.key]}
                    <span class="inline-success">{rowUpdateSuccess[comp.key]}</span>
                  {/if}
                  {#if rowUpdateError[comp.key]}
                    <span class="inline-error" role="alert">{rowUpdateError[comp.key]}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      <!-- ── Channel preference ─────────────────────────────────────────────── -->
      <section class="channel-section" aria-labelledby="channel-heading">
        <h3 id="channel-heading" class="section-heading">Update channel</h3>
        <p class="section-desc">Controls which releases are considered when tracking latest.</p>
        <div class="channel-toggle" role="group" aria-label="Update channel">
          <button
            class="channel-btn"
            class:channel-btn--active={channel === 'latest'}
            onclick={async () => {
              const prev = channel;
              channel = 'latest';
              channelError = '';
              try {
                await patchVersions({ OP_CHANNEL: 'latest' });
              } catch (e) {
                channel = prev;
                channelError = e instanceof Error ? e.message : 'Failed to save channel preference';
              }
            }}
            aria-pressed={channel === 'latest'}
          >Stable</button>
          <button
            class="channel-btn"
            class:channel-btn--active={channel === 'next'}
            onclick={async () => {
              const prev = channel;
              channel = 'next';
              channelError = '';
              try {
                await patchVersions({ OP_CHANNEL: 'next' });
              } catch (e) {
                channel = prev;
                channelError = e instanceof Error ? e.message : 'Failed to save channel preference';
              }
            }}
            aria-pressed={channel === 'next'}
          >Prerelease</button>
        </div>
        {#if channelError}
          <p class="inline-error" role="alert">{channelError}</p>
        {/if}
      </section>
    {/if}

    <!-- ── Desktop settings (Electron-only) ────────────────────────────── -->
    {#if inElectron}
      <section class="desktop-settings" aria-labelledby="desktop-settings-title">
        <h3 id="desktop-settings-title" class="section-heading">Desktop settings</h3>

        <div class="desktop-setting-row">
          <div class="setting-label">Launch on login</div>
          <label class="desktop-toggle">
            <input
              type="checkbox"
              checked={launchOnLoginEnabled}
              disabled={!launchOnLoginSupported || launchOnLoginSaving}
              onchange={onLaunchOnLoginChange}
            />
            <span>Start OpenPalm automatically when you sign in on this device.</span>
          </label>
          <p class="setting-hint">
            {#if launchOnLoginSupported}
              Uses the native desktop login-item integration for this platform.
            {:else}
              Not wired on this platform yet. The current desktop build only exposes this safely on macOS and Windows.
            {/if}
          </p>
        </div>

        <div class="desktop-setting-row">
          <div class="setting-label">Desktop notifications</div>
          {#if inElectron && typeof window.openpalm?.notify === 'function'}
            <label class="desktop-toggle">
              <input
                type="checkbox"
                checked={notificationsEnabled}
                onchange={(event) => {
                  notificationsEnabled = (event.currentTarget as HTMLInputElement).checked;
                  setDesktopNotifyEnabled(notificationsEnabled);
                  if (!notificationsEnabled) {
                    replyPreviewEnabled = false;
                    setDesktopReplyPreviewEnabled(false);
                  }
                }}
              />
              <span>Notify when the assistant replies or errors while the app is in the background.</span>
            </label>
            <label class="desktop-toggle desktop-toggle--nested">
              <input
                type="checkbox"
                checked={replyPreviewEnabled}
                disabled={!notificationsEnabled}
                onchange={(event) => {
                  replyPreviewEnabled = (event.currentTarget as HTMLInputElement).checked;
                  setDesktopReplyPreviewEnabled(replyPreviewEnabled);
                }}
              />
              <span>Include reply preview in the notification body.</span>
            </label>
            <p class="setting-hint">Reply previews stay off by default because desktop notifications can persist outside the app.</p>
          {:else}
            <label class="desktop-toggle">
              <input type="checkbox" disabled />
              <span>Notify when the assistant replies or errors while the app is in the background.</span>
            </label>
            <label class="desktop-toggle desktop-toggle--nested">
              <input type="checkbox" disabled />
              <span>Include reply preview in the notification body.</span>
            </label>
            <p class="setting-hint">Desktop notifications are available in the OpenPalm desktop app.</p>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .control-plane-line {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin: var(--s-sp-2) 0 0;
  }
  .control-plane-line strong {
    color: var(--s-ink);
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-4);
    flex-wrap: wrap;
    margin-bottom: var(--s-sp-4);
  }

  .header-actions {
    display: flex;
    gap: var(--s-sp-3);
    flex-wrap: wrap;
    flex-shrink: 0;
    margin-top: var(--s-sp-1);
  }

  .loading-line {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

  /* ── Status messages ── */
  .msg {
    margin: var(--s-sp-2) 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border-radius: 2px;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    border: var(--s-hair) solid var(--s-line);
  }
  .msg-success {
    border-color: var(--s-moss, #16a34a);
    color: var(--s-moss, #16a34a);
  }
  .msg-error {
    border-color: var(--s-seal, #ef4444);
    color: var(--s-seal, #ef4444);
  }

  /* ── Component table ── */
  .comp-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    margin-bottom: var(--s-sp-2);
  }
  .comp-table th {
    text-align: left;
    padding: var(--s-sp-2) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    border-bottom: var(--s-hair) solid var(--s-line);
  }
  .comp-table td {
    padding: var(--s-sp-2) var(--s-sp-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    vertical-align: middle;
    color: var(--s-ink);
  }
  .comp-table tr:last-child td {
    border-bottom: none;
  }
  .row-has-update td:first-child {
    border-left: 2px solid var(--s-amber, #f59e0b);
    padding-left: calc(var(--s-sp-3) - 2px);
  }

  .col-name   { width: 18%; }
  .col-running { width: 20%; }
  .col-pin    { width: 30%; }
  .col-avail  { width: 16%; }
  .col-action { width: 16%; text-align: right; }

  .comp-label {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }

  .ver {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-2);
  }
  .ver-new {
    color: var(--s-moss, #16a34a);
    font-weight: 600;
  }

  .health-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-left: var(--s-sp-2);
    vertical-align: middle;
    flex: none;
  }
  .health-healthy { background: var(--s-moss, #16a34a); }
  .health-starting, .health-unhealthy { background: var(--s-seal, #ef4444); }

  /* ── Pin chip + inline editor ── */
  .pin-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
    background: transparent;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    padding: 1px var(--s-sp-2);
    cursor: pointer;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-2);
    transition: border-color 0.1s;
    max-width: 100%;
    overflow: hidden;
  }
  .pin-chip:hover {
    border-color: var(--s-ink-2);
  }
  .pin-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pin-edit-icon {
    opacity: 0;
    font-size: 0.7em;
    flex: none;
  }
  .pin-chip:hover .pin-edit-icon {
    opacity: 0.5;
  }

  .pin-edit-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-wrap: wrap;
  }
  .pin-input {
    flex: 1;
    min-width: 8rem;
    padding: 2px var(--s-sp-2);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .btn-inline {
    padding: 2px var(--s-sp-2);
    border-radius: 2px;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    cursor: pointer;
    border: var(--s-hair) solid var(--s-line);
    background: transparent;
    color: var(--s-ink-2);
    white-space: nowrap;
  }
  .btn-save {
    border-color: var(--s-moss, #16a34a);
    color: var(--s-moss, #16a34a);
  }
  .btn-cancel { color: var(--s-ink-3); }

  .inline-success {
    display: block;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-moss, #16a34a);
    margin-top: 2px;
  }
  .inline-error {
    display: block;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-seal, #ef4444);
    margin-top: 2px;
  }

  .btn-sm {
    padding: var(--s-sp-1) var(--s-sp-3);
    font-size: var(--s-type-deed);
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-1);
  }

  /* ── Channel section ── */
  .channel-section {
    margin-top: var(--s-sp-6);
    padding-top: var(--s-sp-4);
    border-top: var(--s-hair) solid var(--s-line);
  }
  .section-heading {
    margin: 0 0 var(--s-sp-2) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    font-weight: 400;
  }
  .section-desc {
    margin: 0 0 var(--s-sp-3) 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    line-height: 1.5;
  }
  .channel-toggle {
    display: flex;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 4px;
    overflow: hidden;
    width: fit-content;
  }
  .channel-btn {
    padding: var(--s-sp-2) var(--s-sp-4);
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    border-right: var(--s-hair) solid var(--s-line);
    transition: background 0.1s, color 0.1s;
  }
  .channel-btn:last-child { border-right: none; }
  .channel-btn--active {
    background: var(--s-ink);
    color: var(--s-paper);
  }
  .channel-btn:not(.channel-btn--active):hover {
    background: var(--s-line-soft);
  }

  /* ── Desktop settings (Electron-only) ── */
  .desktop-settings {
    margin-top: var(--s-sp-5);
    border-top: var(--s-hair) solid var(--s-line);
    padding-top: var(--s-sp-4);
  }
  .setting-label {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    margin-bottom: var(--s-sp-1);
  }
  .setting-hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: var(--s-sp-1) 0 0;
    line-height: 1.5;
  }
  .desktop-setting-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    padding: var(--s-sp-3) 0;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .desktop-setting-row:last-child { border-bottom: none; }
  .desktop-toggle {
    display: flex;
    align-items: flex-start;
    gap: var(--s-sp-3);
    margin-top: var(--s-sp-1);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    cursor: pointer;
  }
  .desktop-toggle--nested {
    margin-left: var(--s-sp-6);
    margin-bottom: var(--s-sp-2);
  }

  .sr-only {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
