<script lang="ts">
  import type { CanonicalConnectionProfileDto, ConnectionProfilePayload } from '$lib/types.js';

  interface Props {
    /** Populate for edit mode; omit (or pass null) for create mode. */
    initial: CanonicalConnectionProfileDto | null;
    /** Whether a "Test connection" operation is in flight. */
    testLoading: boolean;
    /** Model list populated after a successful test. */
    modelList: string[];
    /** Error string from the last test attempt; empty string = no error. */
    testError: string;
    /** Whether the last test succeeded. */
    connectionTested: boolean;
    /** Emitted when the user submits the form (create or save). */
    onSave: (payload: ConnectionProfilePayload) => void;
    /** Emitted when the user clicks "Cancel". */
    onCancel: () => void;
    /** Emitted when the user clicks "Test connection". */
    onTest: (draft: { baseUrl: string; apiKey: string; kind: string }) => void;
  }

  let {
    initial,
    testLoading,
    modelList,
    testError,
    connectionTested,
    onSave,
    onCancel,
    onTest,
  }: Props = $props();

  // ── Form fields ──────────────────────────────────────────────────
  let id = $state('');
  let name = $state('');
  let kind = $state<'openai_compatible_remote' | 'openai_compatible_local'>('openai_compatible_remote');
  let provider = $state('openai');
  let baseUrl = $state('');
  let requiresKey = $state(false);
  let apiKey = $state('');

  // ── Validation ───────────────────────────────────────────────────
  let nameError = $state('');
  let baseUrlError = $state('');
  let apiKeyError = $state('');

  // ── Derived ──────────────────────────────────────────────────────
  let isLocal = $derived(kind === 'openai_compatible_local');
  let baseUrlPlaceholder = $derived(
    isLocal ? 'http://localhost:1234' : 'https://api.example.com'
  );
  let showV1Warning = $derived(
    /\/v1\/?$/.test(baseUrl.trim())
  );

  // ── Initialize from initial prop ─────────────────────────────────
  $effect(() => {
    if (initial) {
      id = initial.id;
      name = initial.name;
      kind = initial.kind as 'openai_compatible_remote' | 'openai_compatible_local';
      provider = initial.provider;
      baseUrl = initial.baseUrl;
      requiresKey = initial.auth.mode === 'api_key';
      apiKey = ''; // never pre-fill the raw key
    } else {
      id = '';
      name = '';
      kind = 'openai_compatible_remote';
      provider = 'openai';
      baseUrl = '';
      requiresKey = false;
      apiKey = '';
      nameError = '';
      baseUrlError = '';
      apiKeyError = '';
    }
  });

  // ── Validation ───────────────────────────────────────────────────
  function isValidHttpUrl(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const url = new URL(trimmed);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function validate(): boolean {
    const trimmedApiKey = apiKey.trim();
    const existingSecretRef = initial?.auth.mode === 'api_key'
      ? initial.auth.apiKeySecretRef
      : undefined;
    nameError = name.trim() ? '' : 'Connection name is required.';
    baseUrlError =
      baseUrl.trim() === '' || isValidHttpUrl(baseUrl) ? '' : 'Enter a valid URL.';
    apiKeyError = requiresKey && !trimmedApiKey && !existingSecretRef
      ? 'API key is required for keyed connections.'
      : '';
    return !nameError && !baseUrlError && !apiKeyError;
  }

  // ── Submit handler ───────────────────────────────────────────────
  function handleSubmit(e: SubmitEvent): void {
    e.preventDefault();
    if (!validate()) return;
    const trimmedApiKey = apiKey.trim();
    const existingSecretRef = initial?.auth.mode === 'api_key'
      ? initial.auth.apiKeySecretRef
      : undefined;
    const payload: ConnectionProfilePayload = {
      id: id || crypto.randomUUID().slice(0, 8),
      name: name.trim(),
      kind,
      provider,
      baseUrl: baseUrl.trim(),
      auth: requiresKey
        ? {
            mode: 'api_key',
            ...(existingSecretRef ? { apiKeySecretRef: existingSecretRef } : {}),
          }
        : {
            mode: 'none',
          },
      apiKey: requiresKey && trimmedApiKey ? trimmedApiKey : undefined,
    };
    onSave(payload);
    apiKey = ''; // clear secret after save
  }
</script>

<form onsubmit={handleSubmit} novalidate class="conn-form">
  <!-- Connection name -->
  <div class="form-field">
    <label for="cf-name" class="form-label">Connection name</label>
    <input
      id="cf-name"
      type="text"
      class="form-input"
      bind:value={name}
      placeholder="e.g. OpenAI Production"
      autocomplete="off"
    />
    {#if nameError}
      <span class="field-error">{nameError}</span>
    {/if}
  </div>

  <!-- Kind selector -->
  <div class="form-field">
    <label for="cf-kind" class="form-label">Type</label>
    <select id="cf-kind" class="form-input" bind:value={kind}>
      <option value="openai_compatible_remote">Remote OpenAI-compatible</option>
      <option value="openai_compatible_local">Local OpenAI-compatible</option>
    </select>
  </div>

  <!-- Provider -->
  <div class="form-field">
    <label for="cf-provider" class="form-label">Provider</label>
    <input
      id="cf-provider"
      type="text"
      class="form-input"
      bind:value={provider}
      placeholder="openai"
      autocomplete="off"
    />
    <span class="field-hint">Provider identifier (e.g. openai, anthropic, ollama).</span>
  </div>

  <!-- Base URL -->
  <div class="form-field">
    <label for="cf-base-url" class="form-label">Base URL</label>
    <input
      id="cf-base-url"
      type="url"
      class="form-input"
      bind:value={baseUrl}
      placeholder={baseUrlPlaceholder}
      autocomplete="off"
    />
    <span class="field-hint">Enter the server base URL without <code>/v1</code>; OpenPalm adds it automatically when needed.</span>
    {#if showV1Warning}
      <span class="field-warn">Remove the trailing <code>/v1</code> to avoid generating <code>/v1/v1</code> requests.</span>
    {/if}
    {#if baseUrlError}
      <span class="field-error">{baseUrlError}</span>
    {/if}
  </div>

  <!-- Auth toggle -->
  <div class="form-field">
    <label class="form-label auth-toggle">
      <input type="checkbox" bind:checked={requiresKey} />
      This endpoint requires an API key
    </label>
    {#if requiresKey}
      <input
        type="password"
        class="form-input"
        bind:value={apiKey}
        placeholder="Paste API key"
        autocomplete="off"
      />
      <span class="field-hint">Your key will be stored securely.</span>
      {#if apiKeyError}
        <span class="field-error">{apiKeyError}</span>
      {/if}
    {/if}
  </div>

  <!-- Test connection row -->
  <div class="test-connection-row">
    <button
      class="btn btn-outline"
      type="button"
      disabled={testLoading || !baseUrl.trim()}
      onclick={() => onTest({ baseUrl, apiKey, kind })}
    >
      {#if testLoading}
        <span class="spinner"></span>
        Testing...
      {:else}
        Test connection
      {/if}
    </button>
    {#if connectionTested}
      <span class="connection-success" role="status">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        Connected{modelList.length > 0 ? ` — ${modelList.length} model${modelList.length !== 1 ? 's' : ''} found.` : '.'}
      </span>
    {/if}
    {#if testError}
      <span class="field-error">{testError}</span>
    {/if}
  </div>

  <!-- Form actions -->
  <div class="form-actions">
    <button class="btn btn-primary" type="submit">
      Save connection
    </button>
    <button class="btn btn-ghost" type="button" onclick={onCancel}>
      Cancel
    </button>
  </div>
</form>

<style>
  .conn-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .form-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }

  .auth-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
  }

  .form-input {
    width: 100%;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 12px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: inherit;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle, rgba(80, 200, 120, 0.15));
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }

  .field-hint code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .field-error {
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .field-warn {
    font-size: var(--text-xs);
    color: var(--color-warning, #b45309);
  }

  .field-warn code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  /* ── Test Connection ─────────────────────────────────────────── */

  .test-connection-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .connection-success {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  /* ── Form Actions ────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    gap: var(--space-3);
    padding-top: var(--space-2);
  }

  /* ── Buttons ─────────────────────────────────────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 20px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
    justify-content: center;
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

  .btn-outline {
    background: transparent;
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .btn-outline:hover:not(:disabled) {
    background: var(--color-primary-subtle, rgba(80, 200, 120, 0.08));
  }

  .btn-ghost {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  /* ── Spinner ─────────────────────────────────────────────────── */

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
