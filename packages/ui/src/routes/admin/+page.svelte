<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { version as uiVersion } from '$app/environment';
  import { goto } from '$app/navigation';
  import { formatTime } from '$lib/format-date.js';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import TabBar, { type TabId } from '$lib/components/chrome/TabBar.svelte';
  import OverviewTab from '$lib/components/admin/overview/OverviewTab.svelte';
  import UpdatesTab from '$lib/components/admin/updates/UpdatesTab.svelte';
  import RecoveryTab from '$lib/components/admin/updates/RecoveryTab.svelte';
  import AddonsTab from '$lib/components/addons/AddonsTab.svelte';
  import ContainersTab from '$lib/components/admin/containers/ContainersTab.svelte';
  import AutomationsTab from '$lib/components/admin/automations/AutomationsTab.svelte';
  import ProvidersPanel from '$lib/components/providers/ProvidersPanel.svelte';
  import LogsTab from '$lib/components/admin/logs/LogsTab.svelte';
  import SecretsTab from '$lib/components/admin/secrets/SecretsTab.svelte';
  import AssistantTab from '$lib/components/admin/assistant/AssistantTab.svelte';
  import ActivityTab from '$lib/components/admin/activity/ActivityTab.svelte';
  import AkmTab from '$lib/components/akm/AkmTab.svelte';
  import HostSharingSection from '$lib/components/akm/HostSharingSection.svelte';
  import VoiceTab from '$lib/components/voice/VoiceTab.svelte';

  import {
    fetchHealth,
    fetchContainers,
    fetchAutomations,
    applyChanges,
    upgradeStack,
    containerAction,
    pullImages,
    fetchVersions,
    fetchReleases,
    fetchUiVersions,
    invalidateVersionCache,
    setUnitImageTag,
    downloadUiVersion,
    DowngradeConfirmationRequiredError,
    type ReleaseEntry,
    type UiVersionEntry,
    type StackServiceVersion,
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse, ServiceEntry } from '$lib/types.js';
  import { compareVersions, isSemver } from '$lib/version-compare.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders for
  // an authenticated admin. A session that expires mid-operation surfaces as a
  // 401 on an in-page API call, handled by redirecting to /login.

  // ── Health & service state ──────────────────────────────────────────────────
  let adminHealth = $state<HealthPayload | null>(null);
  let guardianHealth = $state<HealthPayload | null>(null);

  // ── Loading flags ───────────────────────────────────────────────────────────
  let healthLoading = $state(false);
  let applyLoading = $state(false);
  let upgradeLoading = $state(false);
  let containersLoading = $state(false);
  let automationsLoading = $state(false);

  // ── Content state ───────────────────────────────────────────────────────────
  let operationResult = $state('');
  let operationResultType: 'success' | 'error' | 'info' = $state('info');
  let containerData: ContainerListResponse | null = $state(null);
  let containerError = $state('');
  let containersLastUpdated: string | null = $state(null);
  let automationsData: AutomationsResponse | null = $state(null);
  let automationsError = $state('');
  let selectedContainerId: string | null = $state(null);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let activeTab: TabId = $state('overview');
  let pullLoading = $state(false);

  // ── Version management ──────────────────────────────────────────────────────
  let currentImageTag = $state('');
  // Every configured stack piece (assistant, guardian, chat portal, voice,
  // ollama as applicable) + the tag it actually runs. Each carries its own
  // best-effort latest tag (latestVersion) from Docker Hub so the update banner
  // and the Check-up rows compare per-unit, not against a single shared tag.
  let services = $state<StackServiceVersion[]>([]);
  let inElectron = $state(false);
  let electronVersion = $state<string | null>(null);
  let electronLatestVersion = $state<string | null>(null);
  let electronLatestUrl = $state<string | null>(null);
  // Native harness re-download gate (independent of the self-updating control
  // plane): true ⇒ the app itself must be re-downloaded.
  let harnessUpdateAvailable = $state(false);
  // Per-unit image pin: the unit currently being installed (null when idle).
  // Any unit install disables the others so two pins can't race on stack.env.
  let unitInstallLoading = $state<string | null>(null);
  // #501 per-unit downgrade confirmation: set when the server returns 409 for a
  // unit pin; the UI shows a plain warning + confirm, then re-applies with
  // confirmDowngrade.
  let unitDowngradePrompt = $state<{ unit: string; tag: string; currentVersion: string; targetVersion: string; message: string } | null>(null);
  let uiDownloadLoading = $state(false);
  let uiDownloadReady = $state(false);
  let uiDownloadRestarting = $state(false);
  let selectedUiTag = $state('');
  let releases = $state<ReleaseEntry[]>([]);
  // Per-unit available Docker Hub tags for the per-unit version pickers
  // (assistant/guardian/portals/voice). Bare semver, v-prefixed as Docker Hub
  // returns them; the UI strips the v for display. Docker Hub is the
  // authoritative source for deployable tags — not GitHub releases.
  let unitTags = $state<Record<string, string[]>>({});
  let releasesLoading = $state(false);
  // Running control-plane version (PLATFORM_VERSION) — for display only.
  let platformVersion = $state('');
  // Latest @openpalm/lib on npm — the "is the platform itself up to date?" signal.
  let platformLatest = $state<string | null>(null);
  // Latest assistant Docker image tag on Docker Hub (null = check failed / not
  // yet loaded). Backward-compat signal; the authoritative per-unit signal is
  // services[].latestVersion.
  let latestImageTag = $state<string | null>(null);
  // @openpalm/ui npm versions — the UI is independently versioned, so its
  // installable builds come from npm, not GitHub platform releases.
  let uiVersions = $state<UiVersionEntry[]>([]);
  let uiVersionsLoading = $state(false);

  // An update is available when any running service image is behind ITS OWN
  // latest published tag on Docker Hub. With independently versioned units,
  // each image (assistant/guardian/portal/voice) has its own release line —
  // comparing all of them against a single tag (the assistant's) forced a
  // perpetual "update available" banner when stale unified-era tags lingered on
  // Docker Hub. Docker Hub is the authoritative source per unit, not the
  // control-plane (PLATFORM_VERSION), which only tracks the platform npm line.
  const updateAvailable = $derived(
    services.some((s) =>
      isSemver(s.version) && isSemver(s.latestVersion ?? null) &&
      compareVersions(s.version, s.latestVersion!) < 0,
    ),
  );

  // ── Container polling ──────────────────────────────────────────────────────
  const POLL_INTERVAL_MS = 10_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startContainerPolling(): void {
    stopContainerPolling();
    pollTimer = setInterval(() => {
      // Only poll once data has been loaded at least once
      if (containerData) {
        void loadContainers();
      }
    }, POLL_INTERVAL_MS);
  }

  function stopContainerPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  onDestroy(() => {
    stopContainerPolling();
  });

  // ── Derived ─────────────────────────────────────────────────────────────────
  let anyDangerousLoading = $derived(applyLoading || upgradeLoading);

  /** Merged service → state map (used by OverviewTab for health indicators) */
  let mergedServices = $derived.by((): Map<string, string> => {
    if (!containerData) return new Map<string, string>();
    const merged = new Map<string, string>();
    if (containerData.containers) {
      for (const [name, state] of Object.entries(containerData.containers)) {
        merged.set(name, state);
      }
    }
    if (containerData.dockerContainers) {
      for (const c of containerData.dockerContainers) {
        merged.set(c.Service, c.State);
      }
    }
    return merged;
  });

  /** Full merged ServiceEntry list (used by ContainersTab for detail rows) */
  let serviceEntries = $derived.by((): ServiceEntry[] => {
    if (!containerData) return [];
    const byService = new Map<string, ServiceEntry>();
    if (containerData.containers) {
      for (const [name, state] of Object.entries(containerData.containers)) {
        byService.set(name, { id: name, service: name, state, docker: null });
      }
    }
    if (containerData.dockerContainers) {
      for (const c of containerData.dockerContainers) {
        const existing = byService.get(c.Service);
        if (existing) {
          existing.state = c.State;
          existing.docker = c;
          existing.id = c.ID;
        } else {
          byService.set(c.Service, {
            id: c.ID,
            service: c.Service || c.Name,
            state: c.State,
            docker: c
          });
        }
      }
    }
    return [...byService.values()].sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return a.service.localeCompare(b.service);
    });
  });

  // ── Auth helpers ─────────────────────────────────────────────────────────────

  // Called when an in-page API request returns 401 (session expired/invalid
  // mid-session). Server-side gating handles page navigations; here we bounce to
  // the login route and return to /admin after re-authenticating.
  function applyInvalidTokenState(): void {
    void goto('/login?redirectTo=' + encodeURIComponent('/admin'));
  }

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadHealth(): Promise<void> {
    healthLoading = true;
    try {
      const health = await fetchHealth();
      adminHealth = health.admin;
      guardianHealth = health.guardian;
    } catch (e) {
      console.warn('[page] Health check failed:', e);
      adminHealth = { status: 'error', service: 'admin' };
      guardianHealth = { status: 'error', service: 'guardian' };
    }
    healthLoading = false;
  }

  async function loadContainers(): Promise<void> {
    containersLoading = true;
    containerError = '';
    try {
      containerData = await fetchContainers();
    } catch (e) {
      containerData = null;
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        containerError = 'Invalid password.';
        applyInvalidTokenState();
      } else {
        containerError = `Failed to load containers: ${err.message ?? e}`;
      }
    }
    containersLoading = false;
    if (containerData) {
      containersLastUpdated = formatTime(Date.now());
    }
  }

  async function loadAutomations(): Promise<void> {
    automationsLoading = true;
    automationsError = '';
    try {
      automationsData = await fetchAutomations();
    } catch (e) {
      automationsData = null;
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        automationsError = 'Invalid password.';
        applyInvalidTokenState();
      } else {
        automationsError = `Failed to load automations: ${err.message ?? e}`;
      }
    }
    automationsLoading = false;
  }

  async function loadVersions(): Promise<void> {
    try {
      const data = await fetchVersions();
      currentImageTag = data.imageTag;
      services = data.services;
      inElectron = data.inElectron;
      electronVersion = data.electronVersion;
      electronLatestVersion = data.electronLatestVersion;
      electronLatestUrl = data.electronLatestUrl;
      harnessUpdateAvailable = data.harnessUpdateAvailable;
      // The control plane (PLATFORM_VERSION) is reported here authoritatively —
      // it is the version of OpenPalm actually running and drives the channel +
      // every "behind" check. loadReleases also sets it from the releases probe,
      // but that can fail offline; this is the reliable source.
      platformVersion = data.platformVersion;
      platformLatest = data.platformLatest ?? null;
      latestImageTag = data.latestImageTag ?? null;
      unitTags = data.unitTags ?? {};
      // Do not reset selectedImageTag/selectedUiTag here — loadReleases initializes them
    } catch {
      // Non-fatal — version info is supplementary
    }
  }

  async function loadReleases(): Promise<void> {
    releasesLoading = true;
    uiVersionsLoading = true;
    try {
      const [releaseData, uiData] = await Promise.all([fetchReleases(), fetchUiVersions()]);
      releases = releaseData.releases;
      uiVersions = uiData.versions;
      // Default the UI-build selection to the version on this app's channel
      // (next/latest dist-tag), falling back to the newest published version.
      if (!selectedUiTag) {
        const channelPick = uiData.versions.find((v) => v.distTag === 'next' || v.distTag === 'latest')
          ?? uiData.versions[0];
        if (channelPick) selectedUiTag = channelPick.version;
      }
    } catch {
      // Non-fatal
    }
    releasesLoading = false;
    uiVersionsLoading = false;
  }

  /** "Check for updates" button: invalidate server-side caches, then re-fetch
   *  versions (Docker Hub tags + npm platform latest) + releases (GitHub app
   *  releases) + UI versions (npm @openpalm/ui) in parallel. The invalidate
   *  call runs first so the GETs see a cold cache and hit the upstreams once. */
  async function handleRefreshReleases(): Promise<void> {
    releasesLoading = true;
    uiVersionsLoading = true;
    await invalidateVersionCache();
    await Promise.all([loadVersions(), loadReleases()]);
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleApplyChanges(): Promise<void> {
    if (anyDangerousLoading) return;
    applyLoading = true;
    try {
      const result = await applyChanges();
      if (result.overallSuccess) {
        const summary = result.restarted.length > 0
          ? `Changes applied successfully. Restarted: ${result.restarted.join(', ')}.`
          : 'Changes applied successfully.';
        operationResult = summary;
        operationResultType = 'success';
      } else if (result.failed.length > 0) {
        const failures = result.failed
          .map((f) => `${f.service}: ${f.reason}`)
          .join('; ');
        const restartedNote = result.restarted.length > 0
          ? ` (other services restarted: ${result.restarted.join(', ')})`
          : '';
        operationResult = `Apply failed for ${result.failed.length} service(s): ${failures}${restartedNote}`;
        operationResultType = 'error';
      } else if (!result.dockerAvailable) {
        operationResult = 'Config written, but Docker is unavailable — services were not restarted.';
        operationResultType = 'error';
      } else {
        operationResult = `Apply failed: ${result.error ?? 'unknown error'}`;
        operationResultType = 'error';
      }
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        operationResult = `Error applying changes: ${err.message ?? e}`;
        operationResultType = 'error';
      }
    }
    applyLoading = false;
  }

  async function handleUpgradeStack(): Promise<void> {
    if (anyDangerousLoading) return;
    upgradeLoading = true;
    try {
      const result = await upgradeStack();
      operationResult = `Upgrade complete (image: ${result.imageTag}). ${result.assetsUpdated.length} asset(s) updated, ${result.restarted.length} service(s) restarted.`;
      operationResultType = 'success';
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        operationResult = `Error upgrading stack: ${err.message ?? e}`;
        operationResultType = 'error';
      }
    }
    upgradeLoading = false;
  }

  async function handleSetUnitImageTag(unit: string, tag: string, confirmDowngrade = false): Promise<void> {
    if (unitInstallLoading !== null) return;
    unitInstallLoading = unit;
    try {
      const result = await setUnitImageTag(unit, tag, { confirmDowngrade });
      operationResult = `${unit} image tag set to ${result.imageTag}. Restarted: ${result.restarted.join(', ') || 'none'}.`;
      operationResultType = 'success';
      unitDowngradePrompt = null;
      // Refresh service versions so the rows reflect the newly pinned tag.
      await loadVersions();
    } catch (e) {
      if (e instanceof DowngradeConfirmationRequiredError) {
        // Not an error — show the plain warning + confirm, then re-apply.
        unitDowngradePrompt = { unit, tag, currentVersion: e.currentVersion, targetVersion: e.targetVersion, message: e.message };
      } else {
        const err = e as { message?: string };
        operationResult = `Failed to apply ${unit} image tag: ${err.message ?? e}`;
        operationResultType = 'error';
      }
    }
    unitInstallLoading = null;
  }

  function handleConfirmUnitDowngrade(): void {
    if (!unitDowngradePrompt) return;
    void handleSetUnitImageTag(unitDowngradePrompt.unit, unitDowngradePrompt.tag, true);
  }

  function handleCancelUnitDowngrade(): void {
    unitDowngradePrompt = null;
  }

  async function handleDownloadUiVersion(tag: string): Promise<void> {
    if (uiDownloadLoading) return;
    uiDownloadLoading = true;
    uiDownloadReady = false;
    uiDownloadRestarting = false;
    try {
      const result = await downloadUiVersion(tag);
      selectedUiTag = tag;
      uiDownloadReady = true;
      if (result.restarting) {
        // The supervisor (CLI `ui serve` / Electron harness) is respawning the
        // UI server against the new build. It comes back up on the same port —
        // poll /health and reload once it's ready so the user lands on the new UI.
        uiDownloadRestarting = true;
        void waitForUiServerAndReload();
      }
    } catch (e) {
      const err = e as { message?: string };
      operationResult = `Failed to download UI version: ${err.message ?? e}`;
      operationResultType = 'error';
    }
    uiDownloadLoading = false;
  }

  // Poll the UI server's /health while the supervisor restarts it, then reload
  // the page so the freshly downloaded control plane serves it (design §6.2).
  async function waitForUiServerAndReload(): Promise<void> {
    const deadline = Date.now() + 30_000;
    // Give the supervisor a moment to tear the old child down first, so we don't
    // immediately see the still-up old server and reload onto it.
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < deadline) {
      try {
        const res = await fetch('/health', { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 401) {
          window.location.reload();
          return;
        }
      } catch {
        // server is mid-restart; keep polling
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    // Restart took too long — fall back to the manual prompt.
    uiDownloadRestarting = false;
  }

  function handleRestartApp(): void {
    (window as unknown as { openpalm?: { restart?: () => void } }).openpalm?.restart?.();
  }

  async function handleContainerAction(
    action: 'start' | 'stop' | 'restart',
    containerId: string
  ): Promise<void> {
    try {
      await containerAction(action, containerId);
      await loadContainers();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        containerError = `Action failed: ${err.message ?? e}`;
      }
    }
  }

  function handleToggleContainer(id: string): void {
    selectedContainerId = selectedContainerId === id ? null : id;
  }

  /** Derive service names from container data for the logs tab */
  let serviceNames = $derived.by((): string[] => {
    if (!containerData) return [];
    const names = new Set<string>();
    if (containerData.containers) {
      for (const name of Object.keys(containerData.containers)) {
        names.add(name);
      }
    }
    if (containerData.dockerContainers) {
      for (const c of containerData.dockerContainers) {
        if (c.Service) names.add(c.Service);
      }
    }
    return [...names].sort();
  });

  async function handlePullImages(): Promise<void> {
    pullLoading = true;
    try {
      await pullImages();
      await loadContainers();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        containerError = `Pull failed: ${err.message ?? e}`;
      }
    } finally {
      pullLoading = false;
    }
  }

  function handleTabSelect(tab: typeof activeTab): void {
    activeTab = tab;
    if (tab === 'containers' && !containerData) {
      void loadContainers();
    }
    if (tab === 'automations' && !automationsData) {
      void loadAutomations();
    }
  }

  function handleComponentsAuthError(): void {
    applyInvalidTokenState();
  }

  // ── Mount ────────────────────────────────────────────────────────────────────

  onMount(() => {
    startContainerPolling();
    // Auto-hydrate key data so tabs show meaningful state without manual refresh.
    void loadHealth();
    void loadContainers();
    void loadAutomations();
    void loadVersions();
    void loadReleases();
  });
</script>

<svelte:head>
  <title>OpenPalm Console</title>
</svelte:head>

<Navbar />

{#if updateAvailable && activeTab !== 'updates'}
  <!-- #498: persistent, dismissable-by-acting update signal. One sentence, one
       obvious action (go to Check-up). Shown everywhere except the Check-up tab
       itself, where the same status is already front and centre. The text is
       generic because with independent release units any one of them can be
       behind its own latest — naming a single version would be misleading. -->
  <div class="update-banner" role="status">
    <span class="update-banner-text">
      An OpenPalm update is available.
    </span>
    <button class="update-banner-action" onclick={() => handleTabSelect('updates')}>
      Review it
    </button>
  </div>
{/if}

<TabBar active={activeTab} onSelect={handleTabSelect} />

<main>
    {#if activeTab === 'overview'}
      <OverviewTab
        {adminHealth}
        {operationResult}
        {operationResultType}
        tokenStored={true}
        {healthLoading}
        {applyLoading}
        {anyDangerousLoading}
        {automationsData}
        {mergedServices}
        managedServices={containerData?.managedServices ?? []}
        onCheckHealth={loadHealth}
        onApplyChanges={handleApplyChanges}
        onDismissResult={() => { operationResult = ''; operationResultType = 'info'; }}
        onNavigate={handleTabSelect}
      />
    {:else if activeTab === 'updates'}
      <UpdatesTab
        {currentImageTag}
        {services}
        {anyDangerousLoading}
        tokenStored={true}
        {upgradeLoading}
        {inElectron}
        {electronVersion}
        {electronLatestVersion}
        {electronLatestUrl}
        {harnessUpdateAvailable}
        {uiVersion}
        {uiVersions}
        {uiVersionsLoading}
        {selectedUiTag}
        {uiDownloadLoading}
        {uiDownloadReady}
        {uiDownloadRestarting}
        {releases}
        {unitTags}
        {releasesLoading}
        {platformVersion}
        {platformLatest}
        {latestImageTag}
        {unitInstallLoading}
        {unitDowngradePrompt}
        onSetUnitImageTag={(unit, tag) => handleSetUnitImageTag(unit, tag)}
        onConfirmUnitDowngrade={handleConfirmUnitDowngrade}
        onCancelUnitDowngrade={handleCancelUnitDowngrade}
        onUpgradeStack={handleUpgradeStack}
        onSelectedUiTagChange={(t) => { selectedUiTag = t; }}
        onDownloadUiVersion={handleDownloadUiVersion}
        onRestartApp={handleRestartApp}
        onRefreshReleases={handleRefreshReleases}
      />
    {:else if activeTab === 'recovery'}
      <RecoveryTab />
    {:else if activeTab === 'addons'}
      <AddonsTab
        onAuthError={handleComponentsAuthError}
        onNavigate={handleTabSelect}
      />
    {:else if activeTab === 'containers'}
      <ContainersTab
        {containerData}
        {serviceEntries}
        loading={containersLoading}
        error={containerError}
        tokenStored={true}
        {selectedContainerId}
        onToggleContainer={handleToggleContainer}
        onStart={(id) => handleContainerAction('start', id)}
        onStop={(id) => handleContainerAction('stop', id)}
        onRestart={(id) => handleContainerAction('restart', id)}
        onRefresh={loadContainers}
        onPullImages={handlePullImages}
        lastUpdated={containersLastUpdated}
        {pullLoading}
      />
    {:else if activeTab === 'automations'}
      <AutomationsTab
        data={automationsData}
        loading={automationsLoading}
        error={automationsError}
        tokenStored={true}
        onRefresh={loadAutomations}
      />
    {:else if activeTab === 'activity'}
      <ActivityTab />
    {:else if activeTab === 'connections'}
      <ProvidersPanel />
    {:else if activeTab === 'assistant'}
      <AssistantTab tokenStored={true} />
    {:else if activeTab === 'secrets'}
      <SecretsTab tokenStored={true} />
    {/if}
    {#if activeTab === 'voice'}
      <VoiceTab tokenStored={true} />
    {:else if activeTab === 'akm'}
      <AkmTab tokenStored={true} />
    {:else if activeTab === 'host-sharing'}
      <HostSharingSection tokenStored={true} />
    {:else if activeTab === 'logs'}
      <LogsTab
        tokenStored={true}
        services={serviceNames}
        automations={automationsData?.automations.map((automation) => automation.name) ?? []}
      />
    {/if}
  </main>

<style>
  /* Full-width admin: the content spans the viewport so the tab bar (rendered
     above, outside this container) reads edge-to-edge and flush under the
     navbar. Horizontal padding keeps panels off the screen edges. */
  main {
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-display);
    padding: var(--s-sp-6) var(--s-sp-6) var(--s-sp-8);
    min-height: calc(100vh - 52px - 36px);
  }

  @media (max-width: 768px) {
    main {
      padding: var(--s-sp-4) var(--s-sp-4) var(--s-sp-6);
    }
  }

  /* #498 global update banner — a thin, persistent strip under the navbar. */
  .update-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--s-sp-3);
    padding: var(--s-sp-2) var(--s-sp-4);
    background: color-mix(in srgb, var(--s-seal) 8%, var(--s-paper-deep));
    border-bottom: var(--s-hair) solid color-mix(in srgb, var(--s-seal) 30%, transparent);
    color: var(--s-ink);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
  }
  .update-banner-text {
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-2);
  }
  .update-banner-action {
    flex-shrink: 0;
    appearance: none;
    background: transparent;
    border: var(--s-hair) solid var(--s-seal);
    border-radius: var(--s-radius-seal);
    padding: var(--s-sp-1) var(--s-sp-3);
    font-family: var(--s-font-mono);
    font-size: var(--s-type-deed);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-seal);
    cursor: pointer;
  }
  .update-banner-action:hover {
    background: color-mix(in srgb, var(--s-seal) 10%, transparent);
  }
  .update-banner-action:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
</style>
