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

  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    fetchHealth,
    fetchAccessScope,
    fetchContainers,
    fetchArtifacts,
    installStack,
    applyChanges,
    pullContainers,
    containerAction,
    fetchConnectionStatus
  } from '$lib/api.js';
  import type { HealthPayload, ContainerListResponse } from '$lib/types.js';

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

  // ── Content state ───────────────────────────────────────────────────────────
  let installResult = $state('');
  let artifacts = $state('');
  let containerData: ContainerListResponse | null = $state(null);
  let containerError = $state('');
  let selectedContainerId: string | null = $state(null);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let activeTab: 'overview' | 'containers' | 'artifacts' = $state('overview');

  // ── Derived ─────────────────────────────────────────────────────────────────
  let services = $derived([
    { name: 'Admin API', status: adminHealth?.status ?? null, icon: 'shield' },
    { name: 'Guardian', status: guardianHealth?.status ?? null, icon: 'globe' }
  ]);

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
    installResult = '';
    artifacts = '';
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
      await loadHealth();
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

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    const token = getAdminToken();
    tokenStored = Boolean(token);
    if (!token) {
      authLocked = true;
      authError = 'Admin token required.';
      adminStatus = '';
      installResult = 'Admin token required for protected actions.';
      return;
    }
    installLoading = true;
    try {
      installResult = await installStack(token);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        installResult = 'Invalid admin token.';
        applyInvalidTokenState();
      } else {
        installResult = `Error: ${err.message ?? e}`;
      }
    }
    installLoading = false;
  }

  async function handleApplyChanges(): Promise<void> {
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
      installResult = 'Changes applied successfully.';
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        installResult = `Error applying changes: ${err.message ?? e}`;
      }
    }
    applyLoading = false;
  }

  async function handlePullContainers(): Promise<void> {
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
      installResult = 'Container images updated successfully.';
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        applyInvalidTokenState();
      } else {
        installResult = `Error pulling containers: ${err.message ?? e}`;
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

  function handleTabSelect(tab: 'overview' | 'containers' | 'artifacts'): void {
    activeTab = tab;
    if (tab === 'containers' && !containerData) {
      void loadContainers();
    }
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
    <ConnectionBanner missing={connectionsMissing} />

    <TabBar active={activeTab} onSelect={handleTabSelect} />

    {#if activeTab === 'overview'}
      <OverviewTab
        {services}
        {adminHealth}
        {guardianHealth}
        {channelAccess}
        {installResult}
        {adminStatus}
        {tokenStored}
        {healthLoading}
        {installLoading}
        {applyLoading}
        {pullLoading}
        onCheckHealth={loadHealth}
        onInstall={handleInstall}
        onApplyChanges={handleApplyChanges}
        onPullContainers={handlePullContainers}
        onDismissInstallResult={() => (installResult = '')}
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
        loading={artifactsLoading}
        {tokenStored}
        onInspectCompose={() => loadArtifacts('compose')}
        onInspectCaddy={() => loadArtifacts('caddyfile')}
        onDismiss={() => (artifacts = '')}
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
