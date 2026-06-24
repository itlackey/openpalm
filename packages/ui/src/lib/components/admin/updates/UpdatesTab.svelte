<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    fetchVersions,
    fetchLatestVersions,
    patchVersions,
    applyChanges,
    downloadUiVersion,
  } from '$lib/api.js';
  import {
    desktopNotifyEnabled,
    desktopReplyPreviewEnabled,
    setDesktopNotifyEnabled,
    setDesktopReplyPreviewEnabled,
  } from '$lib/desktop-notifications.js';

  // ── Field metadata ────────────────────────────────────────────────────────
  const SERVICE_FIELDS: { key: string; label: string; hint: string }[] = [
    { key: 'OP_ASSISTANT_VERSION', label: 'Assistant', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_GUARDIAN_VERSION', label: 'Guardian', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_PORTAL_VERSION', label: 'Portal (Discord/Slack/API)', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_VOICE_VERSION', label: 'Voice', hint: 'Docker image tag — exact tag, "latest", or "next".' },
  ];
  const UI_FIELD = { key: 'OP_UI_VERSION', label: 'Admin UI', hint: 'Takes effect after the UI restarts — automatic in the desktop app.' };
  const ALL_FIELDS = [...SERVICE_FIELDS, UI_FIELD];

  // ── Mode ──────────────────────────────────────────────────────────────────
  // Loaded from and persisted to the server (configDir/update-mode.json).
  // 'auto'   — one-click "update all to latest"
  // 'manual' — individual text inputs (original behaviour)
  type UpdateMode = 'auto' | 'manual';

  let mode = $state<UpdateMode>('auto');

  // ── Current versions (loaded from stack.env) ──────────────────────────────
  let platformVersion = $state('');
  let loaded = $state<Record<string, string>>({});
  let edited = $state<Record<string, string>>({});
  let loading = $state(true);
  let loadError = $state('');

  // ── Latest versions (fetched on demand from Docker Hub + npm) ─────────────
  let latest = $state<Record<string, string | null>>({});
  let latestErrors = $state<string[]>([]);
  let latestFetchedAt = $state('');
  let checkingLatest = $state(false);
  let checkError = $state('');

  // ── Apply state ───────────────────────────────────────────────────────────
  let applying = $state(false);
  let resultMessage = $state('');
  let resultIsError = $state(false);

  // ── Manual mode: diff from loaded baseline ────────────────────────────────
  const changedKeys = $derived(
    Object.keys(edited).filter((k) => (edited[k] ?? '') !== (loaded[k] ?? '')),
  );
  const hasManualChanges = $derived(changedKeys.length > 0);

  // ── Auto mode: keys where latest differs from current ────────────────────
  // Auto mode pins npm packages to exact versions, so any diff (even range vs
  // concrete) is a meaningful change. If the operator wants range semantics they
  // use manual mode.
  const autoChanges = $derived(
    ALL_FIELDS
      .map((f) => f.key)
      .filter((k) => {
        const lat = latest[k];
        return lat !== null && lat !== undefined && lat !== (loaded[k] ?? '');
      })
  );
  const hasLatestFetch = $derived(latestFetchedAt !== '');
  const hasAutoUpdates = $derived(autoChanges.length > 0);

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
      loaded = { ...data.versions, OP_UI_VERSION: data.platformVersion };
      edited = { ...data.versions, OP_UI_VERSION: data.platformVersion };
      mode = data.autoUpdate ? 'auto' : 'manual';
    } catch (e) {
      const err = e as { message?: string };
      loadError = `Failed to load versions: ${err.message ?? e}`;
    }
    loading = false;
  }

  async function hydrateLaunchOnLogin(): Promise<void> {
    const status = await window.openpalm?.launchOnLoginStatus?.();
    if (!status) return;
    launchOnLoginSupported = status.supported;
    launchOnLoginEnabled = status.enabled;
  }

  function handleSetMode(newMode: UpdateMode): void {
    mode = newMode;
    patchVersions({ OP_AUTO_UPDATE: newMode === 'auto' ? 'true' : 'false' }).catch(() => {});
  }

  // ── Auto mode: check for latest versions ─────────────────────────────────
  async function handleCheckLatest(): Promise<void> {
    if (checkingLatest) return;
    checkingLatest = true;
    checkError = '';
    latestErrors = [];
    try {
      const data = await fetchLatestVersions();
      latest = data.versions;
      latestFetchedAt = data.fetchedAt;
      if (data.errors.length > 0) latestErrors = data.errors;
    } catch (e) {
      const err = e as { message?: string };
      checkError = `Check failed: ${err.message ?? e}`;
    }
    checkingLatest = false;
  }

  // ── Auto mode: apply latest versions ─────────────────────────────────────
  async function handleAutoUpdate(): Promise<void> {
    if (applying || !hasAutoUpdates) return;
    applying = true;
    resultMessage = '';
    resultIsError = false;
    try {
      const stackUpdates: Record<string, string> = {};
      let uiVersion: string | undefined;
      for (const k of autoChanges) {
        const v = latest[k];
        if (v === null || v === undefined) continue;
        if (k === 'OP_UI_VERSION') uiVersion = v;
        else stackUpdates[k] = v;
      }
      await applyVersionChanges(stackUpdates, uiVersion);
      if (!resultIsError) {
        const refreshed = await fetchVersions();
        loaded = { ...refreshed.versions, OP_UI_VERSION: refreshed.platformVersion };
        edited = { ...refreshed.versions, OP_UI_VERSION: refreshed.platformVersion };
        latest = {};
        latestFetchedAt = '';
      }
    } catch (e) {
      const err = e as { message?: string };
      resultIsError = true;
      resultMessage = `Failed to update: ${err.message ?? e}`;
    }
    applying = false;
  }

  // ── Shared apply pipeline (auto + manual modes) ───────────────────────────
  // Two kinds of change, handled distinctly:
  //  - Image-tag pins (OP_*_VERSION): no control-plane restart needed → reconcile
  //    + pull + recreate immediately via /admin/update.
  //  - UI build (OP_UI_VERSION) IS the control plane: download + restart. The
  //    harness reloads the window onto the new code, landing on the splash apply
  //    step which reconciles the home + recreates the stack on the NEW control
  //    plane. (A UI-only update used to skip the stack entirely — the bug.)
  async function applyVersionChanges(
    stackUpdates: Record<string, string>,
    uiVersion: string | undefined,
  ): Promise<void> {
    const hasStack = Object.keys(stackUpdates).length > 0;

    if (hasStack) {
      await patchVersions(stackUpdates);
      const result = await applyChanges();
      if (!result.overallSuccess) {
        resultIsError = true;
        resultMessage = result.failed.length > 0
          ? `Saved, but applying failed: ${result.failed.map((f) => `${f.service}: ${f.reason}`).join('; ')}`
          : !result.dockerAvailable
            ? 'Versions saved, but Docker is unavailable — services were not restarted.'
            : `Apply failed: ${result.error ?? 'unknown error'}`;
        return;
      }
      resultMessage = result.pullWarning
        ? `Restarted, but images may not have updated: ${result.pullWarning}`
        : result.restarted.length > 0
          ? `Versions applied. Restarted: ${result.restarted.join(', ')}.`
          : 'Versions applied.';
    }

    // Activate a new control plane last: the harness restarts the UI server and
    // reloads the window onto it, so the splash apply step finishes the reconcile.
    if (uiVersion) resultMessage = await applyUiVersion(uiVersion);
  }

  // ── Manual mode: apply changed fields ────────────────────────────────────
  function setField(key: string, value: string): void {
    edited[key] = value;
  }

  async function handleManualApply(): Promise<void> {
    if (applying || !hasManualChanges) return;
    applying = true;
    resultMessage = '';
    resultIsError = false;
    try {
      const stackUpdates: Record<string, string> = {};
      let uiVersion: string | undefined;
      for (const k of changedKeys) {
        if (k === 'OP_UI_VERSION') uiVersion = edited[k];
        else stackUpdates[k] = edited[k] ?? '';
      }
      loaded = { ...edited };
      await applyVersionChanges(stackUpdates, uiVersion);
    } catch (e) {
      const err = e as { message?: string };
      resultIsError = true;
      resultMessage = `Failed to apply versions: ${err.message ?? e}`;
    }
    applying = false;
  }

  // Download a new UI build and activate it. The control plane only changes once
  // the UI server is respawned onto the new build AND the window reloads onto it.
  async function applyUiVersion(version: string): Promise<string> {
    const result = await downloadUiVersion(version);
    if (result.pendingRestart) {
      // Electron: the harness respawns the UI server and reloads the window onto
      // the new control plane (which lands on the splash apply step). Fire-and-
      // forget — the window navigates away when the restart completes.
      void window.openpalm?.restartUiServer?.();
      return `Updating to ${version} — restarting…`;
    }
    if (result.restarting) {
      // Host CLI supervisor respawns the process; reload onto the new code.
      setTimeout(() => { location.href = '/'; }, 4_000);
      return `UI updated to ${version} — reloading in a moment…`;
    }
    return `UI ${version} downloaded. Restart the admin UI to apply it.`;
  }

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

  const statusText = $derived(
    applying ? 'Applying versions and restarting services…'
      : loading ? 'Loading versions…'
      : checkingLatest ? 'Checking for latest versions…'
      : '',
  );
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Versions</h2>
      <p class="panel-subtitle">Keep your stack current or pin specific versions.</p>
      <p class="control-plane-line">
        Control plane: <strong>{platformVersion || '—'}</strong>
      </p>
    </div>
    <div class="mode-toggle" role="group" aria-label="Update mode">
      <button
        class="mode-btn"
        class:mode-btn--active={mode === 'auto'}
        onclick={() => handleSetMode('auto')}
        aria-pressed={mode === 'auto'}
      >Automatic</button>
      <button
        class="mode-btn"
        class:mode-btn--active={mode === 'manual'}
        onclick={() => handleSetMode('manual')}
        aria-pressed={mode === 'manual'}
      >Manual</button>
    </div>
  </div>

  {#if statusText}
    <p class="status-live" role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
  {/if}

  <div class="panel-body">
    {#if loadError}
      <p class="result-message result-error" role="alert">{loadError}</p>
    {/if}

    {#if loading}
      <p class="loading-line"><Spinner /> Loading versions…</p>
    {:else if mode === 'auto'}
      <!-- ═══════════════════════════════════════════════════════════════════
           AUTOMATIC MODE
           ══════════════════════════════════════════════════════════════════ -->
      <section class="auto-section" aria-labelledby="auto-mode-desc">
        <p id="auto-mode-desc" class="auto-description">
          Check Docker Hub and npm for the latest stable release of each image and
          package, then apply them all in one step. npm packages are pinned to their
          exact latest version. The stack will restart (~1 min offline) and your data
          is kept.
        </p>

        {#if !hasLatestFetch}
          <div class="auto-action-row">
            <button
              class="btn btn-primary"
              onclick={handleCheckLatest}
              disabled={checkingLatest}
              aria-busy={checkingLatest}
            >
              {#if checkingLatest}
                <Spinner /> Checking…
              {:else}
                Check for updates
              {/if}
            </button>
            {#if checkError}
              <p class="result-message result-error" role="alert">{checkError}</p>
            {/if}
          </div>
        {:else}
          <div class="latest-results">
            {#if latestErrors.length > 0}
              <div role="status">
                {#each latestErrors as err (err)}
                  <p class="registry-warning">⚠ {err}</p>
                {/each}
              </div>
            {/if}

            <table class="version-table" aria-label="Version comparison">
              <thead>
                <tr>
                  <th scope="col" class="col-component">Component</th>
                  <th scope="col" class="col-current">Current</th>
                  <th scope="col" class="col-latest">Latest</th>
                  <th scope="col" class="col-status">Status</th>
                </tr>
              </thead>
              <tbody>
                {#each ALL_FIELDS as field (field.key)}
                  {@const cur = loaded[field.key] ?? ''}
                  {@const lat = latest[field.key]}
                  {@const changed = lat !== null && lat !== undefined && lat !== cur}
                  {@const unavailable = lat === null || lat === undefined}
                  <tr class:row-changed={changed}>
                    <td class="col-component">{field.label}</td>
                    <td class="col-current"><code>{cur || '—'}</code></td>
                    <td class="col-latest">
                      {#if unavailable}
                        <span class="val-unavailable">unavailable</span>
                      {:else}
                        <code class:val-new={changed}>{lat}</code>
                      {/if}
                    </td>
                    <td class="col-status">
                      {#if unavailable}
                        <span class="badge badge-warn">?</span>
                      {:else if changed}
                        <span class="badge badge-update">update</span>
                      {:else}
                        <span class="badge badge-ok">current</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>

            <div class="auto-action-row">
              {#if hasAutoUpdates}
                <button
                  class="btn btn-primary"
                  onclick={handleAutoUpdate}
                  disabled={applying}
                  aria-busy={applying}
                >
                  {#if applying}
                    <Spinner /> Applying…
                  {:else}
                    Update {autoChanges.length} component{autoChanges.length === 1 ? '' : 's'}
                  {/if}
                </button>
                <p class="apply-hint">
                  Saves the versions shown above, then recreates the stack (~1 min offline). Your data is kept.
                </p>
              {:else}
                <p class="up-to-date">Everything is up to date.</p>
              {/if}
              <button
                class="btn btn-ghost recheck-btn"
                onclick={handleCheckLatest}
                disabled={checkingLatest || applying}
                aria-busy={checkingLatest}
              >
                {checkingLatest ? 'Checking…' : 'Re-check'}
              </button>
            </div>
          </div>
        {/if}
      </section>
    {:else}
      <!-- ═══════════════════════════════════════════════════════════════════
           MANUAL MODE
           ══════════════════════════════════════════════════════════════════ -->
      <section class="version-group" aria-labelledby="version-images-title">
        <h3 id="version-images-title" class="version-group-title">Container images</h3>
        <p class="version-group-subtitle">
          Each image rides its own tag. Use an exact tag, <code>latest</code>, or <code>next</code> — not a semver range.
        </p>
        {#each SERVICE_FIELDS as field (field.key)}
          <div class="version-field">
            <label class="version-label" for="version-{field.key}">{field.label}</label>
            <input
              id="version-{field.key}"
              class="version-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              value={edited[field.key] ?? ''}
              oninput={(e) => setField(field.key, (e.currentTarget as HTMLInputElement).value)}
              disabled={applying}
            />
            <p class="version-hint">{field.hint}</p>
          </div>
        {/each}
      </section>

      <section class="version-group" aria-labelledby="version-ui-title">
        <h3 id="version-ui-title" class="version-group-title">Admin UI</h3>
        <div class="version-field">
          <label class="version-label" for="version-OP_UI_VERSION">{UI_FIELD.label}</label>
          <input
            id="version-OP_UI_VERSION"
            class="version-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value={edited[UI_FIELD.key] ?? ''}
            oninput={(e) => setField(UI_FIELD.key, (e.currentTarget as HTMLInputElement).value)}
            disabled={applying}
          />
          <p class="version-hint">{UI_FIELD.hint}</p>
        </div>
      </section>

      <div class="apply-row">
        <button
          class="btn btn-primary"
          onclick={handleManualApply}
          disabled={applying || !hasManualChanges}
          aria-busy={applying}
        >
          {#if applying}
            <Spinner /> Applying…
          {:else}
            Apply
          {/if}
        </button>
        <p class="apply-hint">
          Saves the changed versions, then recreates the stack so the new images and packages take
          effect (~1 min offline). Your data is kept.
        </p>
      </div>
    {/if}

    {#if resultMessage}
      <p
        class="result-message"
        class:result-success={!resultIsError}
        class:result-error={resultIsError}
        role="status"
      >
        {resultMessage}
      </p>
    {/if}

    <!-- ── Desktop settings (Electron-only) ────────────────────────────── -->
    {#if inElectron}
      <section class="desktop-settings" aria-labelledby="desktop-settings-title">
        <h3 id="desktop-settings-title" class="desktop-settings-title">Desktop settings</h3>

        <div class="desktop-setting-row">
          <div class="version-label">Launch on login</div>
          <label class="desktop-toggle">
            <input
              type="checkbox"
              checked={launchOnLoginEnabled}
              disabled={!launchOnLoginSupported || launchOnLoginSaving}
              onchange={onLaunchOnLoginChange}
            />
            <span>Start OpenPalm automatically when you sign in on this device.</span>
          </label>
          <p class="version-hint">
            {#if launchOnLoginSupported}
              Uses the native desktop login-item integration for this platform.
            {:else}
              Not wired on this platform yet. The current desktop build only exposes this safely on macOS and Windows.
            {/if}
          </p>
        </div>

        <div class="desktop-setting-row">
          <div class="version-label">Desktop notifications</div>
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
            <p class="version-hint">Reply previews stay off by default because desktop notifications can persist outside the app.</p>
          {:else}
            <label class="desktop-toggle">
              <input type="checkbox" disabled />
              <span>Notify when the assistant replies or errors while the app is in the background.</span>
            </label>
            <label class="desktop-toggle desktop-toggle--nested">
              <input type="checkbox" disabled />
              <span>Include reply preview in the notification body.</span>
            </label>
            <p class="version-hint">Desktop notifications are available in the OpenPalm desktop app.</p>
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

  .status-live {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-sp-4);
    flex-wrap: wrap;
  }

  /* ── Mode toggle ── */
  .mode-toggle {
    display: flex;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
    margin-top: var(--s-sp-1);
  }
  .mode-btn {
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
  .mode-btn:last-child {
    border-right: none;
  }
  .mode-btn--active {
    background: var(--s-ink);
    color: var(--s-paper);
  }
  .mode-btn:not(.mode-btn--active):hover {
    background: var(--s-line-soft);
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

  /* ── Automatic mode ── */
  .auto-section {
    margin-top: var(--s-sp-3);
  }
  .auto-description {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: 0 0 var(--s-sp-4) 0;
    line-height: 1.5;
    max-width: 60ch;
  }

  .auto-action-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-4);
    flex-wrap: wrap;
    margin-top: var(--s-sp-4);
  }

  .latest-results {
    margin-top: var(--s-sp-2);
  }

  /* Version comparison table */
  .version-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    margin-bottom: var(--s-sp-2);
  }
  .version-table th {
    text-align: left;
    padding: var(--s-sp-2) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    border-bottom: var(--s-hair) solid var(--s-line);
  }
  .version-table td {
    padding: var(--s-sp-2) var(--s-sp-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    vertical-align: middle;
    color: var(--s-ink);
  }
  .version-table tr:last-child td {
    border-bottom: none;
  }
  .row-changed {
    background: color-mix(in srgb, var(--s-amber, #f59e0b) 8%, transparent);
  }
  .col-component { width: 30%; }
  .col-current, .col-latest { width: 28%; }
  .col-status { width: 14%; text-align: center; }
  .version-table code {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .val-new {
    color: var(--s-moss, #16a34a);
    font-weight: 600;
  }
  .val-unavailable {
    color: var(--s-ink-3);
    font-style: italic;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 1px var(--s-sp-2);
    border-radius: 2px;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
  }
  .badge-ok {
    background: color-mix(in srgb, var(--s-moss, #16a34a) 12%, transparent);
    color: var(--s-moss, #16a34a);
  }
  .badge-update {
    background: color-mix(in srgb, var(--s-amber, #f59e0b) 15%, transparent);
    color: color-mix(in srgb, var(--s-amber, #f59e0b) 80%, var(--s-ink));
  }
  .badge-warn {
    background: color-mix(in srgb, var(--s-ink-3) 10%, transparent);
    color: var(--s-ink-3);
  }

  .up-to-date {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-moss, #16a34a);
    margin: 0;
  }

  .recheck-btn { margin-left: auto; }

  .registry-warning {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0 0 var(--s-sp-1) 0;
  }

  /* ── Manual mode ── */
  .version-group {
    margin-top: var(--s-sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
  }
  .version-group:first-of-type {
    margin-top: var(--s-sp-2);
  }
  .version-group-title {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }
  .version-group-subtitle {
    margin: 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    max-width: 60ch;
    line-height: 1.5;
  }
  .version-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-2) 0;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .version-field:last-child { border-bottom: none; }
  .version-label {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .version-input {
    width: 100%;
    min-width: 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }
  .version-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .version-hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
    line-height: 1.5;
  }

  .apply-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-4);
    flex-wrap: wrap;
    margin-top: var(--s-sp-5);
    padding-top: var(--s-sp-4);
    border-top: var(--s-hair) solid var(--s-line);
  }
  .apply-row .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-shrink: 0;
  }
  .apply-hint {
    flex: 1;
    min-width: 14rem;
    margin: 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    line-height: 1.5;
    max-width: 60ch;
  }

  .result-message {
    margin: var(--s-sp-3) 0 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border-radius: 2px;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    border: var(--s-hair) solid var(--s-line);
  }
  .result-success {
    border-color: var(--s-moss, #16a34a);
    color: var(--s-moss, #16a34a);
  }
  .result-error {
    border-color: var(--s-seal, #ef4444);
    color: var(--s-seal, #ef4444);
  }

  /* ── Desktop settings (Electron-only) ── */
  .desktop-settings {
    margin-top: var(--s-sp-5);
    border-top: var(--s-hair) solid var(--s-line);
    padding-top: var(--s-sp-4);
  }
  .desktop-settings-title {
    margin: 0 0 var(--s-sp-3) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
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
    margin-top: var(--s-sp-3);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .desktop-toggle--nested {
    margin-left: var(--s-sp-6);
    margin-bottom: var(--s-sp-2);
  }
</style>
