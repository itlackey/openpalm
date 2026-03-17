<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ConnectionBanner from '$lib/components/ConnectionBanner.svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import OverviewTab from '$lib/components/OverviewTab.svelte';
  import ContainersTab from '$lib/components/ContainersTab.svelte';
  import ArtifactsTab from '$lib/components/ArtifactsTab.svelte';
  import AutomationsTab from '$lib/components/AutomationsTab.svelte';
  import ConnectionsTab from '$lib/components/ConnectionsTab.svelte';
  import RegistryTab from '$lib/components/RegistryTab.svelte';

  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    fetchHealth,
    fetchAccessScope,
    fetchContainers,
    fetchArtifacts,
    fetchAutomations,
    applyChanges,
    upgradeStack,
    containerAction,
    fetchConnectionStatus,
    fetchConnections,
    fetchChannels,
    fetchRegistry,
    registryInstall,
    registryUninstall,
    registryRefresh
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse, ChannelsResponse, RegistryResponse } from '$lib/types.js';

  // ── Setup state ────────────────────────────────────────────────────────────
  let setupRequired = $state(false);

  // ── Auth state ──────────────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');
  let tokenStored = $state(false);

  // ── Health & service state ──────────────────────────────────────────────────
  let adminHealth = $state<HealthPayload | null>(null);
  let guardianHealth = $state<HealthPayload | null>(null);
  let channelAccess: 'host' | 'lan' | 'custom' = $state('lan');
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
  let artifactType: 'compose' | 'caddyfile' | null = $state(null);
  let containerData: ContainerListResponse | null = $state(null);
  let containerError = $state('');
  let containersLastUpdated: string | null = $state(null);
  let automationsData: AutomationsResponse | null = $state(null);
  let automationsError = $state('');
  let selectedContainerId: string | null = $state(null);
  let connectionsData: Record<string, string> = $state({});
  let connectionsLoading = $state(false);
  let channelsData: ChannelsResponse | null = $state(null);
  let registryData: RegistryResponse | null = $state(null);
  let registryLoading = $state(false);
  let registryError = $state('');
  let registryActionLoading: string | null = $state(null);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let activeTab: 'overview' | 'containers' | 'artifacts' | 'automations' | 'connections' | 'registry' = $state('overview');

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
  }

  function handleLogout(): void {
    stopContainerPolling();
    clearToken();
    tokenStored = false;
    authLocked = true;
    authError = '';
    adminStatus = '';
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
      void loadChannels();
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

      const scope = await fetchAccessScope(token);
      if (scope.ok) {
        if (scope.accessScope === 'host' || scope.accessScope === 'lan' || scope.accessScope === 'custom') {
          channelAccess = scope.accessScope;
        }
        adminStatus = '';
      } else if (scope.status === 401) {
        applyInvalidTokenState();
      }
    } catch {
      adminHealth = { status: 'error', service: 'admin' };
      guardianHealth = { status: 'error', service: 'guardian' };
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

  async function loadArtifacts(type: 'compose' | 'caddyfile'): Promise<void> {
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

  async function loadChannels(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    try {
      channelsData = await fetchChannels(token);
    } catch {
      // best-effort — don't disrupt auth flow on failure
    }
  }

  async function loadRegistry(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      registryError = 'Admin token required for protected actions.';
      registryData = null;
      return;
    }
    registryLoading = true;
    registryError = '';
    try {
      registryData = await fetchRegistry(token);
    } catch (e) {
      registryData = null;
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        registryError = 'Invalid admin token.';
        applyInvalidTokenState();
      } else {
        registryError = `Failed to load registry: ${err.message ?? e}`;
      }
    }
    registryLoading = false;
  }

  async function handleRegistryRefresh(): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    registryLoading = true;
    try {
      await registryRefresh(token);
    } catch {
      // best-effort
    }
    await loadRegistry();
  }

  async function handleRegistryInstall(name: string, type: 'channel' | 'automation'): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    registryActionLoading = `${type}:${name}`;
    try {
      await registryInstall(token, name, type);
      await loadRegistry();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        registryError = `Install failed: ${err.message ?? e}`;
      }
    }
    registryActionLoading = null;
  }

  async function handleRegistryUninstall(name: string, type: 'channel' | 'automation'): Promise<void> {
    const token = getAdminToken();
    if (!token) return;
    registryActionLoading = `${type}:${name}`;
    try {
      await registryUninstall(token, name, type);
      await loadRegistry();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        registryError = `Uninstall failed: ${err.message ?? e}`;
      }
    }
    registryActionLoading = null;
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

  function handleTabSelect(tab: 'overview' | 'containers' | 'artifacts' | 'automations' | 'connections' | 'registry'): void {
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
    if (tab === 'registry' && !registryData) {
      void loadRegistry();
    }
  }

  // ── Mount ────────────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      // Check if setup is complete — show CLI prompt if not
      try {
        const setupRes = await fetch('/admin/setup', {
          headers: { 'x-requested-by': 'ui', 'x-request-id': crypto.randomUUID() }
        });
        if (setupRes.ok) {
          const setupData = await setupRes.json();
          if (!setupData.setupComplete) {
            setupRequired = true;
            return;
          }
        }
      } catch {
        // best-effort — continue to auth gate
      }

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
        void loadChannels();
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

{#if setupRequired}
  <div class="setup-required">
    <h1>Setup Required</h1>
    <p>OpenPalm has not been configured yet. Run the following command from your terminal to complete setup:</p>
    <pre><code>openpalm install</code></pre>
    <p class="setup-hint">Once setup is complete, refresh this page to access the admin console.</p>
  </div>
{:else if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar onLogout={handleLogout} />

  <main>
    <ConnectionBanner missing={connectionsMissing} onNavigate={() => handleTabSelect('connections')} />

    <TabBar active={activeTab} onSelect={handleTabSelect} />

    {#if activeTab === 'overview'}
      <OverviewTab
        {services}
        {adminHealth}
        {channelAccess}
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
        {channelsData}
        onCheckHealth={loadHealth}
        onApplyChanges={handleApplyChanges}
        onUpgradeStack={handleUpgradeStack}
        onDismissResult={() => { operationResult = ''; operationResultType = 'info'; }}
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
    {:else if activeTab === 'registry'}
      <RegistryTab
        data={registryData}
        loading={registryLoading}
        error={registryError}
        {tokenStored}
        actionLoading={registryActionLoading}
        onRefresh={handleRegistryRefresh}
        onInstall={handleRegistryInstall}
        onUninstall={handleRegistryUninstall}
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
  .setup-required {
    max-width: 600px;
    margin: 120px auto;
    padding: var(--space-8);
    text-align: center;
  }

  .setup-required h1 {
    font-size: 1.75rem;
    margin-bottom: var(--space-4);
  }

  .setup-required p {
    color: var(--color-text-secondary, #6b7280);
    margin-bottom: var(--space-4);
    line-height: 1.6;
  }

  .setup-required pre {
    display: inline-block;
    background: var(--color-surface-secondary, #f3f4f6);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    padding: var(--space-3) var(--space-6);
    font-size: 1.1rem;
    margin: var(--space-4) 0;
  }

  .setup-required .setup-hint {
    font-size: 0.875rem;
    color: var(--color-text-tertiary, #9ca3af);
  }

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
