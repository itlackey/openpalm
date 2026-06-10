<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReleaseEntry, UiVersionEntry } from '$lib/api.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    desktopNotifyEnabled,
    desktopReplyPreviewEnabled,
    setDesktopNotifyEnabled,
    setDesktopReplyPreviewEnabled,
  } from '$lib/desktop-notifications.js';
  import { updateStatus, latestForChannel, type UpdateStatus } from '$lib/version-compare.js';

  interface Props {
    currentImageTag: string;
    selectedImageTag: string;
    tagChangeLoading: boolean;
    anyDangerousLoading: boolean;
    tokenStored: boolean;
    upgradeLoading: boolean;
    inElectron: boolean;
    /** Desktop (Electron) app version — null when not running in Electron. */
    electronVersion: string | null;
    /** Newer desktop version from the app's GitHub update check, if any. */
    electronLatestVersion: string | null;
    /** Download URL for the newer desktop release. */
    electronLatestUrl: string | null;
    /** Running @openpalm/ui version (the build currently serving this page). */
    uiVersion: string;
    uiVersions: UiVersionEntry[];
    uiVersionsLoading: boolean;
    selectedUiTag: string;
    uiDownloadLoading: boolean;
    uiDownloadReady: boolean;
    releases: ReleaseEntry[];
    releasesLoading: boolean;
    onSetImageTag: (tag: string) => void;
    onSelectedImageTagChange: (tag: string) => void;
    onUpgradeStack: () => void;
    onSelectedUiTagChange: (tag: string) => void;
    onDownloadUiVersion: (tag: string) => void;
    onRestartApp: () => void;
    onRefreshReleases: () => void;
  }

  let {
    currentImageTag,
    selectedImageTag,
    tagChangeLoading,
    anyDangerousLoading,
    tokenStored,
    upgradeLoading,
    inElectron,
    electronVersion,
    electronLatestVersion,
    electronLatestUrl,
    uiVersion,
    uiVersions,
    uiVersionsLoading,
    selectedUiTag,
    uiDownloadLoading,
    uiDownloadReady,
    releases,
    releasesLoading,
    onSetImageTag,
    onSelectedImageTagChange,
    onUpgradeStack,
    onSelectedUiTagChange,
    onDownloadUiVersion,
    onRestartApp,
    onRefreshReleases,
  }: Props = $props();

  function uiVersionLabel(v: UiVersionEntry): string {
    const tags: string[] = [];
    if (v.distTag) tags.push(v.distTag);
    else if (v.prerelease) tags.push('pre-release');
    return tags.length ? `${v.version} (${tags.join(', ')})` : v.version;
  }

  const RELEASES_URL = 'https://github.com/itlackey/openpalm/releases';

  // Per-unit "is there a newer build on this channel?" status, computed in the
  // browser from the release/npm data already loaded for the pickers. Each unit
  // compares against the newest version on ITS channel (a pre-release install
  // sees pre-releases; a stable one only sees stable), so the indicator can't
  // falsely read "up to date" the way a fixed text label did.
  const releaseCandidates = $derived(releases.map((r) => ({ version: r.tag, prerelease: r.prerelease })));
  const uiCandidates = $derived(uiVersions.map((v) => ({ version: v.version, prerelease: v.prerelease })));

  // Assistant = the platform image line (OP_IMAGE_TAG); latest = newest GitHub
  // platform release on this channel.
  const assistantLatest = $derived(latestForChannel(currentImageTag, releaseCandidates));
  const assistantStatus = $derived<UpdateStatus>(updateStatus(currentImageTag, assistantLatest));

  // App = the desktop (Electron) installer, shipped with each GitHub release.
  // Prefer the app's own update-check result; fall back to the newest release on
  // this channel. Only meaningful when actually running inside the desktop app.
  const appLatest = $derived(electronLatestVersion ?? latestForChannel(electronVersion, releaseCandidates));
  const appStatus = $derived<UpdateStatus>(inElectron ? updateStatus(electronVersion, appLatest) : 'unknown');
  const appDownloadUrl = $derived(
    electronLatestUrl ?? (appLatest ? `${RELEASES_URL}/tag/v${appLatest}` : RELEASES_URL),
  );

  // UI = the @openpalm/ui npm build serving this page; latest = newest on the
  // npm dist-tag channel that matches this build's stability.
  const uiLatest = $derived(latestForChannel(uiVersion, uiCandidates));
  const uiStatus = $derived<UpdateStatus>(updateStatus(uiVersion, uiLatest));
  let notificationsEnabled = $state(false);
  let replyPreviewEnabled = $state(false);
  let launchOnLoginSupported = $state(false);
  let launchOnLoginEnabled = $state(false);
  let launchOnLoginSaving = $state(false);

  onMount(() => {
    notificationsEnabled = desktopNotifyEnabled();
    replyPreviewEnabled = desktopReplyPreviewEnabled();
    void hydrateLaunchOnLogin();
  });

  async function hydrateLaunchOnLogin(): Promise<void> {
    const status = await window.openpalm?.launchOnLoginStatus?.();
    if (!status) return;
    launchOnLoginSupported = status.supported;
    launchOnLoginEnabled = status.enabled;
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

  function statusEmoji(s: UpdateStatus): string {
    return s === 'current' ? '✅' : s === 'update' ? '⬆️' : '';
  }
  function statusTitle(s: UpdateStatus): string {
    return s === 'current' ? 'Up to date' : s === 'update' ? 'Update available' : 'Update status unknown';
  }

  // Single spoken status for screen readers — covers every in-flight operation
  // on this screen so AT users get feedback for actions that restart services.
  const statusText = $derived(
    upgradeLoading
      ? 'Updating OpenPalm to the latest version…'
      : tagChangeLoading
        ? 'Installing the selected version and restarting…'
        : uiDownloadLoading
          ? 'Downloading the admin interface…'
          : releasesLoading || uiVersionsLoading
            ? 'Checking for updates…'
            : ''
  );
</script>

<div class="panel" role="tabpanel">
  <div class="panel-header">
    <div>
      <h2>Check-up</h2>
      <p class="panel-subtitle">Keep OpenPalm up to date. An update backs up your settings first, then briefly restarts your assistant.</p>
    </div>
    <button
      class="btn btn-sm btn-secondary refresh-releases"
      onclick={onRefreshReleases}
      disabled={releasesLoading || uiVersionsLoading}
      aria-busy={releasesLoading || uiVersionsLoading}
      title="Check GitHub for newer versions"
    >
      {#if releasesLoading || uiVersionsLoading}
        <Spinner /> Checking…
      {:else}
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Check for updates
      {/if}
    </button>
  </div>

  <!-- Polite status region: announces in-flight operations to assistive tech. -->
  <p class="status-live" role="status" aria-live="polite">{statusText}</p>

  <div class="panel-body">

    <!-- Recommended one-click update (safe path: backs up config first). -->
    <section class="update-card" aria-labelledby="update-primary-title">
      <div class="update-card-text">
        <h3 id="update-primary-title" class="update-title">Update to the latest version</h3>
        <p class="update-desc">
          Downloads and installs the newest OpenPalm release. Your settings are backed up first,
          then your assistant restarts — it will be offline for about a minute. Your data is kept.
        </p>
      </div>
      <button
        class="btn btn-primary update-go"
        onclick={onUpgradeStack}
        disabled={anyDangerousLoading || !tokenStored}
        aria-busy={upgradeLoading}
      >
        {#if upgradeLoading}
          <Spinner /> Updating…
        {:else}
          Update now
        {/if}
      </button>
    </section>

    <!-- Current versions + per-unit update status. The version chip's border
         colour + the emoji beside it signal up-to-date vs update-available; the
         inline action downloads/installs the newest build on this channel. -->
    <dl class="versions">
      <div class="versions-row">
        <dt>OpenPalm Assistant</dt>
        <dd>
          <span class="version-cell">
            <code class="version-value status-{assistantStatus}">{currentImageTag || '—'}</code>
            {#if statusEmoji(assistantStatus)}
              <span class="status-emoji" role="img" aria-label={statusTitle(assistantStatus)} title={statusTitle(assistantStatus)}>{statusEmoji(assistantStatus)}</span>
            {/if}
          </span>
          {#if assistantStatus === 'update'}
            <button
              class="btn btn-sm btn-secondary version-action"
              onclick={onUpgradeStack}
              disabled={anyDangerousLoading || !tokenStored}
              aria-busy={upgradeLoading}
            >
              {#if upgradeLoading}<Spinner /> Updating…{:else}Update to {assistantLatest}{/if}
            </button>
          {/if}
        </dd>
      </div>

      <div class="versions-row">
        <dt>OpenPalm App</dt>
        <dd>
          <span class="version-cell">
            <code class="version-value status-{appStatus}">{electronVersion || '—'}</code>
            {#if statusEmoji(appStatus)}
              <span class="status-emoji" role="img" aria-label={statusTitle(appStatus)} title={statusTitle(appStatus)}>{statusEmoji(appStatus)}</span>
            {/if}
          </span>
          {#if appStatus === 'update'}
            <a class="btn btn-sm btn-secondary version-action" href={appDownloadUrl} target="_blank" rel="noopener noreferrer">
              Download {appLatest}
            </a>
          {/if}
        </dd>
      </div>

      <div class="versions-row">
        <dt>OpenPalm UI</dt>
        <dd>
          <span class="version-cell">
            <code class="version-value status-{uiStatus}">{uiVersion || '—'}</code>
            {#if statusEmoji(uiStatus)}
              <span class="status-emoji" role="img" aria-label={statusTitle(uiStatus)} title={statusTitle(uiStatus)}>{statusEmoji(uiStatus)}</span>
            {/if}
          </span>
          {#if uiStatus === 'update'}
            {#if uiDownloadReady}
              <span class="version-action-note">
                Downloaded.
                {#if inElectron}
                  <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart app</button>
                {:else}
                  Restart OpenPalm to apply.
                {/if}
              </span>
            {:else}
              <button
                class="btn btn-sm btn-secondary version-action"
                onclick={() => { if (uiLatest) onDownloadUiVersion(uiLatest); }}
                disabled={uiDownloadLoading || !uiLatest}
                aria-busy={uiDownloadLoading}
              >
                {#if uiDownloadLoading}<Spinner /> Downloading…{:else}Download {uiLatest}{/if}
              </button>
            {/if}
          {/if}
        </dd>
      </div>
    </dl>

    <!-- Advanced: pin a specific version (rollback / troubleshooting). -->
    <details class="advanced">
      <summary>Advanced options</summary>
      <div class="advanced-body">

        <div class="version-section">
          <label class="version-label" for="stack-version-select">Install a specific version</label>
          <div class="version-input-row">
            {#if releasesLoading}
              <div class="version-select-skeleton"></div>
            {:else if releases.length > 0}
              <select
                id="stack-version-select"
                class="version-select"
                aria-label="OpenPalm version to install"
                value={selectedImageTag}
                onchange={(e) => onSelectedImageTagChange((e.currentTarget as HTMLSelectElement).value)}
                disabled={tagChangeLoading || anyDangerousLoading}
              >
                <option value="latest">latest</option>
                {#each releases as r (r.tag)}
                  <option value={r.tag}>{r.tag}{r.prerelease ? ' (pre-release)' : ''}</option>
                {/each}
              </select>
            {:else}
              <input
                id="stack-version-select"
                class="version-input"
                type="text"
                aria-label="OpenPalm version to install"
                placeholder="e.g. 0.11.0 or latest"
                value={selectedImageTag}
                oninput={(e) => onSelectedImageTagChange((e.currentTarget as HTMLInputElement).value)}
                disabled={tagChangeLoading || anyDangerousLoading}
              />
            {/if}
            <button
              class="btn btn-sm btn-secondary"
              onclick={() => { if (selectedImageTag.trim()) onSetImageTag(selectedImageTag.trim()); }}
              disabled={!selectedImageTag.trim() || tagChangeLoading || anyDangerousLoading}
              aria-busy={tagChangeLoading}
            >
              {#if tagChangeLoading}
                <Spinner /> Installing…
              {:else}
                Install &amp; restart
              {/if}
            </button>
          </div>
          <p class="version-hint">For rollback or troubleshooting. Installs the chosen version and restarts services (about a minute offline).</p>
        </div>

        {#if inElectron}
          <div class="version-divider"></div>
          <div class="version-section">
            <label class="version-label" for="ui-version-select">Admin interface version</label>
            <div class="version-input-row">
              {#if uiVersionsLoading}
                <div class="version-select-skeleton"></div>
              {:else if uiVersions.length > 0}
                <select
                  id="ui-version-select"
                  class="version-select"
                  aria-label="Admin interface version to download"
                  value={selectedUiTag}
                  onchange={(e) => onSelectedUiTagChange((e.currentTarget as HTMLSelectElement).value)}
                  disabled={uiDownloadLoading}
                >
                  {#each uiVersions as v (v.version)}
                    <option value={v.version}>{uiVersionLabel(v)}</option>
                  {/each}
                </select>
              {:else}
                <input
                  id="ui-version-select"
                  class="version-input"
                  type="text"
                  aria-label="Admin interface version to download"
                  placeholder="e.g. 0.11.0-beta.7"
                  value={selectedUiTag}
                  oninput={(e) => onSelectedUiTagChange((e.currentTarget as HTMLInputElement).value)}
                  disabled={uiDownloadLoading}
                />
              {/if}
              <button
                class="btn btn-sm btn-secondary"
                onclick={() => { if (selectedUiTag.trim()) onDownloadUiVersion(selectedUiTag.trim()); }}
                disabled={!selectedUiTag.trim() || uiDownloadLoading}
                aria-busy={uiDownloadLoading}
              >
                {#if uiDownloadLoading}
                  <Spinner /> Downloading…
                {:else}
                  Download
                {/if}
              </button>
            </div>
            {#if uiDownloadReady}
              <div class="version-restart-prompt">
                Admin interface updated.
                <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart app</button>
              </div>
            {:else}
              <p class="version-hint">Downloads and replaces the admin interface. Takes effect after restart.</p>
            {/if}
          </div>

          <div class="version-divider"></div>
          <div class="version-section">
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

          <div class="version-divider"></div>
          <div class="version-section">
            <div class="version-label">Desktop notifications</div>
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
          </div>
        {/if}

      </div>
    </details>

  </div>
</div>

<style>
  .panel-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-1) 0 0;
    max-width: 60ch;
  }

  .refresh-releases {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }
  .refresh-releases svg {
    flex-shrink: 0;
  }
  /* Once the header wraps, separate the button from the subtitle above it so it
     reads as an action, not a third line of text. */
  @media (max-width: 600px) {
    .refresh-releases {
      margin-top: var(--space-2);
    }
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

  /* ── Recommended update card ── */
  .update-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-bg-secondary);
  }
  .update-card-text {
    flex: 1;
    min-width: 14rem;
  }
  .update-title {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin: 0;
  }
  .update-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-1) 0 0;
    line-height: 1.5;
    max-width: 60ch;
  }
  .update-go {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* ── Current versions ── */
  .versions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: var(--space-5) 0 0;
  }

  .desktop-toggle {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    margin-top: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .desktop-toggle--nested {
    margin-left: var(--space-6);
  }
  .versions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .versions-row dt {
    font-size: var(--text-sm);
    color: var(--color-text);
  }
  .versions-row dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .version-cell {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .version-value {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-bg-secondary);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    /* Border colour IS the status signal — a 2px ring reads at a glance. */
    border: 2px solid var(--color-border);
    color: var(--color-text);
  }
  /* Up to date — green ring. */
  .version-value.status-current {
    border-color: var(--color-success, #16a34a);
  }
  /* Update available — amber ring. */
  .version-value.status-update {
    border-color: var(--color-warning, #d97706);
  }
  /* Unknown (no release data / moving tag) — neutral. */
  .version-value.status-unknown {
    border-color: var(--color-border);
  }

  .status-emoji {
    font-size: var(--text-sm);
    line-height: 1;
  }

  .version-action {
    flex-shrink: 0;
  }
  .version-action-note {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  /* ── Advanced disclosure ── */
  .advanced {
    margin-top: var(--space-5);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-4);
  }
  .advanced > summary {
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    list-style: revert;
  }
  .advanced > summary:hover {
    color: var(--color-text);
  }
  .advanced > summary:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .version-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .version-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .version-input-row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .version-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1-5) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
  }

  .version-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Secondary (not tertiary) for AA contrast in light theme. */
  .version-hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  .version-divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-3) 0;
  }

  .version-restart-prompt {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-success);
    padding: var(--space-2) var(--space-3);
    background: var(--color-success-bg);
    border-radius: var(--radius-md);
  }

  .version-select {
    flex: 1;
    min-width: 0;
    padding: var(--space-1-5) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
  }

  .version-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .version-select-skeleton {
    flex: 1;
    height: 34px;
    border-radius: var(--radius-md);
    background: linear-gradient(
      90deg,
      var(--color-bg-secondary) 25%,
      var(--color-bg-tertiary) 50%,
      var(--color-bg-secondary) 75%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .version-select-skeleton { animation: none; }
  }
</style>
