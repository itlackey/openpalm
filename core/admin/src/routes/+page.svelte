<script lang="ts">
  import { onMount } from 'svelte';
  import { version } from '$app/environment';
  import ConnectionBanner from '$lib/components/ConnectionBanner.svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import OverviewTab from '$lib/components/OverviewTab.svelte';
  import ContainersTab from '$lib/components/ContainersTab.svelte';
  import ArtifactsTab from '$lib/components/ArtifactsTab.svelte';
  import AutomationsTab from '$lib/components/AutomationsTab.svelte';
  import ConnectionsTab from '$lib/components/ConnectionsTab.svelte';

  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    fetchHealth,
    fetchAccessScope,
    fetchContainers,
    fetchArtifacts,
    fetchAutomations,
    installStack,
    applyChanges,
    pullContainers,
    containerAction,
    fetchConnectionStatus,
    fetchConnections,
    fetchChannels
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse, AutomationsResponse, ChannelsResponse } from '$lib/types.js';

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
  let installLoading = $state(false);
  let applyLoading = $state(false);
  let pullLoading = $state(false);
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
  let automationsData: AutomationsResponse | null = $state(null);
  let automationsError = $state('');
  let selectedContainerId: string | null = $state(null);
  let connectionsData: Record<string, string> = $state({});
  let connectionsLoading = $state(false);
  let channelsData: ChannelsResponse | null = $state(null);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let activeTab: 'overview' | 'containers' | 'artifacts' | 'automations' | 'connections' = $state('overview');

  // ── Derived ─────────────────────────────────────────────────────────────────
  let services = $derived([
    { name: 'Admin API', status: adminHealth?.status ?? null, icon: 'shield' },
    { name: 'Guardian', status: guardianHealth?.status ?? null, icon: 'globe' }
  ]);
  let anyDangerousLoading = $derived(installLoading || applyLoading || pullLoading);

  // ── Auth helpers ─────────────────────────────────────────────────────────────

  function applyInvalidTokenState(): void {
    clearToken();
    tokenStored = false;
    authLocked = true;
    authError = 'Invalid admin token.';
    adminStatus = 'Invalid admin token.';
  }

  function handleLogout(): void {
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
    selectedContainerId = null;
  }

  async function handleAuthSuccess(token: string): Promise<void> {
    if (authLoading) return;
    authLoading = true;
    authError = '';
    try {
      const result = await validateToken(token);
      if (!result.allowed) {
        applyInvalidTokenState();
        return;
      }
      storeToken(token);
      tokenStored = true;
      authLocked = false;
      authError = '';
      adminStatus = '';
      // Auto-hydrate key data on login so the UI shows meaningful state immediately
      await loadHealth();
      void loadContainers();
      void loadAutomations();
      void loadChannels();
      void checkConnectionStatus();
    } catch {
      authError = 'Unable to reach admin API.';
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

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    if (anyDangerousLoading) return;
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      operationResult = 'Admin token required for protected actions.';
      operationResultType = 'error';
      return;
    }
    installLoading = true;
    try {
      operationResult = await installStack(token);
      operationResultType = 'success';
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        operationResult = 'Invalid admin token.';
        operationResultType = 'error';
        applyInvalidTokenState();
      } else {
        operationResult = `Error: ${err.message ?? e}`;
        operationResultType = 'error';
      }
    }
    installLoading = false;
  }

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

  async function handlePullContainers(): Promise<void> {
    if (anyDangerousLoading) return;
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      return;
    }
    pullLoading = true;
    try {
      await pullContainers(token);
      operationResult = 'Container images updated successfully.';
      operationResultType = 'success';
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        operationResult = `Error pulling containers: ${err.message ?? e}`;
        operationResultType = 'error';
      }
    }
    pullLoading = false;
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

  function handleTabSelect(tab: 'overview' | 'containers' | 'artifacts' | 'automations' | 'connections'): void {
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

  // ── Mount ────────────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      // Check if setup is complete — redirect to wizard if not
      try {
        const setupRes = await fetch('/admin/setup', {
          headers: { 'x-requested-by': 'ui', 'x-request-id': crypto.randomUUID() }
        });
        if (setupRes.ok) {
          const setupData = await setupRes.json();
          if (!setupData.setupComplete) {
            window.location.href = '/setup';
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

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar {version} {channelAccess} onLogout={handleLogout} />

  <main>
    <ConnectionBanner missing={connectionsMissing} onNavigate={() => handleTabSelect('connections')} />

    <TabBar active={activeTab} onSelect={handleTabSelect} />

    {#if activeTab === 'overview'}
      <OverviewTab
        {services}
        {adminHealth}
        {guardianHealth}
        {channelAccess}
        {operationResult}
        {operationResultType}
        {adminStatus}
        {tokenStored}
        {healthLoading}
        {installLoading}
        {applyLoading}
        {pullLoading}
        {anyDangerousLoading}
        {automationsData}
        {containerData}
        {channelsData}
        onCheckHealth={loadHealth}
        onInstall={handleInstall}
        onApplyChanges={handleApplyChanges}
        onPullContainers={handlePullContainers}
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
        connections={connectionsData}
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
