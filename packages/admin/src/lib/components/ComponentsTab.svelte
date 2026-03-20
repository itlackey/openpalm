<script lang="ts">
  import type { ComponentResponse, InstanceResponse, InstanceStatus } from '$lib/types.js';
  import {
    fetchComponents,
    fetchInstances,
    instanceAction,
    deleteInstance
  } from '$lib/api.js';
  import { getAdminToken } from '$lib/auth.js';
  import InstanceConfigForm from './InstanceConfigForm.svelte';
  import NewInstanceDialog from './NewInstanceDialog.svelte';

  interface Props {
    onAuthError: () => void;
  }

  let { onAuthError }: Props = $props();

  // ── State ───────────────────────────────────────────────────────────
  let components = $state<ComponentResponse[]>([]);
  let instances = $state<InstanceResponse[]>([]);
  let loading = $state(false);
  let error = $state('');

  let showNewInstance = $state(false);
  let configuringInstance = $state<string | null>(null);
  let actionLoading = $state<string | null>(null);
  let overflowOpen = $state<string | null>(null);

  // ── Derived ─────────────────────────────────────────────────────────

  /** Group instances by category for display */
  let groupedInstances = $derived.by(() => {
    const groups = new Map<string, InstanceResponse[]>();
    for (const inst of instances) {
      const cat = inst.category || 'other';
      const list = groups.get(cat) ?? [];
      list.push(inst);
      groups.set(cat, list);
    }
    // Sort groups alphabetically, but put "other" last
    const sorted = [...groups.entries()].sort((a, b) => {
      if (a[0] === 'other') return 1;
      if (b[0] === 'other') return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  });

  let hasInstances = $derived(instances.length > 0);

  // ── Data Loading ────────────────────────────────────────────────────

  async function loadData(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    loading = true;
    error = '';
    try {
      const [comps, insts] = await Promise.all([
        fetchComponents(token),
        fetchInstances(token)
      ]);
      components = comps;
      instances = insts;
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        onAuthError();
        return;
      }
      error = err.message ?? String(e);
    }
    loading = false;
  }

  // Load on first render
  $effect(() => {
    void loadData();
  });

  // ── Actions ─────────────────────────────────────────────────────────

  async function handleInstanceAction(
    instanceId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    actionLoading = instanceId;
    overflowOpen = null;
    try {
      await instanceAction(token, instanceId, action);
      await loadData();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        onAuthError();
      } else {
        error = err.message ?? String(e);
      }
    }
    actionLoading = null;
  }

  async function handleDelete(instanceId: string): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    if (!confirm(`Delete instance "${instanceId}"? This cannot be undone.`)) {
      return;
    }
    actionLoading = instanceId;
    overflowOpen = null;
    try {
      await deleteInstance(token, instanceId);
      await loadData();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        onAuthError();
      } else {
        error = err.message ?? String(e);
      }
    }
    actionLoading = null;
  }

  function handleInstanceCreated(): void {
    showNewInstance = false;
    void loadData();
  }

  function handleConfigSaved(): void {
    configuringInstance = null;
    void loadData();
  }

  function toggleOverflow(instanceId: string): void {
    overflowOpen = overflowOpen === instanceId ? null : instanceId;
  }

  function formatCategory(cat: string): string {
    return cat.charAt(0).toUpperCase() + cat.slice(1);
  }

  function statusColor(status: InstanceStatus): string {
    switch (status) {
      case 'running': return 'success';
      case 'stopped': return 'pending';
      case 'error': return 'danger';
      default: return 'pending';
    }
  }

  function statusLabel(status: InstanceStatus): string {
    switch (status) {
      case 'running': return 'Running';
      case 'stopped': return 'Stopped';
      case 'error': return 'Error';
      default: return 'Unknown';
    }
  }
</script>

<!-- Config form overlay -->
{#if configuringInstance}
  <InstanceConfigForm
    instanceId={configuringInstance}
    onSave={handleConfigSaved}
    onCancel={() => { configuringInstance = null; }}
    {onAuthError}
  />
{:else if showNewInstance}
  <NewInstanceDialog
    {components}
    onCreated={handleInstanceCreated}
    onCancel={() => { showNewInstance = false; }}
    {onAuthError}
  />
{:else}
  <div class="panel" role="tabpanel">
    <div class="panel-header">
      <h2>Components</h2>
      <div class="panel-header-actions">
        <button
          class="btn btn-primary btn-sm"
          onclick={() => { showNewInstance = true; }}
          disabled={loading || components.length === 0}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Instance
        </button>
        <button class="btn btn-secondary btn-sm" onclick={() => void loadData()} disabled={loading}>
          {#if loading}
            <span class="spinner"></span>
          {/if}
          Refresh
        </button>
      </div>
    </div>
    <div class="panel-body">
      {#if hasInstances}
        {#each groupedInstances as [category, categoryInstances]}
          <div class="section">
            <h3 class="section-title">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                {#if category === 'messaging'}
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                {:else if category === 'networking'}
                  <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                {:else if category === 'ai'}
                  <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                {:else}
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                {/if}
              </svg>
              {formatCategory(category)}
            </h3>
            <div class="instance-list">
              {#each categoryInstances as instance (instance.id)}
                {@const isActioning = actionLoading === instance.id}
                <div class="instance-row">
                  <div class="instance-info">
                    <span class="instance-name">{instance.id}</span>
                    <span class="instance-component">{instance.component}</span>
                  </div>
                  <div class="instance-status">
                    <span class="status-dot status-dot--{statusColor(instance.status)}"></span>
                    <span class="status-label">{statusLabel(instance.status)}</span>
                  </div>
                  <div class="instance-actions">
                    <button
                      class="btn btn-secondary btn-sm"
                      onclick={() => { configuringInstance = instance.id; }}
                      disabled={isActioning}
                    >
                      Configure
                    </button>
                    {#if instance.status === 'running'}
                      <button
                        class="btn btn-secondary btn-sm"
                        onclick={() => handleInstanceAction(instance.id, 'stop')}
                        disabled={isActioning}
                      >
                        {#if isActioning}<span class="spinner"></span>{/if}
                        Stop
                      </button>
                    {:else}
                      <button
                        class="btn btn-secondary btn-sm"
                        onclick={() => handleInstanceAction(instance.id, 'start')}
                        disabled={isActioning}
                      >
                        {#if isActioning}<span class="spinner"></span>{/if}
                        Start
                      </button>
                    {/if}
                    <div class="overflow-menu-container">
                      <button
                        class="btn btn-icon btn-sm"
                        onclick={() => toggleOverflow(instance.id)}
                        disabled={isActioning}
                        aria-label="More actions for {instance.id}"
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />
                        </svg>
                      </button>
                      {#if overflowOpen === instance.id}
                        <div class="overflow-menu" role="menu">
                          <button
                            class="overflow-item"
                            role="menuitem"
                            onclick={() => handleInstanceAction(instance.id, 'restart')}
                          >
                            Restart
                          </button>
                          <button
                            class="overflow-item overflow-item--danger"
                            role="menuitem"
                            onclick={() => handleDelete(instance.id)}
                          >
                            Delete
                          </button>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      {:else}
        <div class="empty-state">
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
          </svg>
          {#if loading}
            <p>Loading components...</p>
          {:else if error}
            <p class="text-danger">{error}</p>
            <button class="btn btn-secondary btn-sm" onclick={() => void loadData()}>
              Try Again
            </button>
          {:else}
            <p>No component instances found.</p>
            <p class="hint">Click "New Instance" to add a component to your stack.</p>
            <button
              class="btn btn-primary btn-sm"
              onclick={() => { showNewInstance = true; }}
              disabled={components.length === 0}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Instance
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
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

  .panel-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .panel-body {
    padding: var(--space-5);
  }

  /* ── Section ──────────────────────────────────────────────────────── */

  .section {
    margin-bottom: var(--space-6);
  }

  .section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }

  /* ── Instance List ────────────────────────────────────────────────── */

  .instance-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .instance-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .instance-row:hover {
    border-color: var(--color-border-hover);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  }

  .instance-info {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  .instance-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .instance-component {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    white-space: nowrap;
  }

  .instance-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    min-width: 80px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot--success {
    background: var(--color-success);
  }

  .status-dot--danger {
    background: var(--color-danger);
  }

  .status-dot--pending {
    background: var(--color-pending);
  }

  .status-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .instance-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  /* ── Overflow Menu ────────────────────────────────────────────────── */

  .overflow-menu-container {
    position: relative;
  }

  .overflow-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 50;
    min-width: 140px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: var(--space-1) 0;
    margin-top: var(--space-1);
  }

  .overflow-item {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-4);
    text-align: left;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text);
    background: none;
    border: none;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .overflow-item:hover {
    background: var(--color-surface-hover);
  }

  .overflow-item--danger {
    color: var(--color-danger);
  }

  .overflow-item--danger:hover {
    background: var(--color-danger-bg);
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */

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

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
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

  .btn-primary {
    background: var(--color-primary);
    color: #fff;
    border-color: var(--color-primary);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
    border-color: var(--color-primary-hover);
  }

  .btn-icon {
    background: none;
    border: 1px solid var(--color-border);
    padding: 5px 8px;
    color: var(--color-text-secondary);
  }

  .btn-icon:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }

  /* ── Empty State ──────────────────────────────────────────────────── */

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-10) var(--space-4);
    color: var(--color-text-tertiary);
    text-align: center;
    gap: var(--space-4);
  }

  .empty-state p {
    font-size: var(--text-sm);
  }

  .empty-state .btn {
    margin-top: var(--space-2);
  }

  .text-danger {
    color: var(--color-danger);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    max-width: 32ch;
  }

  /* ── Spinner ──────────────────────────────────────────────────────── */

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
    .instance-row {
      flex-wrap: wrap;
    }

    .instance-actions {
      width: 100%;
      justify-content: flex-end;
    }

    .instance-component {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
