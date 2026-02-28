<script lang="ts">
  import type { HealthPayload } from '$lib/types.js';

  interface ServiceItem {
    name: string;
    status: string | null;
    icon: string;
  }

  interface Props {
    services: ServiceItem[];
    adminHealth: HealthPayload | null;
    guardianHealth: HealthPayload | null;
    channelAccess: 'host' | 'lan' | 'custom';
    installResult: string;
    adminStatus: string;
    tokenStored: boolean;
    healthLoading: boolean;
    installLoading: boolean;
    applyLoading: boolean;
    pullLoading: boolean;
    onCheckHealth: () => void;
    onInstall: () => void;
    onApplyChanges: () => void;
    onPullContainers: () => void;
    onDismissInstallResult: () => void;
  }

  let {
    services,
    adminHealth,
    guardianHealth,
    channelAccess,
    installResult,
    adminStatus,
    tokenStored,
    healthLoading,
    installLoading,
    applyLoading,
    pullLoading,
    onCheckHealth,
    onInstall,
    onApplyChanges,
    onPullContainers,
    onDismissInstallResult
  }: Props = $props();

  function statusColor(status: string | undefined): 'success' | 'danger' | 'idle' {
    if (!status) return 'idle';
    if (status === 'ok' || status === 'running') return 'success';
    return 'danger';
  }
</script>

<!-- Page Header -->
<header class="page-header">
  <div class="header-content">
    <h1>Control Plane</h1>
    <p class="header-subtitle">
      Manage services, channels, and infrastructure from a single interface.
    </p>
    {#if adminStatus}
      <p class="admin-hint">{adminStatus}</p>
    {/if}
  </div>
  <div class="header-actions">
    <button class="btn btn-primary" onclick={onCheckHealth} disabled={healthLoading}>
      {#if healthLoading}
        <span class="spinner"></span>
      {/if}
      Check Health
    </button>
    <button class="btn btn-secondary" onclick={onInstall} disabled={installLoading || !tokenStored}>
      {#if installLoading}
        <span class="spinner"></span>
      {/if}
      Install Stack
    </button>
  </div>
</header>

<!-- Service Status Cards -->
<section class="status-row">
  {#each services as svc}
    <div class="status-card">
      <div class="status-card-header">
        <span class="status-icon status-icon--{statusColor(svc.status ?? undefined)}">
          {#if svc.icon === 'shield'}
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          {:else}
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          {/if}
        </span>
        <div class="status-card-info">
          <span class="status-card-name">{svc.name}</span>
          <span class="status-card-value status-text--{statusColor(svc.status ?? undefined)}">
            {#if svc.status === null}
              Not checked
            {:else if svc.status === 'ok'}
              Healthy
            {:else if svc.status === 'running'}
              Running
            {:else}
              {svc.status}
            {/if}
          </span>
        </div>
      </div>
      <div class="status-indicator status-indicator--{statusColor(svc.status ?? undefined)}"></div>
    </div>
  {/each}
</section>

<!-- Install Output -->
{#if installResult}
  <section class="output-section">
    <div class="output-header">
      <h3>Install Output</h3>
      <button class="btn-ghost" aria-label="Dismiss" onclick={onDismissInstallResult}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <pre class="output-code">{installResult}</pre>
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
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Health Check</span>
            <span class="action-desc">Verify admin and guardian services</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <button class="action-item" onclick={onInstall} disabled={installLoading || !tokenStored}>
          <span class="action-icon action-icon--amber">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Install Stack</span>
            <span class="action-desc">Bootstrap all core services</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <button class="action-item" onclick={onApplyChanges} disabled={applyLoading || !tokenStored}>
          <span class="action-icon action-icon--blue">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 16 12 12 8 16" />
              <line x1="12" y1="12" x2="12" y2="21" />
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Apply Changes</span>
            <span class="action-desc">Update and restart services with latest config</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <button class="action-item" onclick={onPullContainers} disabled={pullLoading || !tokenStored}>
          <span class="action-icon action-icon--amber">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Update All Containers</span>
            <span class="action-desc">Pull latest images for all services</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </button>

        <a class="action-item" href="http://localhost:4096" target="_blank" rel="noopener noreferrer">
          <span class="action-icon action-icon--blue">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <path d="M9 9h6v6H9z" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Open OpenCode UI</span>
            <span class="action-desc">Open the assistant web interface</span>
          </div>
          <span class="action-arrow">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </a>

        <a class="action-item" href="http://localhost:3001" target="_blank" rel="noopener noreferrer">
          <span class="action-icon action-icon--amber">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </span>
          <div class="action-content">
            <span class="action-title">Open OpenMemory UI</span>
            <span class="action-desc">Open the memory dashboard</span>
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
          <span class="info-label">Access Mode</span>
          <span class="info-value">
            <span class="badge" class:badge-success={channelAccess === 'lan'} class:badge-warning={channelAccess === 'host' || channelAccess === 'custom'}>
              {channelAccess.toUpperCase()}
            </span>
          </span>
        </div>
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
            {#if guardianHealth}
              <span class="badge" class:badge-success={guardianHealth.status === 'ok'} class:badge-danger={guardianHealth.status !== 'ok'}>
                {guardianHealth.status}
              </span>
            {:else}
              <span class="badge badge-idle">Unknown</span>
            {/if}
          </span>
        </div>
        <div class="info-item">
          <span class="info-label">Interface</span>
          <span class="info-value info-mono">SvelteKit</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  /* Page Header */
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-6);
    margin-bottom: var(--space-8);
  }

  .page-header h1 {
    font-size: var(--text-3xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    letter-spacing: -0.025em;
    line-height: var(--leading-tight);
  }

  .header-subtitle {
    margin-top: var(--space-2);
    color: var(--color-text-secondary);
    font-size: var(--text-base);
  }

  .admin-hint {
    margin-top: var(--space-3);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  .header-actions {
    display: flex;
    gap: var(--space-3);
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
  }

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

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
  }

  .panel-header h2 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .panel-body {
    padding: var(--space-5);
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

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-success {
    color: var(--color-success);
    background: var(--color-success-bg);
  }

  .badge-danger {
    color: var(--color-danger);
    background: var(--color-danger-bg);
  }

  .badge-warning {
    color: var(--color-warning);
    background: var(--color-warning-bg);
  }

  .badge-idle {
    color: var(--color-text-tertiary);
    background: var(--color-bg-tertiary);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary);
    color: #000;
    border-color: var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .btn-ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-ghost:hover {
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 768px) {
    .page-header {
      flex-direction: column;
      gap: var(--space-4);
    }

    .header-actions {
      width: 100%;
    }

    .header-actions .btn {
      flex: 1;
    }

    .panel-grid {
      grid-template-columns: 1fr;
    }

    .status-row {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 480px) {
    .page-header h1 {
      font-size: var(--text-2xl);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }

    * {
      transition-duration: 0s !important;
    }
  }
</style>
