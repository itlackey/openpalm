<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { version as uiVersion } from '$app/environment';
  import { goto } from '$app/navigation';
  import { formatTime } from '$lib/format-date.js';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import TabBar, { type TabId } from '$lib/components/chrome/TabBar.svelte';
  import OverviewTab from '$lib/components/admin/overview/OverviewTab.svelte';
  import UpdatesTab from '$lib/components/admin/updates/UpdatesTab.svelte';
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
    setStackVersion,
    downloadUiVersion,
    type ReleaseEntry,
    type UiVersionEntry,
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse, ServiceEntry } from '$lib/types.js';

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
  let inElectron = $state(false);
  let electronVersion = $state<string | null>(null);
  let electronLatestVersion = $state<string | null>(null);
  let electronLatestUrl = $state<string | null>(null);
  let tagChangeLoading = $state(false);
  let uiDownloadLoading = $state(false);
  let uiDownloadReady = $state(false);
  let uiDownloadRestarting = $state(false);
  let selectedImageTag = $state('latest');
  let selectedUiTag = $state('');
  let releases = $state<ReleaseEntry[]>([]);
  let releasesLoading = $state(false);
  // Running control-plane version (PLATFORM_VERSION) reported by the releases
  // endpoint. The stack-version dropdown is already filtered to tags ≤ this
  // server-side (#492); the label tells the user which version they're on.
  let platformVersion = $state('');
  // @openpalm/ui npm versions — the UI is independently versioned, so its
  // installable builds come from npm, not GitHub platform releases.
  let uiVersions = $state<UiVersionEntry[]>([]);
  let uiVersionsLoading = $state(false);

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
      inElectron = data.inElectron;
      electronVersion = data.electronVersion;
      electronLatestVersion = data.electronLatestVersion;
      electronLatestUrl = data.electronLatestUrl;
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
      if (releaseData.platformVersion) platformVersion = releaseData.platformVersion;
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

  async function handleSetImageTag(tag: string): Promise<void> {
    if (tagChangeLoading) return;
    tagChangeLoading = true;
    try {
      const result = await setStackVersion(tag);
      currentImageTag = result.imageTag;
      selectedImageTag = result.imageTag;
      operationResult = `Image tag set to ${result.imageTag}. Restarted: ${result.restarted.join(', ') || 'none'}.`;
      operationResultType = 'success';
    } catch (e) {
      const err = e as { message?: string };
      operationResult = `Failed to apply image tag: ${err.message ?? e}`;
      operationResultType = 'error';
    }
    tagChangeLoading = false;
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
        {selectedImageTag}
        {tagChangeLoading}
        {anyDangerousLoading}
        tokenStored={true}
        {upgradeLoading}
        {inElectron}
        {electronVersion}
        {electronLatestVersion}
        {electronLatestUrl}
        {uiVersion}
        {uiVersions}
        {uiVersionsLoading}
        {selectedUiTag}
        {uiDownloadLoading}
        {uiDownloadReady}
        {uiDownloadRestarting}
        {releases}
        {releasesLoading}
        {platformVersion}
        onSetImageTag={handleSetImageTag}
        onSelectedImageTagChange={(t) => { selectedImageTag = t; }}
        onUpgradeStack={handleUpgradeStack}
        onSelectedUiTagChange={(t) => { selectedUiTag = t; }}
        onDownloadUiVersion={handleDownloadUiVersion}
        onRestartApp={handleRestartApp}
        onRefreshReleases={loadReleases}
      />
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
      />
    {/if}
  </main>

<style>
  /* Full-width admin: the content spans the viewport so the tab bar (rendered
     above, outside this container) reads edge-to-edge and flush under the
     navbar. Horizontal padding keeps panels off the screen edges. */
  main {
    padding: var(--space-6) var(--space-6) var(--space-12);
  }

  @media (max-width: 768px) {
    main {
      padding: var(--space-4) var(--space-4) var(--space-8);
    }
  }


</style>
