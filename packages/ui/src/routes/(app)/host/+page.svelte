<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { goto, pushState } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { formatTime } from '$lib/format-date.js';
  import Navbar from '$lib/components/chrome/Navbar.svelte';
  import SurfaceToolbar from '$lib/components/chrome/SurfaceToolbar.svelte';
  import VoiceStopControl from '$lib/components/chrome/VoiceStopControl.svelte';
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
  import StackNotInstalled from '$lib/components/admin/StackNotInstalled.svelte';
  import { getRuntimeContext } from '$lib/runtime-context.svelte.js';
  import { hostReturnTo, hostTabFromUrl, hostUrlForTab } from './navigation.js';

  import {
    fetchHealth,
    fetchContainers,
    fetchAutomations,
    containerAction,
    pullImages,
  } from '$lib/api.js';
  import type { ContainerListResponse, AutomationsResponse, ServiceEntry } from '$lib/types.js';

  // Auth is enforced server-side in hooks.server.ts; this page only renders for
  // an authenticated admin. A session that expires mid-operation surfaces as a
  // 401 on an in-page API call, handled by redirecting to /login.
  const runtimeContext = getRuntimeContext();

  // `stackInstalled` comes from +page.server.ts, which resolves it on BOTH the
  // SSR and client-navigation lanes. When false there is nothing to
  // administer: the tabs, the loaders and the 10s container poll are all
  // skipped in favour of a notice pointing at the wizard.
  let { data }: { data: import('./$types').PageData } = $props();

  // ── Loading flags ───────────────────────────────────────────────────────────
  let healthLoading = $state(false);
  let containersLoading = $state(false);
  let automationsLoading = $state(false);

  // ── Content state ───────────────────────────────────────────────────────────
  let containerData: ContainerListResponse | null = $state(null);
  let containerError = $state('');
  let containersLastUpdated: string | null = $state(null);
  let automationsData: AutomationsResponse | null = $state(null);
  let automationsError = $state('');
  let selectedContainerId: string | null = $state(null);

  // ── Tab ─────────────────────────────────────────────────────────────────────
  let currentHostUrl: URL = $state(page.url);
  let activeTab: TabId = $state(hostTabFromUrl(page.url));
  let chatReturnHref: string | undefined = $state(hostReturnTo(page.url));
  let focusAddon: 'voice' | 'remote' | undefined = $state(resolveFocusAddon(page.url));
  let pullLoading = $state(false);

  const resolvedChatReturnHref = $derived(chatReturnHref ?? runtimeContext.routes.chat ?? resolve('/chat'));
  const settingsHref = $derived(
    `${resolve('/connections')}?returnTo=${encodeURIComponent(resolvedChatReturnHref)}`
  );
  const currentHostHref = $derived(
    `${currentHostUrl.pathname}${currentHostUrl.search}${currentHostUrl.hash}`
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

  /** Merged service → state map (used by OverviewTab for health indicators) */
  let mergedServices = $derived.by((): Map<string, string> => {
    if (!containerData) return new SvelteMap<string, string>();
    const merged = new SvelteMap<string, string>();
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
    const byService = new SvelteMap<string, ServiceEntry>();
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
  // the login route and return to the current host section after re-authenticating.
  function applyInvalidTokenState(): void {
    const redirectTo = `${currentHostUrl.pathname}${currentHostUrl.search}${currentHostUrl.hash}`;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- internal login path with a query string, not a static route id
    void goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  }

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadHealth(): Promise<void> {
    healthLoading = true;
    try {
      await fetchHealth();
    } catch (e) {
      console.warn('[page] Health check failed:', e);
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

  // ── Actions ──────────────────────────────────────────────────────────────────

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
    const names = new SvelteSet<string>();
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

  // The deep-linkable addon drawers (?tab=addons&addon=<id>): voice for its
  // profile selector, remote for the provider status card
  // (remote-access-providers.md §5). One resolver so the initial load and
  // history navigation cannot drift.
  function resolveFocusAddon(url: URL): 'voice' | 'remote' | undefined {
    const addon = url.searchParams.get('addon');
    return addon === 'voice' || addon === 'remote' ? addon : undefined;
  }

  function applyHostUrl(url: URL): void {
    currentHostUrl = url;
    activeTab = hostTabFromUrl(url);
    chatReturnHref = hostReturnTo(url);
    focusAddon = resolveFocusAddon(url);
  }

  function handleHistoryChange(): void {
    applyHostUrl(new URL(window.location.href));
  }

  function handleTabSelect(tab: TabId): void {
    if (currentHostUrl.searchParams.get('tab') !== tab) {
      const nextUrl = hostUrlForTab(currentHostUrl, tab);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- dynamic shallow URL preserves validated host-page query context
      pushState(nextUrl, {});
      applyHostUrl(nextUrl);
    } else {
      activeTab = tab;
    }
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
    // Nothing to poll or fetch on a host with no install — every /api/host/*
    // call would fail, on a 10s repeat, behind a notice that says so already.
    if (!data.stackInstalled) return;
    startContainerPolling();
    // Auto-hydrate key data so tabs show meaningful state without manual refresh.
    void loadHealth();
    void loadContainers();
    void loadAutomations();
  });
</script>

<svelte:window onpopstate={handleHistoryChange} />

<svelte:head>
  <title>OpenPalm Console</title>
</svelte:head>

<Navbar brandHref={resolvedChatReturnHref} showUtilities={false}>
  <div class="host-toolbar">
    <VoiceStopControl />
    <SurfaceToolbar
      {settingsHref}
      hostHref={currentHostHref}
      conversationHref={resolvedChatReturnHref}
      hostCurrent
      compact
    />
  </div>
</Navbar>

{#if !data.stackInstalled}
  <main>
    <StackNotInstalled setupHref={runtimeContext.routes.setup ?? resolve('/setup')} />
  </main>
{:else}
<TabBar active={activeTab} onSelect={handleTabSelect} />

  <main>
    {#if activeTab === 'overview'}
      <OverviewTab
        {healthLoading}
        {mergedServices}
        managedServices={containerData?.managedServices ?? []}
        onCheckHealth={loadHealth}
        onNavigate={handleTabSelect}
      />
    {:else if activeTab === 'updates'}
      <UpdatesTab
        containers={serviceEntries}
        dockerAvailable={containerData?.dockerAvailable ?? false}
        onRefresh={loadContainers}
      />
    {:else if activeTab === 'recovery'}
      <RecoveryTab />
    {:else if activeTab === 'addons'}
      {#key focusAddon}
        <AddonsTab
          onAuthError={handleComponentsAuthError}
          focusAddon={focusAddon}
        />
      {/key}
    {:else if activeTab === 'containers'}
      <ContainersTab
        {containerData}
        {serviceEntries}
        loading={containersLoading}
        error={containerError}
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
        onRefresh={loadAutomations}
      />
    {:else if activeTab === 'activity'}
      <ActivityTab />
    {:else if activeTab === 'connections'}
      <ProvidersPanel />
    {:else if activeTab === 'assistant'}
      <AssistantTab />
    {:else if activeTab === 'secrets'}
      <SecretsTab />
    {/if}
    {#if activeTab === 'akm'}
      <AkmTab />
    {:else if activeTab === 'host-sharing'}
      <HostSharingSection />
    {:else if activeTab === 'logs'}
      <LogsTab
        services={serviceNames}
        automations={automationsData?.automations.map((automation) => automation.name) ?? []}
      />
    {/if}
  </main>
{/if}

<style>
  .host-toolbar {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
  }

  /* Full-width admin: the content spans the viewport so the tab bar (rendered
     above, outside this container) reads edge-to-edge and flush under the
     navbar. Horizontal padding keeps panels off the screen edges. */
  main {
    background: var(--s-paper);
    color: var(--s-ink);
    font-family: var(--s-font-display);
    padding: var(--s-sp-6) var(--s-sp-6) var(--s-sp-8);
  }

  @media (max-width: 768px) {
    main {
      padding: var(--s-sp-4) var(--s-sp-4) var(--s-sp-6);
    }
  }
</style>
