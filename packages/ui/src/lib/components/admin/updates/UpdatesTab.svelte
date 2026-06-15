<script lang="ts">
  import { onMount } from 'svelte';
  import type { ReleaseEntry, UiVersionEntry, BackupSummaryView, StackServiceVersion } from '$lib/api.js';
  import {
    fetchBackups,
    pruneBackups,
    fetchSecretStripNotice,
    dismissSecretStripNotice as apiDismissSecretStripNotice,
    fetchInstallLockStatus,
    clearInstallLock,
    type InstallLockStatusView,
  } from '$lib/api.js';
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
     *  ollama as applicable) + the tag it actually runs. Each is compared
     *  against the control plane (platformVersion) to decide "behind". */
    services?: StackServiceVersion[];
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
    releasesLoading: boolean;
    /** Running control-plane version (PLATFORM_VERSION). The dropdown is already
     *  filtered to tags ≤ this server-side (#492); used to label "you are on X"
     *  and to keep the version picker from offering an unreachable newer tag. */
    platformVersion?: string;
    /** #497: preview the release migrations the selected tag would run. */
    migratePreviewLoading?: boolean;
    migratePreview?: { targetVersion: string; applied: string[]; lines: string[]; notes: string[] } | null;
    /** #501: set when the selected tag is a downgrade and needs confirmation. */
    downgradePrompt?: { tag: string; currentVersion: string; targetVersion: string; message: string } | null;
    onSetImageTag: (tag: string) => void;
    onPreviewMigration?: (tag: string) => void;
    onConfirmDowngrade?: () => void;
    onCancelDowngrade?: () => void;
    onSelectedImageTagChange: (tag: string) => void;
    onUpgradeStack: () => void;
    onSelectedUiTagChange: (tag: string) => void;
    onDownloadUiVersion: (tag: string) => void;
    onRestartApp: () => void;
    onRefreshReleases: () => void;
  }

  let {
    currentImageTag,
    services = [],
    selectedImageTag,
    tagChangeLoading,
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
    releasesLoading,
    platformVersion = '',
    migratePreviewLoading = false,
    migratePreview = null,
    downgradePrompt = null,
    onSetImageTag,
    onPreviewMigration,
    onConfirmDowngrade,
    onCancelDowngrade,
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

  // ── Services vs the control plane ──────────────────────────────────────────
  // The control plane (platformVersion) is the version of OpenPalm the user
  // opted into; the stack services follow it. A service is "behind" when its
  // version < platformVersion (compared as semver). We NEVER show a green ✅ for
  // a service that's behind the platform — that was the misleading bug.
  function serviceStatus(version: string): UpdateStatus {
    if (!isSemver(version) || !isSemver(platformVersion)) return 'unknown';
    return compareVersions(version, platformVersion) < 0 ? 'update' : 'current';
  }
  const serviceRows = $derived(
    services.map((s) => ({ ...s, status: serviceStatus(s.version) })),
  );
  // The single stack version-of-record we show against the control plane: the
  // assistant is the platform image, so its tag is the headline stack version.
  const stackVersion = $derived(serviceRows.find((s) => s.id === 'assistant')?.version ?? currentImageTag);
  const servicesBehind = $derived(serviceRows.some((s) => s.status === 'update'));

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

  // #499 backup visibility (self-contained — fetched on mount).
  let backups = $state<BackupSummaryView | null>(null);
  let backupsLoading = $state(false);
  let backupsError = $state('');
  let prunePromptKeep = $state<number | null>(null);
  let pruning = $state(false);

  // #502 one-time secret-strip notice.
  let secretNotice = $state<{ keys: string[]; at: string } | null>(null);

  // #500 stuck-operation recovery — only shown when a STALE lock is detected.
  let installLock = $state<InstallLockStatusView | null>(null);
  let unlocking = $state(false);
  let unlockError = $state('');
  let unlockCleared = $state(false);

  onMount(() => {
    notificationsEnabled = desktopNotifyEnabled();
    replyPreviewEnabled = desktopReplyPreviewEnabled();
    void hydrateLaunchOnLogin();
    void loadBackups();
    void loadSecretNotice();
    void loadInstallLock();
  });

  async function loadInstallLock(): Promise<void> {
    try {
      installLock = await fetchInstallLockStatus();
    } catch {
      installLock = null;
    }
  }

  async function onClearLock(): Promise<void> {
    unlocking = true;
    unlockError = '';
    try {
      const res = await clearInstallLock();
      unlockCleared = res.removed;
      await loadInstallLock();
    } catch (e) {
      // 409 (live lock) surfaces the server's plain-language message here.
      unlockError = e instanceof Error ? e.message : String(e);
      await loadInstallLock();
    } finally {
      unlocking = false;
    }
  }

  async function loadBackups(): Promise<void> {
    backupsLoading = true;
    backupsError = '';
    try {
      backups = await fetchBackups();
    } catch (e) {
      backupsError = e instanceof Error ? e.message : String(e);
    } finally {
      backupsLoading = false;
    }
  }

  async function loadSecretNotice(): Promise<void> {
    try {
      const res = await fetchSecretStripNotice();
      secretNotice = res.notice;
    } catch {
      secretNotice = null;
    }
  }

  async function onDismissSecretNotice(): Promise<void> {
    secretNotice = null;
    try {
      await apiDismissSecretStripNotice();
    } catch {
      /* best-effort; UI already hidden */
    }
  }

  // Prune keeps the newest N; the modal IS the confirmation gate (#499 never
  // auto-prunes). We default the prompt to keep all-but-the-oldest so a single
  // confirm removes exactly one, and the user can lower it deliberately.
  function openPrunePrompt(): void {
    prunePromptKeep = backups && backups.count > 1 ? backups.count - 1 : 0;
  }
  function cancelPrune(): void {
    prunePromptKeep = null;
  }
  async function confirmPrune(): Promise<void> {
    if (prunePromptKeep === null) return;
    pruning = true;
    try {
      await pruneBackups(prunePromptKeep);
      prunePromptKeep = null;
      await loadBackups();
    } catch (e) {
      backupsError = e instanceof Error ? e.message : String(e);
    } finally {
      pruning = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

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

  {#if secretNotice}
    <!-- #502: secret-looking keys were removed from stack.env. The strip is
         correct (secrets belong in Connections), but never silent. -->
    <div class="secret-notice" role="status">
      <div class="secret-notice-text">
        <p class="secret-notice-title">Secret-looking values were removed from stack.env</p>
        <p>
          {secretNotice.keys.join(', ')} {secretNotice.keys.length === 1 ? 'was' : 'were'} removed
          because secrets don't belong in stack.env. Re-add {secretNotice.keys.length === 1 ? 'it' : 'them'}
          via the <strong>Connections</strong> tab (or as a secret) so your provider keeps working.
        </p>
      </div>
      <button class="btn btn-sm btn-secondary" onclick={onDismissSecretNotice}>Dismiss</button>
    </div>
  {/if}

  {#if installLock?.present && installLock.stale}
    <!-- #500: a previous install/upgrade left a stale lock (its process is gone
         or it's older than 30 minutes). Offer a one-click clear. The server
         re-validates staleness and refuses to clear a live lock. -->
    <div class="stuck-notice" role="status">
      <div class="stuck-notice-text">
        <p class="stuck-notice-title">An operation seems stuck</p>
        <p>
          A previous install or update didn't finish cleanly and left a lock behind. It would
          clear itself automatically after 30 minutes — or you can clear it now to run another
          update. Nothing else is changed.
        </p>
        {#if unlockError}
          <p class="stuck-notice-error" role="alert">{unlockError}</p>
        {/if}
      </div>
      <button class="btn btn-sm btn-primary" onclick={onClearLock} disabled={unlocking} aria-busy={unlocking}>
        {#if unlocking}<Spinner /> Clearing…{:else}Clear it{/if}
      </button>
    </div>
  {:else if unlockCleared}
    <div class="stuck-notice stuck-notice-ok" role="status">
      <div class="stuck-notice-text">
        <p class="stuck-notice-title">Cleared</p>
        <p>The stuck operation was cleared. You can run an update again.</p>
      </div>
    </div>
  {/if}

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
            Your services are on {formatVersionForDisplay(stackVersion) || '—'} — update to {formatVersionForDisplay(platformVersion) || 'the latest version'}
          </h3>
          <p class="update-desc">
            Brings every stack service up to the version of OpenPalm you're running. Your settings
            are backed up first, then your assistant restarts — offline for about a minute. Your data is kept.
          </p>
        {:else}
          <h3 id="update-primary-title" class="update-title">You're up to date</h3>
          <p class="update-desc">
            Every service matches OpenPalm {formatVersionForDisplay(platformVersion) || 'the current version'}.
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
                {#if upgradeLoading}<Spinner /> Updating…{:else}Update to {formatVersionForDisplay(platformVersion)}{/if}
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

    <!-- #499: backup visibility — the safety net that an update creates. -->
    <section class="backups-section" aria-labelledby="backups-title">
      <div class="backups-header">
        <h3 id="backups-title" class="backups-title">Backups</h3>
        {#if backups && backups.count > 0}
          <button
            class="btn btn-sm btn-secondary"
            onclick={openPrunePrompt}
            disabled={pruning || backupsLoading}
          >Prune…</button>
        {/if}
      </div>
      <p class="backups-desc">
        Each update copies your settings here first. To restore one, point OpenPalm at
        the snapshot directory below (or run <code>openpalm rollback</code> for the last update).
        Nothing is ever deleted automatically.
      </p>
      {#if backupsLoading}
        <p class="backups-empty"><Spinner /> Loading backups…</p>
      {:else if backupsError}
        <p class="backups-error" role="alert">Couldn't load backups: {backupsError}</p>
      {:else if !backups || backups.count === 0}
        <p class="backups-empty">No backups yet — one is created the first time you update.</p>
      {:else}
        <p class="backups-summary">
          {backups.count} {backups.count === 1 ? 'backup' : 'backups'} ·
          {formatBytes(backups.totalBytes)} total · last {formatDate(backups.lastBackupAt)}
        </p>
        <ul class="backups-list">
          {#each backups.backups as b (b.path)}
            <li class="backups-item">
              <span class="backups-item-name" title={b.path}>{b.name}</span>
              <span class="backups-item-meta">{formatBytes(b.sizeBytes)} · {formatDate(b.createdAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if prunePromptKeep !== null}
        <div class="prune-prompt" role="alertdialog" aria-label="Confirm prune backups">
          <p class="prune-prompt-title">Delete older backups?</p>
          <p>
            Keep the newest
            <input
              class="prune-keep-input"
              type="number"
              min="0"
              max={backups?.count ?? 0}
              bind:value={prunePromptKeep}
              aria-label="Number of newest backups to keep"
            />
            and permanently delete the rest. This cannot be undone.
          </p>
          <div class="prune-actions">
            <button class="btn btn-sm btn-danger" onclick={confirmPrune} disabled={pruning}>
              {#if pruning}<Spinner /> Deleting…{:else}Delete older backups{/if}
            </button>
            <button class="btn btn-sm btn-secondary" onclick={cancelPrune} disabled={pruning}>Cancel</button>
          </div>
        </div>
      {/if}
    </section>

    <!-- Advanced: pin a specific version (rollback / troubleshooting). -->
    <details class="advanced">
      <summary>Advanced options</summary>
      <div class="advanced-body">

        <div class="version-section">
          <label class="version-label" for="stack-version-select">Install a specific version</label>
          <p class="version-running-note">
            Install an exact version — e.g. to roll back, or to pin to a specific tested release.
            The list shows versions up to your current control plane
            {#if platformVersion}(OpenPalm {formatVersionForDisplay(platformVersion)}){/if}.
          </p>
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
              class="btn btn-sm btn-secondary version-preview-btn"
              onclick={() => { if (selectedImageTag.trim()) onPreviewMigration?.(selectedImageTag.trim()); }}
              disabled={!selectedImageTag.trim() || migratePreviewLoading || tagChangeLoading || anyDangerousLoading}
              aria-busy={migratePreviewLoading}
            >
              {#if migratePreviewLoading}
                <Spinner /> Checking…
              {:else}
                Preview changes
              {/if}
            </button>
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
          <p class="version-hint">Explicit version control: installs the chosen version and restarts services (about a minute offline). Use this to roll back or pin a release.</p>

          {#if migratePreview}
            <div class="migrate-preview" role="status">
              <p class="migrate-preview-title">
                What an update to {migratePreview.targetVersion} would change to your files:
              </p>
              {#if migratePreview.applied.length === 0}
                <p class="migrate-preview-empty">Nothing — your files are already compatible. Only the images and version are updated.</p>
              {:else}
                <ul class="migrate-preview-list">
                  {#each migratePreview.lines as line, i (i)}
                    <li>{line}</li>
                  {/each}
                </ul>
                <p class="version-hint">These are copy-only, backup-first changes. Nothing is deleted. Your settings are backed up before anything is written.</p>
              {/if}
              {#each migratePreview.notes as note, i (i)}
                <p class="migrate-preview-note">Note: {note}</p>
              {/each}
            </div>
          {/if}

          {#if downgradePrompt}
            <div class="downgrade-warning" role="alertdialog" aria-label="Confirm downgrade">
              <p class="downgrade-warning-title">This is a downgrade.</p>
              <p>
                You're moving from {downgradePrompt.currentVersion} back to {downgradePrompt.targetVersion}.
                Release migrations don't run backward; your data may not be compatible with the older
                version — restore from a backup if needed.
              </p>
              <div class="downgrade-actions">
                <button
                  class="btn btn-sm btn-secondary"
                  onclick={() => onCancelDowngrade?.()}
                  disabled={tagChangeLoading}
                >
                  Cancel
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  onclick={() => onConfirmDowngrade?.()}
                  disabled={tagChangeLoading}
                  aria-busy={tagChangeLoading}
                >
                  {#if tagChangeLoading}
                    <Spinner /> Downgrading…
                  {:else}
                    Downgrade anyway
                  {/if}
                </button>
              </div>
            </div>
          {/if}
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

  .channel-indicator {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: var(--space-2) 0 0;
    max-width: 60ch;
  }
  .channel-indicator strong {
    color: var(--color-text);
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

  /* When everything matches the control plane the primary card is a calm
     "up to date" state rather than an action prompt. */
  .update-card-ok {
    background: var(--color-success-bg, var(--color-bg-secondary));
    border-color: var(--color-success, var(--color-border));
  }
  .update-harness-note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.5;
    max-width: 60ch;
  }
  .update-harness-note strong { color: var(--color-text); }

  /* ── Current versions ── */
  .versions-group {
    margin: var(--space-5) 0 0;
  }
  .versions-group-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .versions-group-sub {
    font-size: var(--text-xs);
    font-weight: var(--font-normal, 400);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .versions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
  }

  /* Group label inside the version list (Services / App). */
  .versions-subhead dt {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
    margin-top: var(--space-2);
  }
  .versions-subhead {
    display: flex;
    justify-content: space-between;
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
    margin-bottom: var(--space-2);
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

  .migrate-preview {
    margin-top: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2, var(--color-surface));
  }
  .migrate-preview-title {
    margin: 0 0 var(--space-2) 0;
    font-weight: var(--font-medium);
    color: var(--color-text);
  }
  .migrate-preview-empty {
    margin: 0;
    color: var(--color-text-secondary);
  }
  .migrate-preview-list {
    margin: 0 0 var(--space-2) 0;
    padding-left: var(--space-4);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .migrate-preview-note {
    margin: var(--space-1) 0 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .downgrade-warning {
    margin-top: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--color-danger, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-danger-bg, var(--color-surface));
  }
  .downgrade-warning-title {
    margin: 0 0 var(--space-1) 0;
    font-weight: var(--font-semibold, var(--font-medium));
    color: var(--color-danger-text, var(--color-text));
  }
  .downgrade-warning p {
    margin: 0 0 var(--space-2) 0;
    color: var(--color-text);
  }
  .downgrade-actions {
    display: flex;
    gap: var(--space-2);
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

  /* #502 secret-strip notice */
  .secret-notice {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 var(--space-4) var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-warning, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-warning-bg, var(--color-surface));
  }
  .secret-notice-text { min-width: 0; }
  .secret-notice-title {
    margin: 0 0 var(--space-1) 0;
    font-weight: var(--font-semibold, var(--font-medium));
    color: var(--color-warning-text, var(--color-text));
  }
  .secret-notice p { margin: 0; color: var(--color-text); font-size: var(--text-sm); }

  /* #500 stuck-operation recovery */
  .stuck-notice {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0 var(--space-4) var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-warning, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-warning-bg, var(--color-surface));
  }
  .stuck-notice-ok {
    border-color: var(--color-success, var(--color-border));
    background: var(--color-success-bg, var(--color-surface));
  }
  .stuck-notice-text { min-width: 0; }
  .stuck-notice-title {
    margin: 0 0 var(--space-1) 0;
    font-weight: var(--font-semibold, var(--font-medium));
    color: var(--color-warning-text, var(--color-text));
  }
  .stuck-notice-ok .stuck-notice-title { color: var(--color-success-text, var(--color-text)); }
  .stuck-notice p { margin: 0; color: var(--color-text); font-size: var(--text-sm); }
  .stuck-notice-error { margin-top: var(--space-1) !important; color: var(--color-danger-text, var(--color-text)); }

  /* #499 backups */
  .backups-section {
    margin-top: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  .backups-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .backups-title { margin: 0; font-size: var(--text-base); }
  .backups-desc {
    margin: var(--space-1) 0 var(--space-2) 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .backups-summary {
    margin: 0 0 var(--space-2) 0;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }
  .backups-empty, .backups-error {
    margin: var(--space-1) 0 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .backups-error { color: var(--color-danger-text, var(--color-text)); }
  .backups-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .backups-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  .backups-item-name {
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .backups-item-meta { color: var(--color-text-secondary); white-space: nowrap; }

  .prune-prompt {
    margin-top: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-danger, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-danger-bg, var(--color-surface));
  }
  .prune-prompt-title {
    margin: 0 0 var(--space-1) 0;
    font-weight: var(--font-semibold, var(--font-medium));
    color: var(--color-danger-text, var(--color-text));
  }
  .prune-prompt p { margin: 0 0 var(--space-2) 0; color: var(--color-text); font-size: var(--text-sm); }
  .prune-keep-input {
    width: 4rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, var(--radius-md));
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }
  .prune-actions { display: flex; gap: var(--space-2); }
</style>
