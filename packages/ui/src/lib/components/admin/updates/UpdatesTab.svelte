<script lang="ts">
  import { onMount } from 'svelte';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import { fetchVersions, patchVersions, applyChanges, downloadUiVersion } from '$lib/api.js';
  import {
    desktopNotifyEnabled,
    desktopReplyPreviewEnabled,
    setDesktopNotifyEnabled,
    setDesktopReplyPreviewEnabled,
  } from '$lib/desktop-notifications.js';

  // ── Version sections ─────────────────────────────────────────────────────────
  // Two groups of stack.env version pins, edited as plain text inputs:
  //  • Container images — exact Docker tags / "latest" / "next" (no semver ranges).
  //  • npm packages — installed at container boot; semver ranges allowed.
  // The key order here is the on-screen order; the labels are operator-facing.
  const SERVICE_FIELDS: { key: string; label: string; hint: string }[] = [
    { key: 'OP_ASSISTANT_VERSION', label: 'Assistant', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_GUARDIAN_VERSION', label: 'Guardian', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_PORTAL_VERSION', label: 'Portal (Discord/Slack/API)', hint: 'Docker image tag — exact tag, "latest", or "next".' },
    { key: 'OP_VOICE_VERSION', label: 'Voice', hint: 'Docker image tag — exact tag, "latest", or "next".' },
  ];
  const NPM_FIELDS: { key: string; label: string; hint: string }[] = [
    { key: 'OP_GUARDIAN_NPM_VERSION', label: 'Guardian package', hint: 'Empty = use the version baked into the guardian image. Semver range allowed.' },
    { key: 'OP_TOOL_OPENCODE_VERSION', label: 'OpenCode', hint: 'npm semver range, e.g. ^1.17.0.' },
    { key: 'OP_TOOL_AKM_VERSION', label: 'AKM CLI', hint: 'npm semver range, e.g. ^0.8.14.' },
    { key: 'OP_TOOL_CLAUDE_CODE_VERSION', label: 'Claude Code', hint: 'npm semver range, e.g. ^1.5.0.' },
    { key: 'OP_TOOL_CODEX_VERSION', label: 'Codex', hint: 'npm semver range, e.g. ^0.1.0.' },
  ];

  // The running control-plane version (PLATFORM_VERSION) — read-only header line.
  let platformVersion = $state('');
  // The version values loaded from the server (the on-disk baseline) and the
  // local edited copy. We diff against `loaded` so Apply only sends changes.
  let loaded = $state<Record<string, string>>({});
  let edited = $state<Record<string, string>>({});
  let loading = $state(true);
  let loadError = $state('');
  let applying = $state(false);
  let resultMessage = $state('');
  let resultType: 'success' | 'error' = $state('success');

  // Electron bridge state (these sections use window.openpalm directly — no props).
  let inElectron = $state(false);
  let notificationsEnabled = $state(false);
  let replyPreviewEnabled = $state(false);
  let launchOnLoginSupported = $state(false);
  let launchOnLoginEnabled = $state(false);
  let launchOnLoginSaving = $state(false);

  // Control-plane UI build install (Electron: IPC restart; CLI: SIGUSR2 restart).
  let uiBuildTag = $state('');
  let uiBuildBusy = $state(false);
  let uiBuildMessage = $state('');
  let uiBuildMessageType: 'success' | 'error' = $state('success');

  // Changed keys: the local edit differs from the loaded baseline.
  const changedKeys = $derived(
    Object.keys(edited).filter((k) => (edited[k] ?? '') !== (loaded[k] ?? '')),
  );
  const hasChanges = $derived(changedKeys.length > 0);

  onMount(() => {
    inElectron = typeof window !== 'undefined' && typeof window.openpalm !== 'undefined';
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
      loaded = { ...data.versions };
      edited = { ...data.versions };
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

  function setField(key: string, value: string): void {
    edited[key] = value;
  }

  async function handleApply(): Promise<void> {
    if (applying || !hasChanges) return;
    applying = true;
    resultMessage = '';
    try {
      // 1) Persist only the changed version keys to stack.env.
      const updates: Record<string, string> = {};
      for (const k of changedKeys) updates[k] = edited[k] ?? '';
      await patchVersions(updates);
      loaded = { ...edited };

      // 2) Recreate the stack so the new image tags / package pins take effect.
      const result = await applyChanges();
      if (result.overallSuccess) {
        resultType = 'success';
        resultMessage = result.restarted.length > 0
          ? `Versions applied. Restarted: ${result.restarted.join(', ')}.`
          : 'Versions applied.';
      } else if (result.failed.length > 0) {
        resultType = 'error';
        const failures = result.failed.map((f) => `${f.service}: ${f.reason}`).join('; ');
        resultMessage = `Saved, but applying failed for ${result.failed.length} service(s): ${failures}`;
      } else if (!result.dockerAvailable) {
        resultType = 'error';
        resultMessage = 'Versions saved, but Docker is unavailable — services were not restarted.';
      } else {
        resultType = 'error';
        resultMessage = `Apply failed: ${result.error ?? 'unknown error'}`;
      }
    } catch (e) {
      const err = e as { message?: string };
      resultType = 'error';
      resultMessage = `Failed to apply versions: ${err.message ?? e}`;
    }
    applying = false;
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
    applying
      ? 'Applying versions and restarting services…'
      : loading
        ? 'Loading versions…'
        : '',
  );

  async function handleUiBuildInstall(): Promise<void> {
    const tag = uiBuildTag.trim();
    if (!tag || uiBuildBusy) return;
    uiBuildBusy = true;
    uiBuildMessage = '';
    try {
      const result = await downloadUiVersion(tag);
      if (result.pendingRestart) {
        // Electron IPC path — signal the harness to kill + respawn the UI child.
        const restarted = await window.openpalm?.restartUiServer?.();
        if (restarted) {
          uiBuildMessageType = 'success';
          uiBuildMessage = `Installed ${tag} and restarted the admin UI.`;
        } else {
          uiBuildMessageType = 'error';
          uiBuildMessage = `Downloaded ${tag} but the restart failed — reload the page to apply it.`;
        }
      } else if (result.restarting) {
        uiBuildMessageType = 'success';
        uiBuildMessage = `Installed ${tag} — restarting…`;
      } else {
        uiBuildMessageType = 'success';
        uiBuildMessage = `Downloaded ${tag}. Restart the admin UI to apply it.`;
      }
      uiBuildTag = '';
    } catch (e) {
      uiBuildMessageType = 'error';
      uiBuildMessage = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    uiBuildBusy = false;
  }
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Versions</h2>
      <p class="panel-subtitle">Pin the version of each container image and bundled tool.</p>
      <p class="control-plane-line">
        Control plane: <strong>{platformVersion || '—'}</strong>
      </p>
    </div>
  </div>

  <!-- Polite status region for assistive tech. -->
  <p class="status-live" role="status" aria-live="polite">{statusText}</p>

  <div class="panel-body">
    {#if loadError}
      <p class="result-message result-error" role="alert">{loadError}</p>
    {/if}

    {#if loading}
      <p class="loading-line"><Spinner /> Loading versions…</p>
    {:else}
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

      <section class="version-group" aria-labelledby="version-npm-title">
        <h3 id="version-npm-title" class="version-group-title">npm packages</h3>
        <p class="version-group-subtitle">
          Installed at container boot. Semver ranges are allowed (npm resolves them).
        </p>
        {#each NPM_FIELDS as field (field.key)}
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

      <div class="apply-row">
        <button
          class="btn btn-primary"
          onclick={handleApply}
          disabled={applying || !hasChanges}
          aria-busy={applying}
        >
          {#if applying}
            <Spinner /> Applying…
          {:else}
            Apply
          {/if}
        </button>
        <p class="apply-hint">
          Saves the changed versions, then recreates the stack so the new images and packages take effect
          (about a minute offline). Your data is kept.
        </p>
      </div>

      {#if resultMessage}
        <p class="result-message" class:result-success={resultType === 'success'} class:result-error={resultType === 'error'} role="status">
          {resultMessage}
        </p>
      {/if}
    {/if}

    <section class="version-group" aria-labelledby="ui-build-title">
      <h3 id="ui-build-title" class="version-group-title">Admin UI build</h3>
      <p class="version-group-subtitle">
        Install a specific <code>@openpalm/ui</code> npm version. The new build takes effect after the
        admin UI restarts — done automatically in the desktop app; reload the page otherwise.
      </p>
      <div class="ui-build-row">
        <label class="version-label" for="ui-build-tag">Version tag</label>
        <input
          id="ui-build-tag"
          class="version-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="e.g. 0.12.19 or latest"
          bind:value={uiBuildTag}
          disabled={uiBuildBusy}
        />
        <button
          class="btn btn-secondary"
          onclick={handleUiBuildInstall}
          disabled={uiBuildBusy || !uiBuildTag.trim()}
          aria-busy={uiBuildBusy}
        >
          {#if uiBuildBusy}
            <Spinner /> Installing…
          {:else}
            Install
          {/if}
        </button>
      </div>
      {#if uiBuildMessage}
        <p
          class="result-message"
          class:result-success={uiBuildMessageType === 'success'}
          class:result-error={uiBuildMessageType === 'error'}
          role="status"
        >
          {uiBuildMessage}
        </p>
      {/if}
    </section>

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
          {#if typeof window !== 'undefined' && typeof window.openpalm?.notify === 'function'}
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

  /* Visually hidden, still announced by screen readers. */
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

  .loading-line {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
  }

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
  .version-field:last-child {
    border-bottom: none;
  }

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
  .version-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .version-hint {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin: 0;
    line-height: 1.5;
  }

  .ui-build-row {
    display: flex;
    align-items: flex-start;
    gap: var(--s-sp-3);
    flex-wrap: wrap;
  }
  .ui-build-row .version-input {
    flex: 1;
    min-width: 10rem;
  }
  .ui-build-row .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-shrink: 0;
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
    border-color: var(--s-moss);
    color: var(--s-moss);
  }
  .result-error {
    border-color: var(--s-seal);
    color: var(--s-seal);
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
  .desktop-setting-row:last-child {
    border-bottom: none;
  }
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
