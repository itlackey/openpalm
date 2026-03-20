<script lang="ts">
  import type { ComponentResponse } from '$lib/types.js';
  import { createInstance } from '$lib/api.js';
  import { getAdminToken } from '$lib/auth.js';

  interface Props {
    components: ComponentResponse[];
    onCreated: () => void;
    onCancel: () => void;
    onAuthError: () => void;
  }

  let { components, onCreated, onCancel, onAuthError }: Props = $props();

  // ── State ───────────────────────────────────────────────────────────
  let selectedComponent = $state<string | null>(null);
  let instanceName = $state('');
  let creating = $state(false);
  let error = $state('');

  // ── Derived ─────────────────────────────────────────────────────────

  /** Group components by category */
  let groupedComponents = $derived.by(() => {
    const groups = new Map<string, ComponentResponse[]>();
    for (const comp of components) {
      const cat = comp.category || 'other';
      const list = groups.get(cat) ?? [];
      list.push(comp);
      groups.set(cat, list);
    }
    const sorted = [...groups.entries()].sort((a, b) => {
      if (a[0] === 'other') return 1;
      if (b[0] === 'other') return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  });

  let selectedComponentDetail = $derived(
    components.find(c => c.id === selectedComponent) ?? null
  );

  /** Default instance name to the component id if user hasn't typed anything */
  let effectiveInstanceName = $derived(
    instanceName.trim() || selectedComponent || ''
  );

  let canCreate = $derived(selectedComponent !== null && effectiveInstanceName.length > 0);

  // ── Handlers ────────────────────────────────────────────────────────

  function selectComponent(id: string): void {
    selectedComponent = id;
    // Default instance name to component id
    instanceName = id;
    error = '';
  }

  async function handleCreate(): Promise<void> {
    if (!canCreate || !selectedComponent) return;
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    creating = true;
    error = '';
    try {
      await createInstance(token, {
        component: selectedComponent,
        name: effectiveInstanceName
      });
      onCreated();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        onAuthError();
        return;
      }
      error = err.message ?? String(e);
    }
    creating = false;
  }

  function formatCategory(cat: string): string {
    return cat.charAt(0).toUpperCase() + cat.slice(1);
  }

  function handleNameInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    // Sanitize: lowercase, alphanumeric + hyphens only
    instanceName = target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  }
</script>

<div class="panel" role="dialog" aria-label="New Instance">
  <div class="panel-header">
    <h2>New Instance</h2>
    <button class="btn btn-secondary btn-sm" onclick={onCancel}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
      Cancel
    </button>
  </div>
  <div class="panel-body">
    {#if !selectedComponent}
      <!-- Step 1: Select component -->
      <p class="step-hint">Select a component to create an instance of:</p>

      {#if components.length === 0}
        <div class="empty-state">
          <p>No components available.</p>
        </div>
      {:else}
        {#each groupedComponents as [category, categoryComponents]}
          <div class="section">
            <h3 class="section-title">{formatCategory(category)}</h3>
            <div class="component-grid">
              {#each categoryComponents as comp (comp.id)}
                <button
                  class="component-card"
                  onclick={() => selectComponent(comp.id)}
                >
                  <div class="card-icon">
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      {#if comp.category === 'messaging'}
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      {:else if comp.category === 'networking'}
                        <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      {:else if comp.category === 'ai'}
                        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                      {:else}
                        <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                      {/if}
                    </svg>
                  </div>
                  <div class="card-text">
                    <span class="card-name">{comp.name || comp.id}</span>
                    {#if comp.description}
                      <span class="card-desc">{comp.description}</span>
                    {/if}
                  </div>
                  <svg class="card-arrow" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      {/if}
    {:else}
      <!-- Step 2: Name the instance -->
      <button class="back-link" onclick={() => { selectedComponent = null; error = ''; }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to component list
      </button>

      {#if selectedComponentDetail}
        <div class="selected-component">
          <span class="selected-label">Component:</span>
          <span class="selected-name">{selectedComponentDetail.name || selectedComponentDetail.id}</span>
          {#if selectedComponentDetail.description}
            <span class="selected-desc">{selectedComponentDetail.description}</span>
          {/if}
        </div>
      {/if}

      <form class="name-form" onsubmit={(e) => { e.preventDefault(); void handleCreate(); }}>
        <div class="form-field">
          <label class="form-label" for="instance-name">Instance Name</label>
          <input
            id="instance-name"
            type="text"
            value={instanceName}
            oninput={handleNameInput}
            class="form-input"
            placeholder="e.g. discord-main"
            required
            autocomplete="off"
            pattern="[a-z0-9][a-z0-9-]*"
          />
          <p class="form-help">
            Lowercase letters, numbers, and hyphens only. This identifies the instance in the stack.
          </p>
        </div>

        {#if error}
          <div class="save-error">
            <p class="text-danger">{error}</p>
          </div>
        {/if}

        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={!canCreate || creating}>
            {#if creating}<span class="spinner"></span>{/if}
            Create Instance
          </button>
        </div>
      </form>
    {/if}
  </div>
</div>

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

  .panel-body {
    padding: var(--space-5);
  }

  .step-hint {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-5);
  }

  /* ── Sections ─────────────────────────────────────────────────────── */

  .section {
    margin-bottom: var(--space-5);
  }

  .section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: var(--space-3);
  }

  /* ── Component Grid ───────────────────────────────────────────────── */

  .component-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .component-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .component-card:hover {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary-subtle);
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    background: var(--color-info-bg);
    color: var(--color-info);
    flex-shrink: 0;
  }

  .card-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .card-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .card-arrow {
    flex-shrink: 0;
    color: var(--color-text-tertiary);
  }

  /* ── Step 2: Name ─────────────────────────────────────────────────── */

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0;
    margin-bottom: var(--space-5);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-primary);
    background: none;
    border: none;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .back-link:hover {
    opacity: 0.8;
  }

  .selected-component {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-5);
  }

  .selected-label {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .selected-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .selected-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .name-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ── Form Fields ──────────────────────────────────────────────────── */

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .form-input {
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--transition-fast);
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .form-help {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    line-height: 1.5;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
  }

  .save-error {
    padding: var(--space-3);
    background: var(--color-danger-bg);
    border-radius: var(--radius-md);
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

  .text-danger {
    color: var(--color-danger);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-10) var(--space-4);
    color: var(--color-text-tertiary);
    text-align: center;
  }

  .empty-state p {
    font-size: var(--text-sm);
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

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
