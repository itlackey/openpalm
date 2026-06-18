<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReleaseEntry, UiVersionEntry, StackServiceVersion } from '$lib/api.js';
  import Spinner from '$lib/components/common/Spinner.svelte';
  import {
    desktopNotifyEnabled,
    desktopReplyPreviewEnabled,
    setDesktopNotifyEnabled,
    setDesktopReplyPreviewEnabled,
  } from '$lib/desktop-notifications.js';
  import { updateStatus, latestForChannel, formatVersionForDisplay, channelOf, compareVersions, isSemver, type UpdateStatus } from '$lib/version-compare.js';

  interface Props {
    currentImageTag: string;
    /** Every configured stack piece (assistant, guardian, chat portal, voice,
     *  ollama as applicable) + the tag it actually runs. Each carries its own
     *  best-effort latest tag (latestVersion) from Docker Hub so the rows
     *  compare per-unit, not against a single shared tag. */
    services?: StackServiceVersion[];
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
    /** True when the native harness moved and the app must be RE-DOWNLOADED
     *  (the control plane self-updates; the harness does not). */
    harnessUpdateAvailable?: boolean;
    /** Running @openpalm/ui version (the build currently serving this page). */
    uiVersion: string;
    uiVersions: UiVersionEntry[];
    uiVersionsLoading: boolean;
    selectedUiTag: string;
    uiDownloadLoading: boolean;
    uiDownloadReady: boolean;
    /** Supervisor is respawning the UI server against the new build; the page
     *  will auto-reload once it's back up (design §6.2). */
    uiDownloadRestarting: boolean;
    releases: ReleaseEntry[];
    /** Per-unit available Docker Hub tags for the per-unit version pickers,
     *  keyed by service id (assistant/guardian/portal/voice). Bare semver,
     *  v-prefixed as Docker Hub returns them; the UI strips the v for display. */
    unitTags?: Record<string, string[]>;
    releasesLoading: boolean;
    /** Running control-plane version (PLATFORM_VERSION). The dropdown is already
     *  filtered to tags ≤ this server-side (#492); used to label "you are on X"
     *  and for the active-channel indicator. */
    platformVersion?: string;
    /** Latest published @openpalm/lib on npm — the "is the platform itself up to
     *  date?" signal, separate from the container image latest tags. */
    platformLatest?: string | null;
    /** Latest published assistant image tag from Docker Hub (bare semver, no
     *  v-prefix). Backward-compat signal; the per-unit rows use each service's
     *  own latestVersion. */
    latestImageTag?: string | null;
    /** Per-unit image pin: the unit currently being installed (null when idle).
     *  Any unit install disables the others so two pins can't race on stack.env. */
    unitInstallLoading?: string | null;
    /** #501 per-unit downgrade confirmation: set when pinning a unit to an older
     *  tag; the UI shows a plain warning + confirm, then re-applies. */
    unitDowngradePrompt?: { unit: string; tag: string; currentVersion: string; targetVersion: string; message: string } | null;
    onSetUnitImageTag: (unit: string, tag: string) => void;
    onConfirmUnitDowngrade?: () => void;
    onCancelUnitDowngrade?: () => void;
    onUpgradeStack: () => void;
    onSelectedUiTagChange: (tag: string) => void;
    onDownloadUiVersion: (tag: string) => void;
    onRestartApp: () => void;
    onRefreshReleases: () => void;
  }

  let {
    currentImageTag,
    services = [],
    anyDangerousLoading,
    tokenStored,
    upgradeLoading,
    inElectron,
    electronVersion,
    electronLatestVersion,
    electronLatestUrl,
    harnessUpdateAvailable = false,
    uiVersion,
    uiVersions,
    uiVersionsLoading,
    selectedUiTag,
    uiDownloadLoading,
    uiDownloadReady,
    uiDownloadRestarting,
    releases,
    unitTags = {},
    releasesLoading,
    platformVersion = '',
    platformLatest = null,
    latestImageTag = null,
    unitInstallLoading = null,
    unitDowngradePrompt = null,
    onSetUnitImageTag,
    onConfirmUnitDowngrade,
    onCancelUnitDowngrade,
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
  // Only releases that actually include an Electron installer drive the app
  // update badge. Patch platform releases skip electron builds (include_electron=false).
  const releaseCandidates = $derived(
    releases
      .filter((r) => r.hasElectronBuild)
      .map((r) => ({ version: r.tag, prerelease: r.prerelease }))
  );
  const uiCandidates = $derived(uiVersions.map((v) => ({ version: v.version, prerelease: v.prerelease })));

  // ── Services vs their own latest tag ────────────────────────────────────────
  // With independent release units, each image (assistant/guardian/portal/voice)
  // has its own release line on Docker Hub. A service is "behind" when its
  // version < its OWN latestVersion (resolved per image by the versions server).
  // Falls back to latestImageTag (assistant's latest) then platformVersion only
  // when the per-unit tag is absent (e.g. Docker Hub unreachable) — never
  // compares a unit against a different unit's tag.
  function serviceStatus(version: string, latestVersion?: string | null): UpdateStatus {
    const target = latestVersion ?? latestImageTag ?? platformVersion;
    if (!isSemver(version) || !isSemver(target)) return 'unknown';
    return compareVersions(version, target) < 0 ? 'update' : 'current';
  }
  const serviceRows = $derived(
    services.map((s) => ({ ...s, status: serviceStatus(s.version, s.latestVersion) })),
  );
  // The single stack version-of-record we show against the control plane: the
  // assistant is the platform image, so its tag is the headline stack version.
  const stackVersion = $derived(serviceRows.find((s) => s.id === 'assistant')?.version ?? currentImageTag);
  const servicesBehind = $derived(serviceRows.some((s) => s.status === 'update'));

  // ── Per-unit version pickers (Stack images) ─────────────────────────────────
  // Each present service maps to a deployable unit. The `portal` service id maps
  // to the `portals` release unit (the git-tag prefix); the others match.
  const SERVICE_ID_TO_UNIT: Record<string, string> = {
    assistant: 'assistant',
    guardian: 'guardian',
    portal: 'portals',
    voice: 'voice',
  };

  // Per-unit selected tag for the version picker. Defaults to 'latest' until the
  // user picks a concrete version. Svelte 5 $state objects are deeply reactive,
  // so mutating a key triggers the derived recompute.
  let selectedUnitTags = $state<Record<string, string>>({});

  function unitSelectedTag(unit: string): string {
    return selectedUnitTags[unit] ?? 'latest';
  }
  function setUnitSelectedTag(unit: string, tag: string): void {
    selectedUnitTags[unit] = tag;
  }

  function unitTagList(serviceId: string): string[] {
    return unitTags[serviceId] ?? [];
  }

  // One row per present service, resolved to its unit + available Docker Hub
  // tags. Derives from serviceRows so each row carries its computed update status.
  const unitRows = $derived(
    serviceRows.map((s) => {
      const unit = SERVICE_ID_TO_UNIT[s.id] ?? s.id;
      return { service: s, unit, tags: unitTagList(s.id) };
    }),
  );

  // App = the desktop (Electron) installer, shipped with each GitHub release.
  // Prefer the app's own update-check result; fall back to the newest release on
  // this channel. Only meaningful when actually running inside the desktop app.
  const appLatest = $derived(electronLatestVersion ?? latestForChannel(electronVersion, releaseCandidates));
  const appStatus = $derived<UpdateStatus>(inElectron ? updateStatus(electronVersion, appLatest) : 'unknown');
  // Use the URL Electron provides (most precise), or fall back to the main
  // releases page. Never construct /tag/vX.Y.Z ourselves — releases now use
  // platform-X.Y.Z tags, so a hand-built v* URL would 404.
  const appDownloadUrl = $derived(electronLatestUrl ?? RELEASES_URL);

  // UI = the @openpalm/ui npm build serving this page; latest = newest on the
  // npm dist-tag channel that matches this build's stability.
  const uiLatest = $derived(latestForChannel(uiVersion, uiCandidates));
  const uiStatus = $derived<UpdateStatus>(updateStatus(uiVersion, uiLatest));

  // #503: one active-channel line for the whole tab. The channel is whatever the
  // CONTROL PLANE (platformVersion) is on — that is what the user opted into. An
  // rc control plane ⇒ prerelease channel, even if the stack image tag is still
  // a stable tag. 'unknown' (moving tag / no data) shows nothing.
  const activeChannel = $derived(channelOf(platformVersion));
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
      : unitInstallLoading !== null
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
      {#if activeChannel !== 'unknown'}
        <p class="channel-indicator">
          You're on the <strong>{activeChannel === 'prerelease' ? 'prerelease' : 'stable'}</strong> channel.
          {#if activeChannel === 'prerelease'}
            Prereleases get new features early and may be less stable.
          {:else}
            You'll only be offered stable releases.
          {/if}
        </p>
      {/if}
    </div>
    <button
      class="btn btn-sm btn-secondary refresh-releases"
      onclick={onRefreshReleases}
      disabled={releasesLoading || uiVersionsLoading}
      aria-busy={releasesLoading || uiVersionsLoading}
      title="Check for newer versions"
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

    <!-- Primary action: reflects reality against the CONTROL PLANE. When any
         service is behind the platform, this is the one-click "update the stack
         to match" action (resolves correctly now that /admin/upgrade passes
         allowPrerelease from the control-plane channel). When everything matches,
         it reads "up to date". -->
    <section class="update-card" aria-labelledby="update-primary-title" class:update-card-ok={!servicesBehind}>
      <div class="update-card-text">
        {#if servicesBehind}
          <h3 id="update-primary-title" class="update-title">
            Your services are on {formatVersionForDisplay(stackVersion) || '—'} — update to {formatVersionForDisplay(latestImageTag ?? platformVersion) || 'the latest version'}
          </h3>
          <p class="update-desc">
            Brings every stack service up to the version of OpenPalm you're running. Your settings
            are backed up first, then your assistant restarts — offline for about a minute. Your data is kept.
          </p>
        {:else}
          <h3 id="update-primary-title" class="update-title">You're up to date</h3>
          <p class="update-desc">
            Every service matches the latest available version ({formatVersionForDisplay(latestImageTag ?? platformVersion) || 'the current version'}).
            An update backs up your settings first, then briefly restarts your assistant.
          </p>
        {/if}
        {#if harnessUpdateAvailable}
          <p class="update-harness-note" role="status">
            A new version of the OpenPalm app is available — this one updates by <strong>re-downloading the app</strong>,
            not in place. {#if inElectron && electronLatestUrl}<a href={electronLatestUrl} target="_blank" rel="noopener noreferrer">Download it</a>.{:else}Download the latest release to update.{/if}
          </p>
        {/if}
      </div>
      <button
        class="btn btn-primary update-go"
        onclick={onUpgradeStack}
        disabled={anyDangerousLoading || !tokenStored}
        aria-busy={upgradeLoading}
      >
        {#if upgradeLoading}
          <Spinner /> Updating…
        {:else if servicesBehind}
          Update now
        {:else}
          Check &amp; update
        {/if}
      </button>
    </section>

    <!-- Current versions, grouped by version line (design §5.2): the control
         plane header, the Services group (each compared to the control plane —
         never a green ✅ when behind), then the App + Admin-interface lines. -->
    <div class="versions-group" aria-labelledby="versions-platform-title">
      <h3 id="versions-platform-title" class="versions-group-title">
        OpenPalm {formatVersionForDisplay(platformVersion) || '—'}
        <span class="versions-group-sub">control plane</span>
      </h3>
    </div>

    <dl class="versions">
      <div class="versions-subhead"><dt>Services</dt><dd></dd></div>
      {#each serviceRows as s (s.id)}
        <div class="versions-row">
          <dt>{s.label}</dt>
          <dd>
            <span class="version-cell">
              <code class="version-value status-{s.status}">{formatVersionForDisplay(s.version) || '—'}</code>
              {#if statusEmoji(s.status)}
                <span class="status-emoji" role="img" aria-label={statusTitle(s.status)} title={statusTitle(s.status)}>{statusEmoji(s.status)}</span>
              {/if}
            </span>
            {#if s.status === 'update'}
              <button
                class="btn btn-sm btn-secondary version-action"
                onclick={onUpgradeStack}
                disabled={anyDangerousLoading || !tokenStored}
                aria-busy={upgradeLoading}
              >
                {#if upgradeLoading}<Spinner /> Updating…{:else}Update to {formatVersionForDisplay(s.latestVersion ?? latestImageTag ?? platformVersion)}{/if}
              </button>
            {/if}
          </dd>
        </div>
      {/each}

      <div class="versions-subhead"><dt>App</dt><dd></dd></div>
      <div class="versions-row">
        <dt>OpenPalm App</dt>
        <dd>
          <span class="version-cell">
            <code class="version-value status-{appStatus}">{formatVersionForDisplay(electronVersion) || '—'}</code>
            {#if statusEmoji(appStatus)}
              <span class="status-emoji" role="img" aria-label={statusTitle(appStatus)} title={statusTitle(appStatus)}>{statusEmoji(appStatus)}</span>
            {/if}
          </span>
          {#if appStatus === 'update'}
            <a class="btn btn-sm btn-secondary version-action" href={appDownloadUrl} target="_blank" rel="noopener noreferrer">
              Download {formatVersionForDisplay(appLatest)}
            </a>
          {/if}
        </dd>
      </div>

      <div class="versions-row">
        <dt>Admin interface</dt>
        <dd>
          <span class="version-cell">
            <code class="version-value status-{uiStatus}">{formatVersionForDisplay(uiVersion) || '—'}</code>
            {#if statusEmoji(uiStatus)}
              <span class="status-emoji" role="img" aria-label={statusTitle(uiStatus)} title={statusTitle(uiStatus)}>{statusEmoji(uiStatus)}</span>
            {/if}
          </span>
          {#if uiStatus === 'update'}
            {#if uiDownloadRestarting}
              <span class="version-action-note" role="status">
                <Spinner /> Admin interface updated — reconnecting…
              </span>
            {:else if uiDownloadReady}
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
                {#if uiDownloadLoading}<Spinner /> Downloading…{:else}Download {formatVersionForDisplay(uiLatest)}{/if}
              </button>
            {/if}
          {/if}
        </dd>
      </div>
    </dl>

    <!-- Stack images: pin a specific version per unit (rollback / troubleshooting).
         Each deployable unit has its own independent release line, so the picker
         is one row per unit — pinning one image never moves the others. -->
    <section class="version-pin-section" aria-labelledby="stack-pin-title">
      <div class="version-pin-header">
        <h3 id="stack-pin-title" class="version-pin-title">Stack images</h3>
        <p class="version-pin-subtitle">
          Install a specific version per unit — roll a single image back to a known-good release or pin it to a tested build.
          Each unit is released independently.
        </p>
      </div>

      {#each unitRows as row (row.unit)}
        <div class="version-section version-unit-row">
          <div class="version-unit-head">
            <label class="version-label" for="unit-version-select-{row.unit}">{row.service.label}</label>
            <span class="version-cell">
              <code class="version-value status-{row.service.status}">{formatVersionForDisplay(row.service.version) || '—'}</code>
              {#if statusEmoji(row.service.status)}
                <span class="status-emoji" role="img" aria-label={statusTitle(row.service.status)} title={statusTitle(row.service.status)}>{statusEmoji(row.service.status)}</span>
              {/if}
            </span>
          </div>
          <div class="version-input-row">
            {#if releasesLoading}
              <div class="version-select-skeleton"></div>
            {:else if row.tags.length > 0}
              <select
                id="unit-version-select-{row.unit}"
                class="version-select"
                aria-label="{row.service.label} version to install"
                value={unitSelectedTag(row.unit)}
                onchange={(e) => setUnitSelectedTag(row.unit, (e.currentTarget as HTMLSelectElement).value)}
                disabled={unitInstallLoading !== null || anyDangerousLoading}
              >
                <option value="latest">latest</option>
                {#each row.tags as tag (tag)}
                  <option value={tag}>{tag}</option>
                {/each}
              </select>
            {:else}
              <input
                id="unit-version-select-{row.unit}"
                class="version-input"
                type="text"
                aria-label="{row.service.label} version to install"
                placeholder="e.g. 0.12.5 or latest"
                value={unitSelectedTag(row.unit)}
                oninput={(e) => setUnitSelectedTag(row.unit, (e.currentTarget as HTMLInputElement).value)}
                disabled={unitInstallLoading !== null || anyDangerousLoading}
              />
            {/if}
            <button
              class="btn btn-sm btn-secondary"
              onclick={() => { const t = unitSelectedTag(row.unit).trim(); if (t) onSetUnitImageTag(row.unit, t); }}
              disabled={!unitSelectedTag(row.unit).trim() || unitInstallLoading !== null || anyDangerousLoading}
              aria-busy={unitInstallLoading === row.unit}
            >
              {#if unitInstallLoading === row.unit}
                <Spinner /> Installing…
              {:else}
                Install &amp; restart
              {/if}
            </button>
          </div>
          <p class="version-hint">Pins the {row.service.label.toLowerCase()} image and restarts services (about a minute offline).</p>

          {#if unitDowngradePrompt && unitDowngradePrompt.unit === row.unit}
            <div class="downgrade-warning" role="alertdialog" aria-label="Confirm downgrade">
              <p class="downgrade-warning-title">This is a downgrade.</p>
              <p>
                You're moving {row.service.label} from {unitDowngradePrompt.currentVersion} back to {unitDowngradePrompt.targetVersion}.
                Release migrations don't run backward; your data may not be compatible with the older
                version — restore from a backup if needed.
              </p>
              <div class="downgrade-actions">
                <button
                  class="btn btn-sm btn-secondary"
                  onclick={() => onCancelUnitDowngrade?.()}
                  disabled={unitInstallLoading !== null}
                >
                  Cancel
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  onclick={() => onConfirmUnitDowngrade?.()}
                  disabled={unitInstallLoading !== null}
                  aria-busy={unitInstallLoading === row.unit}
                >
                  {#if unitInstallLoading === row.unit}
                    <Spinner /> Downgrading…
                  {:else}
                    Downgrade anyway
                  {/if}
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </section>

    {#if inElectron}
      <!-- Admin interface: install a specific build (Electron only). -->
      <section class="version-pin-section" aria-labelledby="ui-pin-title">
        <div class="version-pin-header">
          <h3 id="ui-pin-title" class="version-pin-title">Admin interface</h3>
          <p class="version-pin-subtitle">
            Install a specific build of the admin interface — useful for testing a pre-release or rolling back after an update.
          </p>
        </div>

        <div class="version-section">
          <label class="version-label" for="ui-version-select">Version</label>
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
          {#if uiDownloadRestarting}
            <div class="version-restart-prompt" role="status">
              <Spinner /> Admin interface updated — reconnecting…
            </div>
          {:else if uiDownloadReady}
            <div class="version-restart-prompt">
              Admin interface updated.
              <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart app</button>
            </div>
          {:else}
            <p class="version-hint">Downloads and replaces the admin interface. Takes effect after restart.</p>
          {/if}
        </div>
      </section>
    {/if}

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
  .panel-subtitle {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: var(--s-sp-1) 0 0;
    max-width: 60ch;
  }

  .channel-indicator {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: var(--s-sp-2) 0 0;
    max-width: 60ch;
  }
  .channel-indicator strong {
    color: var(--s-ink);
  }

  .refresh-releases {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-shrink: 0;
  }
  .refresh-releases svg {
    flex-shrink: 0;
  }
  @media (max-width: 600px) {
    .refresh-releases {
      margin-top: var(--s-sp-2);
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
    gap: var(--s-sp-4);
    flex-wrap: wrap;
    padding: var(--s-sp-4);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper-deep);
  }
  .update-card-text {
    flex: 1;
    min-width: 14rem;
  }
  .update-title {
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    color: var(--s-ink);
    margin: 0;
  }
  .update-desc {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: var(--s-sp-1) 0 0;
    line-height: 1.5;
    max-width: 60ch;
  }
  .update-go {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .update-card-ok {
    border-color: var(--s-moss);
  }
  .update-harness-note {
    margin: var(--s-sp-2) 0 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    line-height: 1.5;
    max-width: 60ch;
  }
  .update-harness-note strong { color: var(--s-ink); }

  /* ── Current versions ── */
  .versions-group {
    margin: var(--s-sp-5) 0 0;
  }
  .versions-group-title {
    margin: 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    color: var(--s-ink);
    display: flex;
    align-items: baseline;
    gap: var(--s-sp-2);
    flex-wrap: wrap;
  }
  .versions-group-sub {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
    text-transform: uppercase;
  }

  .versions {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
    margin: var(--s-sp-3) 0 0;
  }

  /* Group label inside the version list (Services / App). */
  .versions-subhead dt {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-top: var(--s-sp-2);
  }
  .versions-subhead {
    display: flex;
    justify-content: space-between;
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
  .versions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    padding: var(--s-sp-2) 0;
  }
  .versions-row:hover {
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
  }
  .versions-row dt {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .versions-row dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .version-cell {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  .version-value {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    padding: 2px 8px;
    border-radius: 2px;
    border: var(--s-hair) solid var(--s-line);
    color: var(--s-ink-2);
  }
  /* Up to date — moss border. */
  .version-value.status-current {
    border-color: var(--s-moss);
    color: var(--s-moss);
  }
  /* Update available — seal border. */
  .version-value.status-update {
    border-color: var(--s-seal);
    color: var(--s-seal);
  }
  /* Unknown — neutral. */
  .version-value.status-unknown {
    border-color: var(--s-line);
    color: var(--s-ink-3);
  }

  .status-emoji {
    font-size: var(--s-type-deed);
    line-height: 1;
  }

  .version-action {
    flex-shrink: 0;
  }
  .version-action-note {
    display: inline-flex;
    align-items: center;
    gap: var(--s-sp-2);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    color: var(--s-ink-3);
  }

  /* ── Version pin sections (stack images / admin interface) ── */
  .version-pin-section {
    margin-top: var(--s-sp-5);
    border-top: var(--s-hair) solid var(--s-line);
    padding-top: var(--s-sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-3);
  }
  .version-pin-header {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
  }
  .version-pin-title {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }
  .version-pin-subtitle {
    margin: 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    max-width: 60ch;
    line-height: 1.5;
  }

  .downgrade-warning {
    margin-top: var(--s-sp-2);
    padding: var(--s-sp-3);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
  }
  .downgrade-warning-title {
    margin: 0 0 var(--s-sp-1) 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
  }
  .downgrade-warning p {
    margin: 0 0 var(--s-sp-2) 0;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }
  .downgrade-actions {
    display: flex;
    gap: var(--s-sp-2);
  }

  .version-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-2);
  }

  /* Per-unit row: label + current version on one line, picker below. */
  .version-unit-row {
    gap: var(--s-sp-3);
    padding: var(--s-sp-3) 0;
    border-bottom: var(--s-hair) solid var(--s-line-soft);
  }
  .version-unit-row:last-child {
    border-bottom: none;
  }
  .version-unit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    flex-wrap: wrap;
  }

  .version-label {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
  }

  .version-input-row {
    display: flex;
    gap: var(--s-sp-2);
    align-items: center;
    flex-wrap: wrap;
  }

  .version-input {
    flex: 1;
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

  .version-divider {
    height: 1px;
    background: var(--s-line);
    margin: var(--s-sp-3) 0;
  }

  .version-restart-prompt {
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-moss);
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-moss);
    border-radius: 2px;
  }

  .version-select {
    flex: 1;
    min-width: 0;
    padding: var(--s-sp-2) var(--s-sp-3);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
  }

  .version-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .version-select-skeleton {
    flex: 1;
    height: 34px;
    border-radius: 2px;
    background: linear-gradient(
      90deg,
      var(--s-paper-deep) 25%,
      color-mix(in srgb, var(--s-ink) 5%, var(--s-paper)) 50%,
      var(--s-paper-deep) 75%
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
</style>
