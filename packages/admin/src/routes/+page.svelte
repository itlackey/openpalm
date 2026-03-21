<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ConnectionBanner from '$lib/components/ConnectionBanner.svelte';
  import MigrationBanner from '$lib/components/MigrationBanner.svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import OverviewTab from '$lib/components/OverviewTab.svelte';
  import ComponentsTab from '$lib/components/ComponentsTab.svelte';
  import ContainersTab from '$lib/components/ContainersTab.svelte';
  import ArtifactsTab from '$lib/components/ArtifactsTab.svelte';
  import AutomationsTab from '$lib/components/AutomationsTab.svelte';
  import ConnectionsTab from '$lib/components/ConnectionsTab.svelte';

  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    fetchHealth,
    fetchAdminOpenCodeStatus,
    fetchContainers,
    fetchArtifacts,
    fetchAutomations,
    applyChanges,
    upgradeStack,
    containerAction,
    fetchConnectionStatus,
    fetchConnections,
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse } from '$lib/types.js';

  // ── Auth state ──────────────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');
  let tokenStored = $state(false);

  // ── Health & service state ──────────────────────────────────────────────────
  let adminHealth = $state<HealthPayload | null>(null);
  let guardianHealth = $state<HealthPayload | null>(null);
  let adminOpenCodeStatus = $state<'checking' | 'ready' | 'unavailable'>('checking');
  let adminOpenCodeUrl = $state('http://localhost:3881/');
  let adminStatus = $state('');
  let connectionsMissing = $state<string[]>([]);

  // ── Loading flags ───────────────────────────────────────────────────────────
  let healthLoading = $state(false);
  let applyLoading = $state(false);
  let upgradeLoading = $state(false);
  let artifactsLoading = $state(false);
  let containersLoading = $state(false);
  let automationsLoading = $state(false);

  // ── Content state ───────────────────────────────────────────────────────────
  let operationResult = $state('');
  let operationResultType: 'success' | 'error' | 'info' = $state('info');
  let artifacts = $state('');
  let artifactType: 'compose' | null = $state(null);
  let containerData: ContainerListResponse | null = $state(null);
  let containerError = $state('');
  let containersLastUpdated: string | null = $state(null);
  let automationsData: AutomationsResponse | null = $state(null);
  let automationsError = $state('');
  let selectedContainerId: string | null = $state(null);
  let connectionsData: Record<string, string> = $state({});
  let connectionsLoading = $state(false);
  // ── Migration ───────────────────────────────────────────────────────────────
  let legacyInstallDetected = $state(false);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let activeTab: 'overview' | 'components' | 'containers' | 'artifacts' | 'automations' | 'connections' = $state('overview');

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
  let services = $derived([
    { name: 'Admin API', status: adminHealth?.status ?? null, icon: 'shield' },
    { name: 'Guardian', status: guardianHealth?.status ?? null, icon: 'globe' }
  ]);
  let anyDangerousLoading = $derived(applyLoading || upgradeLoading);

  // ── Auth helpers ─────────────────────────────────────────────────────────────

  function applyInvalidTokenState(): void {
    clearToken();
    tokenStored = false;
    authLocked = true;
    authError = 'Invalid admin token.';
    adminStatus = 'Invalid admin token.';
    adminOpenCodeStatus = 'unavailable';
  }

  function handleLogout(): void {
    stopContainerPolling();
    clearToken();
    tokenStored = false;
    authLocked = true;
    authError = '';
    adminStatus = '';
    adminOpenCodeStatus = 'checking';
    operationResult = '';
    operationResultType = 'info';
    artifacts = '';
    artifactType = null;
    containerData = null;
    containersLastUpdated = null;
    selectedContainerId = null;
  }

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const result = await validateToken(token);
      if (!result.allowed) {
        applyInvalidTokenState();
        return false;
      }
      storeToken(token);
      tokenStored = true;
      authLocked = false;
      authError = '';
      adminStatus = '';
      // Auto-hydrate key data on login so the UI shows meaningful state immediately
      startContainerPolling();
      await loadHealth();
      void loadContainers();
      void loadAutomations();
      void checkConnectionStatus();
      return true;
    } catch {
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
  }

  async function checkConnectionStatus(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    try {
      const data = await fetchConnectionStatus(token);
      connectionsMissing = data.complete ? [] : data.missing;
    } catch {
      // best-effort — don't disrupt auth flow on failure
    }
  }

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadHealth(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      return;
    }
    healthLoading = true;
    try {
      const health = await fetchHealth();
      adminHealth = health.admin;
      guardianHealth = health.guardian;
    } catch {
      adminHealth = { status: 'error', service: 'admin' };
      guardianHealth = { status: 'error', service: 'guardian' };
    }

    try {
      const adminOpenCode = await fetchAdminOpenCodeStatus(token);
      adminOpenCodeStatus = adminOpenCode.status;
      adminOpenCodeUrl = adminOpenCode.url;
    } catch (e) {
      adminOpenCodeStatus = 'unavailable';

      const err = e as { status?: number };
      if (err.status === 401) {
        applyInvalidTokenState();
      }
    }

    healthLoading = false;
  }

  async function loadContainers(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      containerError = 'Admin token required for protected actions.';
      containerData = null;
      return;
    }
    containersLoading = true;
    containerError = '';
    try {
      containerData = await fetchContainers(token);
    } catch (e) {
      containerData = null;
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        containerError = 'Invalid admin token.';
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

  async function loadArtifacts(type: 'compose'): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      artifacts = 'Admin token required for protected actions.';
      return;
    }
    artifactsLoading = true;
    artifactType = type;
    try {
      artifacts = await fetchArtifacts(token, type);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        artifacts = 'Invalid admin token.';
        applyInvalidTokenState();
      } else {
        artifacts = `Error: ${err.message ?? e}`;
      }
    }
    artifactsLoading = false;
  }

  async function loadAutomations(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      automationsError = 'Admin token required for protected actions.';
      automationsData = null;
      return;
    }
    automationsLoading = true;
    automationsError = '';
    try {
      automationsData = await fetchAutomations(token);
    } catch (e) {
      automationsData = null;
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        automationsError = 'Invalid admin token.';
        applyInvalidTokenState();
      } else {
        automationsError = `Failed to load automations: ${err.message ?? e}`;
      }
    }
    automationsLoading = false;
  }

  async function loadConnections(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      connectionsData = {};
      return;
    }
    connectionsLoading = true;
    try {
      connectionsData = await fetchConnections(token);
    } catch (e) {
      connectionsData = {};
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      }
    }
    connectionsLoading = false;
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleApplyChanges(): Promise<void> {
    if (anyDangerousLoading) return;
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      return;
    }
    applyLoading = true;
    try {
      await applyChanges(token);
      operationResult = 'Changes applied successfully.';
      operationResultType = 'success';
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
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      return;
    }
    upgradeLoading = true;
    try {
      operationResult = await upgradeStack(token);
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

  async function handleContainerAction(
    action: 'start' | 'stop' | 'restart',
    containerId: string
  ): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    try {
      await containerAction(token, action, containerId);
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

  function handleTabSelect(tab: 'overview' | 'components' | 'containers' | 'artifacts' | 'automations' | 'connections'): void {
    activeTab = tab;
    if (tab === 'containers' && !containerData) {
      void loadContainers();
    }
    if (tab === 'automations' && !automationsData) {
      void loadAutomations();
    }
    if (tab === 'connections' && Object.keys(connectionsData).length === 0) {
      void loadConnections();
    }
  }

  function handleComponentsAuthError(): void {
    applyInvalidTokenState();
  }

  // ── Mount ────────────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      const token = getAdminToken();
      tokenStored = Boolean(token);
      if (!token) {
        authLocked = true;
        authLoading = false;
        authError = '';
        adminStatus = '';
        return;
      }

      authLoading = true;
      try {
        const result = await validateToken(token);
        if (!result.allowed) {
          applyInvalidTokenState();
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
        void checkConnectionStatus();
      } catch {
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
  <Navbar onLogout={handleLogout} />

  <main>
    <MigrationBanner visible={legacyInstallDetected} />
    <ConnectionBanner missing={connectionsMissing} onNavigate={() => handleTabSelect('connections')} />

    <TabBar active={activeTab} onSelect={handleTabSelect} />

    {#if activeTab === 'overview'}
      <OverviewTab
        {services}
        {adminHealth}
        {adminOpenCodeStatus}
        {adminOpenCodeUrl}
        {operationResult}
        {operationResultType}
        {adminStatus}
        {tokenStored}
        {healthLoading}
        {applyLoading}
        {upgradeLoading}
        {anyDangerousLoading}
        {automationsData}
        {containerData}
        onCheckHealth={loadHealth}
        onApplyChanges={handleApplyChanges}
        onUpgradeStack={handleUpgradeStack}
        onDismissResult={() => { operationResult = ''; operationResultType = 'info'; }}
      />
    {:else if activeTab === 'components'}
      <ComponentsTab
        onAuthError={handleComponentsAuthError}
      />
    {:else if activeTab === 'containers'}
      <ContainersTab
        {containerData}
        loading={containersLoading}
        error={containerError}
        {tokenStored}
        {selectedContainerId}
        onToggleContainer={handleToggleContainer}
        onStart={(id) => handleContainerAction('start', id)}
        onStop={(id) => handleContainerAction('stop', id)}
        onRestart={(id) => handleContainerAction('restart', id)}
        onRefresh={loadContainers}
        lastUpdated={containersLastUpdated}
      />
    {:else if activeTab === 'artifacts'}
      <ArtifactsTab
        {artifacts}
        {artifactType}
        loading={artifactsLoading}
        {tokenStored}
        onInspect={(type) => loadArtifacts(type)}
        onDismiss={() => { artifacts = ''; artifactType = null; }}
      />
    {:else if activeTab === 'automations'}
      <AutomationsTab
        data={automationsData}
        loading={automationsLoading}
        error={automationsError}
        {tokenStored}
        onRefresh={loadAutomations}
      />
    {:else if activeTab === 'connections'}
      <ConnectionsTab
        loading={connectionsLoading}
        onRefresh={loadConnections}
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
