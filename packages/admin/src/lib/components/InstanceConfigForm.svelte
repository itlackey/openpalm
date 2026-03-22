<script lang="ts">
  import type { EnvSchemaFieldResponse } from '$lib/types.js';
  import { fetchInstanceSchema, configureInstance } from '$lib/api.js';
  import { getAdminToken } from '$lib/auth.js';

  interface Props {
    instanceId: string;
    onSave: () => void;
    onCancel: () => void;
    onAuthError: () => void;
  }

  let { instanceId, onSave, onCancel, onAuthError }: Props = $props();

  // ── State ───────────────────────────────────────────────────────────
  let fields = $state<EnvSchemaFieldResponse[]>([]);
  let formValues = $state<Record<string, string>>({});
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let saveError = $state('');
  let showSensitive = $state<Record<string, boolean>>({});

  // ── Derived ─────────────────────────────────────────────────────────

  /** Group fields by section */
  let groupedFields = $derived.by(() => {
    const groups = new Map<string, EnvSchemaFieldResponse[]>();
    for (const field of fields) {
      const section = field.section || 'Configuration';
      const list = groups.get(section) ?? [];
      list.push(field);
      groups.set(section, list);
    }
    return [...groups.entries()];
  });

  // ── Load Schema ─────────────────────────────────────────────────────

  $effect(() => {
    const _id = instanceId; // track prop changes
    void loadSchema();
  });

  async function loadSchema(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    loading = true;
    error = '';
    try {
      fields = await fetchInstanceSchema(token, instanceId);
      // Initialize form values from schema defaults
      const values: Record<string, string> = {};
      for (const field of fields) {
        values[field.name] = field.defaultValue ?? '';
      }
      formValues = values;
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

  // ── Save ────────────────────────────────────────────────────────────

  async function handleSave(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      onAuthError();
      return;
    }
    saving = true;
    saveError = '';
    try {
      await configureInstance(token, instanceId, formValues);
      onSave();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 401) {
        onAuthError();
        return;
      }
      saveError = err.message ?? String(e);
    }
    saving = false;
  }

  function toggleSensitive(key: string): void {
    showSensitive = { ...showSensitive, [key]: !showSensitive[key] };
  }

  function handleFieldInput(key: string, event: Event): void {
    const target = event.target as HTMLInputElement;
    formValues = { ...formValues, [key]: target.value };
  }
</script>

<div class="panel" role="dialog" aria-label="Configure {instanceId}">
  <div class="panel-header">
    <h2>{instanceId}</h2>
    <button class="btn btn-secondary btn-sm" onclick={onCancel}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
      Back
    </button>
  </div>
  <div class="panel-body">
    {#if loading}
      <div class="loading-state">
        <span class="spinner"></span>
        <p>Loading configuration...</p>
      </div>
    {:else if error}
      <div class="error-state">
        <p class="text-danger">{error}</p>
        <button class="btn btn-secondary btn-sm" onclick={() => void loadSchema()}>
          Try Again
        </button>
      </div>
    {:else if fields.length === 0}
      <div class="empty-state">
        <p>This component has no configurable fields.</p>
      </div>
    {:else}
      <form onsubmit={(e) => { e.preventDefault(); void handleSave(); }}>
        {#each groupedFields as [section, sectionFields]}
          <div class="form-section">
            <h3 class="form-section-title">{section}</h3>
            {#each sectionFields as field (field.name)}
              <div class="form-field">
                <label class="form-label" for="field-{field.name}">
                  {field.name}
                  {#if field.required}
                    <span class="required-mark" aria-label="required">*</span>
                  {/if}
                  {#if field.sensitive}
                    <span class="sensitive-badge">sensitive</span>
                  {/if}
                </label>
                <div class="field-input-row">
                  {#if field.sensitive}
                    <input
                      id="field-{field.name}"
                      type={showSensitive[field.name] ? 'text' : 'password'}
                      value={formValues[field.name] ?? ''}
                      oninput={(e) => handleFieldInput(field.name, e)}
                      class="form-input"
                      required={field.required}
                      autocomplete="off"
                    />
                    <button
                      type="button"
                      class="btn btn-icon btn-sm"
                      onclick={() => toggleSensitive(field.name)}
                      aria-label={showSensitive[field.name] ? 'Hide value' : 'Show value'}
                    >
                      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        {#if showSensitive[field.name]}
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        {:else}
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        {/if}
                      </svg>
                    </button>
                  {:else}
                    <input
                      id="field-{field.name}"
                      type="text"
                      value={formValues[field.name] ?? ''}
                      oninput={(e) => handleFieldInput(field.name, e)}
                      class="form-input"
                      required={field.required}
                    />
                  {/if}
                </div>
                {#if field.helpText}
                  <p class="form-help">{field.helpText}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/each}

        {#if saveError}
          <div class="save-error">
            <p class="text-danger">{saveError}</p>
          </div>
        {/if}

        <div class="form-actions">
          <button type="button" class="btn btn-secondary" onclick={onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {#if saving}<span class="spinner"></span>{/if}
            Save
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
    font-family: var(--font-mono);
  }

  .panel-body {
    padding: var(--space-5);
  }

  /* ── Form Sections ────────────────────────────────────────────────── */

  .form-section {
    margin-bottom: var(--space-6);
  }

  .form-section:last-of-type {
    margin-bottom: var(--space-4);
  }

  .form-section-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border);
  }

  /* ── Form Fields ──────────────────────────────────────────────────── */

  .form-field {
    margin-bottom: var(--space-4);
  }

  .form-field:last-child {
    margin-bottom: 0;
  }

  .form-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
    margin-bottom: var(--space-1);
    font-family: var(--font-mono);
  }

  .required-mark {
    color: var(--color-danger);
    font-weight: var(--font-bold);
  }

  .sensitive-badge {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    font-weight: var(--font-semibold);
    font-family: var(--font-sans);
    padding: 1px 6px;
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--color-warning-bg);
    color: var(--color-warning);
  }

  .field-input-row {
    display: flex;
    gap: var(--space-2);
  }

  .form-input {
    flex: 1;
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
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    line-height: 1.5;
  }

  /* ── Form Actions ─────────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
  }

  .save-error {
    padding: var(--space-3);
    margin-bottom: var(--space-4);
    background: var(--color-danger-bg);
    border-radius: var(--radius-md);
  }

  /* ── States ───────────────────────────────────────────────────────── */

  .loading-state,
  .error-state,
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

  .loading-state p,
  .error-state p,
  .empty-state p {
    font-size: var(--text-sm);
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

  .text-danger {
    color: var(--color-danger);
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
