<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import OverviewTab from '$lib/components/OverviewTab.svelte';
  import AddonsTab from '$lib/components/AddonsTab.svelte';
  import ContainersTab from '$lib/components/ContainersTab.svelte';
  import AutomationsTab from '$lib/components/AutomationsTab.svelte';
  import ProvidersPanel from '$lib/components/ProvidersPanel.svelte';
  import LogsTab from '$lib/components/LogsTab.svelte';
  import SecretsTab from '$lib/components/SecretsTab.svelte';
  import AkmTab from '$lib/components/AkmTab.svelte';
  import VoiceTab from '$lib/components/VoiceTab.svelte';

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
    setStackVersion,
    downloadUiVersion,
    type ReleaseEntry,
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse, ServiceEntry } from '$lib/types.js';

  // ── Auth state ──────────────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // ── Health & service state ──────────────────────────────────────────────────
  let adminHealth = $state<HealthPayload | null>(null);
  let guardianHealth = $state<HealthPayload | null>(null);
  let adminStatus = $state('');

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
  let activeTab: 'overview' | 'addons' | 'automations' | 'connections' | 'secrets' | 'voice' | 'akm' | 'containers' | 'logs' = $state('overview');
  let pullLoading = $state(false);

  // ── Version management ──────────────────────────────────────────────────────
  let currentImageTag = $state('');
  let inElectron = $state(false);
  let tagChangeLoading = $state(false);
  let uiDownloadLoading = $state(false);
  let uiDownloadReady = $state(false);
  let selectedImageTag = $state('latest');
  let selectedUiTag = $state('');
  let releases = $state<ReleaseEntry[]>([]);
  let releasesLoading = $state(false);

  // ── Container polling ──────────────────────────────────────────────────────
  const POLL_INTERVAL_MS = 10_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startContainerPolling(): void {
    stopContainerPolling();
    pollTimer = setInterval(() => {
      // Only poll when authenticated and data has been loaded at least once
      if (!authLocked && containerData) {
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

  function applyInvalidTokenState(): void {
    authLocked = true;
    authError = 'Invalid password.';
    adminStatus = 'Invalid password.';
  }


  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const loginRes = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: token }),
        credentials: 'include'
      });
      if (!loginRes.ok) {
        applyInvalidTokenState();
        return false;
      }
      authLocked = false;
      authError = '';
      adminStatus = '';
      // Auto-hydrate key data on login so the UI shows meaningful state immediately
      startContainerPolling();
      await loadHealth();
      void loadContainers();
      void loadAutomations();
      void loadVersions();
      void loadReleases();
      return true;
    } catch (e) {
      console.warn('[page] Auth failed:', e);
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
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
      containersLastUpdated = new Date().toLocaleTimeString();
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
      // Do not reset selectedImageTag/selectedUiTag here — loadReleases initializes them
    } catch {
      // Non-fatal — version info is supplementary
    }
  }

  async function loadReleases(): Promise<void> {
    releasesLoading = true;
    try {
      const data = await fetchReleases();
      releases = data.releases;
      const latestUiBuild = data.releases.find((r) => r.hasUiBuild);
      if (latestUiBuild) selectedUiTag = latestUiBuild.tag;
    } catch {
      // Non-fatal
    }
    releasesLoading = false;
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
    try {
      await downloadUiVersion(tag);
      selectedUiTag = tag;
      uiDownloadReady = true;
    } catch (e) {
      const err = e as { message?: string };
      operationResult = `Failed to download UI version: ${err.message ?? e}`;
      operationResultType = 'error';
    }
    uiDownloadLoading = false;
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
    void (async () => {
      authLoading = true;
      try {
        // Check session validity by attempting an authenticated request.
        // A 401 means no valid session cookie — show auth gate.
        const probe = await fetch('/admin/health', { credentials: 'include' });
        if (probe.status === 401 || probe.status === 503) {
          authLocked = true;
          authLoading = false;
          return;
        }
        authLocked = false;
        authError = '';
        adminStatus = '';
        startContainerPolling();
        // Auto-hydrate key data so tabs show meaningful state without manual refresh
        void loadHealth();
        void loadContainers();
        void loadAutomations();
        void loadVersions();
        void loadReleases();
        } catch (e) {
        console.warn('[page] Session probe on mount failed:', e);
        authLocked = true;
        authError = 'Unable to reach admin API.';
      } finally {
        authLoading = false;
      }
    })();
  });
</script>

<svelte:head>
  <title>OpenPalm Console</title>
</svelte:head>

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar />

  <main>
    <TabBar active={activeTab} onSelect={handleTabSelect} />

    {#if activeTab === 'overview'}
      <OverviewTab
        {adminHealth}
        {operationResult}
        {operationResultType}
        tokenStored={true}
        {healthLoading}
        {applyLoading}
        {upgradeLoading}
        {anyDangerousLoading}
        {automationsData}
        {mergedServices}
        {currentImageTag}
        {tagChangeLoading}
        {uiDownloadLoading}
        {uiDownloadReady}
        {inElectron}
        {selectedImageTag}
        {selectedUiTag}
        {releases}
        {releasesLoading}
        onCheckHealth={loadHealth}
        onApplyChanges={handleApplyChanges}
        onUpgradeStack={handleUpgradeStack}
        onDismissResult={() => { operationResult = ''; operationResultType = 'info'; }}
        onSetImageTag={handleSetImageTag}
        onDownloadUiVersion={handleDownloadUiVersion}
        onRestartApp={handleRestartApp}
        onSelectedImageTagChange={(t) => { selectedImageTag = t; }}
        onSelectedUiTagChange={(t) => { selectedUiTag = t; }}
      />
    {:else if activeTab === 'addons'}
      <AddonsTab
        onAuthError={handleComponentsAuthError}
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
    {:else if activeTab === 'connections'}
      <ProvidersPanel />
    {:else if activeTab === 'secrets'}
      <SecretsTab tokenStored={true} />
    {/if}
    {#if activeTab === 'voice'}
      <VoiceTab tokenStored={true} />
    {:else if activeTab === 'akm'}
      <AkmTab tokenStored={true} />
    {:else if activeTab === 'logs'}
      <LogsTab
        tokenStored={true}
        services={serviceNames}
      />
    {/if}
  </main>
{/if}

<style>
  main {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: var(--space-8) var(--space-6) var(--space-12);
  }

  @media (max-width: 768px) {
    main {
      padding: var(--space-4) var(--space-4) var(--space-8);
    }
  }


</style>
