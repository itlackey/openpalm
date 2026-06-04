<script lang="ts">
  import { onMount } from 'svelte';
  import type { HealthPayload, AutomationsResponse } from '$lib/types.js';
  import type { ReleaseEntry, UiVersionEntry } from '$lib/api.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  interface Props {
    adminHealth: HealthPayload | null;
    operationResult: string;
    operationResultType: 'success' | 'error' | 'info';
    tokenStored: boolean;
    healthLoading: boolean;
    applyLoading: boolean;
    upgradeLoading: boolean;
    anyDangerousLoading: boolean;
    automationsData: AutomationsResponse | null;
    mergedServices: Map<string, string>;
    currentImageTag: string;
    tagChangeLoading: boolean;
    uiDownloadLoading: boolean;
    uiDownloadReady: boolean;
    inElectron: boolean;
    selectedImageTag: string;
    selectedUiTag: string;
    releases: ReleaseEntry[];
    releasesLoading: boolean;
    uiVersions: UiVersionEntry[];
    uiVersionsLoading: boolean;
    onCheckHealth: () => void;
    onApplyChanges: () => void;
    onUpgradeStack: () => void;
    onDismissResult: () => void;
    onSetImageTag: (tag: string) => void;
    onDownloadUiVersion: (tag: string) => void;
    onRestartApp: () => void;
    onSelectedImageTagChange: (tag: string) => void;
    onSelectedUiTagChange: (tag: string) => void;
  }

  let {
    adminHealth,
    operationResult,
    operationResultType,
    tokenStored,
    healthLoading,
    applyLoading,
    upgradeLoading,
    anyDangerousLoading,
    automationsData,
    mergedServices,
    currentImageTag,
    tagChangeLoading,
    uiDownloadLoading,
    uiDownloadReady,
    inElectron,
    selectedImageTag,
    selectedUiTag,
    releases,
    releasesLoading,
    uiVersions,
    uiVersionsLoading,
    onCheckHealth,
    onApplyChanges,
    onUpgradeStack,
    onDismissResult,
    onSetImageTag,
    onDownloadUiVersion,
    onRestartApp,
    onSelectedImageTagChange,
    onSelectedUiTagChange,
  }: Props = $props();

  // Load endpoints if not already loaded so we get the real assistant URL.
  onMount(() => { void endpointsService.load(); });

  // Label for a UI-build option: version + prerelease/dist-tag annotations.
  function uiVersionLabel(v: UiVersionEntry): string {
    const tags: string[] = [];
    if (v.distTag) tags.push(v.distTag);
    else if (v.prerelease) tags.push('pre-release');
    return tags.length ? `${v.version} (${tags.join(', ')})` : v.version;
  }

  // Derived: automation count
  let automationCount = $derived(automationsData?.automations.length ?? 0);
  let enabledAutomationCount = $derived(
    automationsData?.automations.filter(a => a.enabled).length ?? 0
  );

  // Derived: overall container health counts
  let containerCounts = $derived.by(() => {
    if (mergedServices.size === 0) return null;
    const total = mergedServices.size;
    const running = [...mergedServices.values()].filter(s => s === 'running').length;
    return { total, running };
  });

  // Derived: guardian status from merged Docker data (not optimistic state.services)
  let guardianContainerStatus = $derived.by(() => {
    const status = mergedServices.get('guardian');
    if (status === 'running') return 'running' as const;
    if (status === 'stopped' || status === 'exited' || status === 'created') return 'stopped' as const;
    if (status) return 'stopped' as const; // any non-running state = stopped
    return 'unknown' as const;
  });

  // Derived: assistant connectivity from merged Docker data
  let assistantStatus = $derived.by(() => {
    const status = mergedServices.get('assistant');
    if (status === 'running') return 'connected' as const;
    if (status === 'stopped' || status === 'exited' || status === 'created') return 'disconnected' as const;
    if (status) return 'disconnected' as const;
    return 'unknown' as const;
  });

  // Derived: top-level system health summary
  let healthSummary = $derived.by((): { status: 'ok' | 'warning' | 'unknown'; message: string } => {
    if (!containerCounts) return { status: 'unknown', message: 'Checking services…' };
    if (containerCounts.running === containerCounts.total && containerCounts.total > 0) {
      return { status: 'ok', message: `All ${containerCounts.total} services running` };
    }
    const down = containerCounts.total - containerCounts.running;
    return { status: 'warning', message: `${down} of ${containerCounts.total} services not running — check the Containers tab` };
  });

</script>


<!-- System health summary bar -->
<div class="health-summary health-summary--{healthSummary.status}" role="status" aria-live="polite">
  <span class="health-dot"></span>
  <span class="health-msg">{healthSummary.message}</span>
</div>

<!-- Operation Output -->
{#if operationResult}
  <section class="output-section output-section--{operationResultType}">
    <div class="output-header">
      <h3>Operation Output</h3>
      <button class="btn-ghost" aria-label="Dismiss" onclick={onDismissResult}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <pre class="output-code">{operationResult}</pre>
  </section>
{/if}

<!-- Overview Panels -->
<div class="panel-grid" role="tabpanel">
  <!-- Quick Actions Panel -->
  <div class="panel">
    <div class="panel-header">
      <h2>Quick Actions</h2>
    </div>
    <div class="panel-body">
      <div class="action-list">
        <button class="action-item" onclick={onCheckHealth} disabled={healthLoading}>
          <span class="action-icon action-icon--blue">
            {#if healthLoading}
              <span class="spinner"></span>
            {:else}
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            {/if}
          </span>
          <div class="action-content">
            <span class="action-title">Health Check</span>
            <span class="action-desc">Verify admin and guardian services are reachable</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <button class="action-item" onclick={onApplyChanges} disabled={anyDangerousLoading || !tokenStored}>
          <span class="action-icon action-icon--blue">
            {#if applyLoading}
              <span class="spinner"></span>
            {:else}
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 16 12 12 8 16" />
                <line x1="12" y1="12" x2="12" y2="21" />
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
              </svg>
            {/if}
          </span>
          <div class="action-content">
            <span class="action-title">Apply Config + Restart</span>
            <span class="action-desc">Update configuration and restart running services</span>
            <span class="action-hint">Restarts services with updated compose config.</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>


        <a class="action-item" href="/setup?rerun=1">
          <span class="action-icon action-icon--purple">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Update Settings</span>
            <span class="action-desc">Re-run setup wizard to change providers, channels, or options</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </a>

        <a class="action-item" href="/advanced">
          <span class="action-icon action-icon--blue">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <path d="M9 9h6v6H9z" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Advanced Chat (OpenCode)</span>
            <span class="action-desc">Open the full OpenCode UI embedded in OpenPalm — host machine only</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </a>
      </div>
    </div>
  </div>

  <!-- System Info Panel -->
  <div class="panel">
    <div class="panel-header">
      <h2>System Information</h2>
    </div>
    <div class="panel-body">
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Admin API</span>
          <span class="info-value">
            {#if adminHealth}
              <span class="badge" class:badge-success={adminHealth.status === 'ok'} class:badge-danger={adminHealth.status !== 'ok'}>
                {adminHealth.status}
              </span>
            {:else}
              <span class="badge badge-idle">Unknown</span>
            {/if}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Guardian</span>
          <span class="info-value">
            {#if guardianContainerStatus === 'running'}
              <span class="badge badge-success">Running</span>
            {:else if guardianContainerStatus === 'stopped'}
              <span class="badge badge-danger">Stopped</span>
            {:else}
              <span class="badge badge-idle">Unknown</span>
            {/if}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Containers</span>
          <span class="info-value">
            {#if containerCounts}
              {#if containerCounts.running === containerCounts.total}
                <span class="badge badge-success">{containerCounts.running} / {containerCounts.total} running</span>
              {:else if containerCounts.running > 0}
                <span class="badge badge-warning">{containerCounts.running} / {containerCounts.total} running</span>
              {:else}
                <span class="badge badge-danger">0 / {containerCounts.total} running</span>
              {/if}
            {:else}
              <span class="badge badge-idle">Unknown</span>
            {/if}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Assistant</span>
          <span class="info-value">
            {#if assistantStatus === 'connected'}
              <span class="badge badge-success">Connected</span>
            {:else if assistantStatus === 'disconnected'}
              <span class="badge badge-danger">Disconnected</span>
            {:else}
              <span class="badge badge-idle">Unknown</span>
            {/if}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Automations</span>
          <span class="info-value">
            {#if automationsData}
              <span class="info-mono">{enabledAutomationCount} active / {automationCount} total</span>
            {:else}
              <span class="badge badge-idle">Loading</span>
            {/if}
          </span>
        </div>
      </div>
    </div>
  </div>

  <!-- Versions Panel -->
  <div class="panel">
    <div class="panel-header">
      <h2>Version Management</h2>
    </div>
    <div class="panel-body">

      <!-- Stack images -->
      <div class="version-section">
        <div class="version-row">
          <span class="version-label">Stack images</span>
          <code class="version-value version-value--active">{currentImageTag || '—'}</code>
        </div>
        <div class="version-input-row">
          {#if releasesLoading}
            <div class="version-select-skeleton"></div>
          {:else if releases.length > 0}
            <select
              class="version-select"
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
              class="version-input"
              type="text"
              placeholder="e.g. 0.11.0 or latest"
              value={selectedImageTag}
              oninput={(e) => onSelectedImageTagChange((e.currentTarget as HTMLInputElement).value)}
              disabled={tagChangeLoading || anyDangerousLoading}
            />
          {/if}
          <button
            class="btn btn-sm"
            onclick={() => { if (selectedImageTag.trim()) onSetImageTag(selectedImageTag.trim()); }}
            disabled={!selectedImageTag.trim() || tagChangeLoading || anyDangerousLoading}
          >
            {#if tagChangeLoading}
              <span class="spinner spinner-sm"></span> Applying…
            {:else}
              Pull &amp; Restart
            {/if}
          </button>
        </div>
        <p class="version-hint">Pulls the selected images and restarts services.</p>
      </div>

      <div class="version-divider"></div>

      <!-- Upgrade Stack -->
      <div class="version-section">
        <div class="version-row">
          <span class="version-label">Upgrade Stack</span>
        </div>
        <div class="version-input-row">
          <button
            class="btn btn-sm btn-warning"
            onclick={onUpgradeStack}
            disabled={anyDangerousLoading || !tokenStored}
          >
            {#if upgradeLoading}
              <span class="spinner spinner-sm"></span> Upgrading…
            {:else}
              Upgrade to Latest
            {/if}
          </button>
        </div>
        <p class="version-hint">Downloads the latest assets, pulls images, and restarts services. Backs up current config first.</p>
      </div>

      <div class="version-divider"></div>

      <!-- UI build (Electron only) -->
      {#if inElectron}
        <div class="version-section">
          <div class="version-input-row">
            {#if uiVersionsLoading}
              <div class="version-select-skeleton"></div>
            {:else if uiVersions.length > 0}
              <select
                class="version-select"
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
                class="version-input"
                type="text"
                placeholder="e.g. 0.11.0-beta.7"
                value={selectedUiTag}
                oninput={(e) => onSelectedUiTagChange((e.currentTarget as HTMLInputElement).value)}
                disabled={uiDownloadLoading}
              />
            {/if}
            <button
              class="btn btn-sm"
              onclick={() => { if (selectedUiTag.trim()) onDownloadUiVersion(selectedUiTag.trim()); }}
              disabled={!selectedUiTag.trim() || uiDownloadLoading}
            >
              {#if uiDownloadLoading}
                <span class="spinner spinner-sm"></span> Downloading…
              {:else}
                Download
              {/if}
            </button>
          </div>
          {#if uiDownloadReady}
            <div class="version-restart-prompt">
              UI updated.
              <button class="btn btn-sm btn-primary" onclick={onRestartApp}>Restart App</button>
            </div>
          {:else}
            <p class="version-hint">Downloads and replaces the UI from GitHub. Takes effect on restart.</p>
          {/if}
        </div>
      {/if}

    </div>
  </div>
</div>

<style>
  /* Health Summary */
  .health-summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    margin-bottom: var(--space-6);
    border: 1px solid transparent;
  }
  .health-summary--ok { background: var(--color-success-bg); color: var(--color-success); border-color: var(--color-success-border); }
  .health-summary--warning { background: var(--color-warning-bg); color: var(--color-text); border-color: var(--color-warning); }
  .health-summary--unknown { background: var(--color-bg-secondary); color: var(--color-text-secondary); border-color: var(--color-border); }
  .health-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .health-summary--ok .health-dot { background: var(--color-success); }
  .health-summary--warning .health-dot { background: var(--color-warning); }
  .health-summary--unknown .health-dot { background: var(--color-border); }

  /* btn-warning for Upgrade Stack */
  .btn-warning {
    background: var(--color-warning-bg);
    color: var(--color-text);
    border: 1px solid var(--color-warning);
  }
  .btn-warning:hover:not(:disabled) { background: var(--color-warning); }

  /* Status Cards */
  .status-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-8);
  }

  .status-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-5);
    transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
  }

  .status-card:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }

  .status-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }

  .status-icon--success {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .status-icon--danger {
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }

  .status-icon--idle {
    background: var(--color-bg-tertiary);
    color: var(--color-text-tertiary);
  }

  .status-card-info {
    display: flex;
    flex-direction: column;
  }

  .status-card-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .status-card-value {
    font-size: var(--text-xs);
    margin-top: 2px;
  }

  .status-text--success {
    color: var(--color-success);
  }

  .status-text--danger {
    color: var(--color-danger);
  }

  .status-text--idle {
    color: var(--color-text-tertiary);
  }

  .status-indicator {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-indicator--success {
    background: var(--color-success);
    box-shadow: 0 0 0 3px var(--color-success-bg);
  }

  .status-indicator--danger {
    background: var(--color-danger);
    box-shadow: 0 0 0 3px var(--color-danger-bg);
  }

  .status-indicator--idle {
    background: var(--color-border);
    box-shadow: 0 0 0 3px var(--color-bg-tertiary);
  }

  /* Output */
  .output-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: var(--space-8);
  }

  .output-section--success {
    border-color: var(--color-success-border);
  }

  .output-section--error {
    border-color: var(--color-danger);
  }

  .output-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
  }

  .output-header h3 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .output-code {
    margin: 0;
    padding: var(--space-4) var(--space-5);
    max-height: 320px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: #e4e8f0;
    background: #1e2330;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Panels */
  .panel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: var(--space-6);
  }

  /* Action List */
  .action-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .action-item {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-family: var(--font-sans);
    text-align: left;
    text-decoration: none;
    color: inherit;
    transition: all var(--transition-fast);
  }

  .action-item:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border);
  }

  .action-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }

  .action-icon--blue {
    background: var(--color-info-bg);
    color: var(--color-info);
  }

  .action-icon--amber {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
  }

  .action-icon--purple {
    background: #ede9fe;
    color: #7c3aed;
  }

  .action-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .action-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .action-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: 1px;
  }

  .action-hint {
    font-size: 0.6875rem;
    color: var(--color-text-tertiary);
    font-style: italic;
    margin-top: 2px;
  }

  .action-arrow {
    color: var(--color-text-tertiary);
    flex-shrink: 0;
  }

  /* Info Grid */
  .info-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .info-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-bg-tertiary);
  }

  .info-item:last-child {
    border-bottom: none;
  }

  .info-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .info-value {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }

  .info-mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .channel-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }

  @media (max-width: 768px) {
    .panel-grid {
      grid-template-columns: 1fr;
    }

    .status-row {
      grid-template-columns: 1fr;
    }
  }

  .version-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .version-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .version-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .version-value {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-bg-secondary);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .version-input-row {
    display: flex;
    gap: var(--space-2);
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

  .version-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
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

</style>
