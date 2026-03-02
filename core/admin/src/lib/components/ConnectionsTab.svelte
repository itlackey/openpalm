<script lang="ts">
  import { getAdminToken } from '$lib/auth.js';

  interface Props {
    connections: Record<string, string>;
    loading: boolean;
    onRefresh: () => void;
  }

  let { connections, loading, onRefresh }: Props = $props();

  // ── Form State ──────────────────────────────────────────────────────────
  // LLM Provider Keys (secrets — always empty on load; user types a new value to update)
  let openaiKey = $state('');
  let anthropicKey = $state('');
  let groqKey = $state('');
  let mistralKey = $state('');
  let googleKey = $state('');

  // Guardian LLM Config — pre-seeded from loaded data
  let guardianProvider: string = $state('');
  let guardianModel: string = $state('');

  // OpenMemory Config
  let openMemoryBaseUrl: string = $state('');
  let openMemoryApiKey = $state('');

  // Sync plain-text config fields when connections data arrives
  let lastSyncedConnections: Record<string, string> | null = $state(null);
  $effect(() => {
    if (connections && connections !== lastSyncedConnections) {
      lastSyncedConnections = connections;
      guardianProvider = connections['GUARDIAN_LLM_PROVIDER'] ?? '';
      guardianModel = connections['GUARDIAN_LLM_MODEL'] ?? '';
      openMemoryBaseUrl = connections['OPENMEMORY_OPENAI_BASE_URL'] ?? '';
    }
  });

  // ── UI State ────────────────────────────────────────────────────────────
  let saving = $state(false);
  let saveSuccess = $state(false);
  let saveError = $state('');

  function buildPatches(): Record<string, string> {
    const patches: Record<string, string> = {};

    if (openaiKey.trim()) patches['OPENAI_API_KEY'] = openaiKey.trim();
    if (anthropicKey.trim()) patches['ANTHROPIC_API_KEY'] = anthropicKey.trim();
    if (groqKey.trim()) patches['GROQ_API_KEY'] = groqKey.trim();
    if (mistralKey.trim()) patches['MISTRAL_API_KEY'] = mistralKey.trim();
    if (googleKey.trim()) patches['GOOGLE_API_KEY'] = googleKey.trim();

    if (guardianProvider.trim()) patches['GUARDIAN_LLM_PROVIDER'] = guardianProvider.trim();
    if (guardianModel.trim()) patches['GUARDIAN_LLM_MODEL'] = guardianModel.trim();
    if (openMemoryBaseUrl.trim()) patches['OPENMEMORY_OPENAI_BASE_URL'] = openMemoryBaseUrl.trim();
    if (openMemoryApiKey.trim()) patches['OPENMEMORY_OPENAI_API_KEY'] = openMemoryApiKey.trim();

    return patches;
  }

  async function saveConnections(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      saveError = 'Admin token required. Please sign in from the main console.';
      return;
    }

    const patches = buildPatches();
    if (Object.keys(patches).length === 0) {
      saveError = 'No values entered. Fill in at least one field to save.';
      return;
    }

    saving = true;
    saveError = '';
    saveSuccess = false;

    try {
      const res = await fetch('/admin/connections', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token,
          'x-requested-by': 'ui',
          'x-request-id': crypto.randomUUID()
        },
        body: JSON.stringify(patches)
      });

      if (res.status === 401) {
        saveError = 'Invalid admin token.';
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        saveError = body.message ?? 'Failed to save connections.';
        return;
      }

      saveSuccess = true;
      // Clear entered secret fields after successful save
      openaiKey = '';
      anthropicKey = '';
      groqKey = '';
      mistralKey = '';
      googleKey = '';
      openMemoryApiKey = '';
      // Refresh data to show updated masked values
      onRefresh();
    } catch {
      saveError = 'Unable to reach admin API.';
    } finally {
      saving = false;
    }
  }

  function handleSubmit(e: SubmitEvent): void {
    e.preventDefault();
    void saveConnections();
  }

  function dismissSuccess(): void {
    saveSuccess = false;
  }

  function dismissError(): void {
    saveError = '';
  }
</script>

<section class="connections-tab" aria-label="Connections configuration">
  <div class="tab-header">
    <div class="tab-header-text">
      <h2>Connections</h2>
      <p class="tab-subtitle">
        Configure LLM provider API keys and service connection settings.
        Keys are stored in <code>CONFIG_HOME/secrets.env</code> and never overwritten.
      </p>
    </div>
    <button
      class="btn btn-ghost"
      type="button"
      disabled={loading}
      onclick={onRefresh}
      aria-label="Refresh connections"
    >
      <svg class:spin={loading} aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  </div>

  {#if loading}
    <div class="loading-state">
      <span class="spinner"></span>
      <span>Loading connections...</span>
    </div>
  {:else}
    <!-- ── Feedback Messages ─────────────────────────────────────── -->
    {#if saveSuccess}
      <div class="feedback feedback--success" role="status" aria-live="polite">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Connections saved successfully.</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissSuccess}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    {#if saveError}
      <div class="feedback feedback--error" role="alert" aria-live="assertive">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{saveError}</span>
        <button class="btn-dismiss" type="button" aria-label="Dismiss" onclick={dismissError}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {/if}

    <form onsubmit={handleSubmit} novalidate>
      <!-- ── Section 1: LLM Provider API Keys ────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>LLM Provider API Keys</h3>
          <p class="section-desc">
            Enter a new value to update an existing key. Leave blank to keep the current value.
            Existing values are shown masked.
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-openai-key" class="form-label">
                OpenAI API Key
                {#if connections['OPENAI_API_KEY']}
                  <span class="current-value">Current: {connections['OPENAI_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-openai-key"
                type="password"
                class="form-input"
                bind:value={openaiKey}
                placeholder="sk-..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-anthropic-key" class="form-label">
                Anthropic API Key
                {#if connections['ANTHROPIC_API_KEY']}
                  <span class="current-value">Current: {connections['ANTHROPIC_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-anthropic-key"
                type="password"
                class="form-input"
                bind:value={anthropicKey}
                placeholder="sk-ant-..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-groq-key" class="form-label">
                Groq API Key
                {#if connections['GROQ_API_KEY']}
                  <span class="current-value">Current: {connections['GROQ_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-groq-key"
                type="password"
                class="form-input"
                bind:value={groqKey}
                placeholder="gsk_..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-mistral-key" class="form-label">
                Mistral API Key
                {#if connections['MISTRAL_API_KEY']}
                  <span class="current-value">Current: {connections['MISTRAL_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-mistral-key"
                type="password"
                class="form-input"
                bind:value={mistralKey}
                placeholder="..."
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-google-key" class="form-label">
                Google API Key
                {#if connections['GOOGLE_API_KEY']}
                  <span class="current-value">Current: {connections['GOOGLE_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-google-key"
                type="password"
                class="form-input"
                bind:value={googleKey}
                placeholder="AIza..."
                autocomplete="off"
              />
            </div>

          </div>
        </div>
      </section>

      <!-- ── Section 2: Guardian LLM Config ──────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>Guardian LLM Config</h3>
          <p class="section-desc">
            Configure which LLM provider and model the Guardian uses for message routing decisions.
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-guardian-provider" class="form-label">Guardian LLM Provider</label>
              <input
                id="conn-guardian-provider"
                type="text"
                class="form-input"
                bind:value={guardianProvider}
                placeholder="openai"
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-guardian-model" class="form-label">Guardian LLM Model</label>
              <input
                id="conn-guardian-model"
                type="text"
                class="form-input"
                bind:value={guardianModel}
                placeholder="gpt-4o-mini"
                autocomplete="off"
              />
            </div>

          </div>
        </div>
      </section>

      <!-- ── Section 3: OpenMemory Config ────────────────────────── -->
      <section class="panel connections-section">
        <div class="panel-header">
          <h3>OpenMemory Config</h3>
          <p class="section-desc">
            Configure the OpenAI-compatible endpoint that OpenMemory uses for embeddings.
          </p>
        </div>
        <div class="panel-body">
          <div class="form-grid">

            <div class="form-field">
              <label for="conn-openmemory-url" class="form-label">
                OpenMemory OpenAI Base URL
                {#if connections['OPENMEMORY_OPENAI_BASE_URL']}
                  <span class="current-value">Current: {connections['OPENMEMORY_OPENAI_BASE_URL']}</span>
                {/if}
              </label>
              <input
                id="conn-openmemory-url"
                type="url"
                class="form-input"
                bind:value={openMemoryBaseUrl}
                placeholder="https://api.openai.com/v1"
                autocomplete="off"
              />
            </div>

            <div class="form-field">
              <label for="conn-openmemory-key" class="form-label">
                OpenMemory OpenAI API Key
                {#if connections['OPENMEMORY_OPENAI_API_KEY']}
                  <span class="current-value">Current: {connections['OPENMEMORY_OPENAI_API_KEY']}</span>
                {/if}
              </label>
              <input
                id="conn-openmemory-key"
                type="password"
                class="form-input"
                bind:value={openMemoryApiKey}
                placeholder="sk-..."
                autocomplete="off"
              />
            </div>

          </div>
        </div>
      </section>

      <!-- ── Save Button ─────────────────────────────────────────── -->
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {#if saving}
            <span class="spinner"></span>
          {/if}
          Save Connections
        </button>
      </div>
    </form>
  {/if}
</section>

<style>
  .connections-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .tab-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .tab-header-text h2 {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .tab-subtitle {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0;
  }

  .tab-subtitle code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-bg-tertiary);
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm);
  }

  /* ── Loading ──────────────────────────────────────────────────── */

  .loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  /* ── Feedback Banners ────────────────────────────────────────── */

  .feedback {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }

  .feedback span {
    flex: 1;
  }

  .feedback--success {
    background: var(--color-success-bg, rgba(64, 192, 87, 0.1));
    border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.25));
    color: var(--color-text);
  }

  .feedback--success svg {
    color: var(--color-success, #40c057);
    flex-shrink: 0;
  }

  .feedback--error {
    background: var(--color-danger-bg, rgba(250, 82, 82, 0.1));
    border: 1px solid var(--color-danger, #fa5252);
    color: var(--color-text);
  }

  .feedback--error svg {
    color: var(--color-danger, #fa5252);
    flex-shrink: 0;
  }

  .btn-dismiss {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: var(--space-1);
    color: inherit;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }

  .btn-dismiss:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  /* ── Sections ────────────────────────────────────────────────── */

  .connections-section {
    margin-bottom: var(--space-4);
  }

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }

  .panel-header {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
  }

  .panel-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-1);
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .panel-body {
    padding: var(--space-5);
  }

  /* ── Form Grid ───────────────────────────────────────────────── */

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-4);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .form-label {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text);
  }

  .current-value {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
    font-weight: 400;
  }

  .form-input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-family: var(--font-sans);
    color: var(--color-text);
    background: var(--color-surface);
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
    outline: none;
  }

  .form-input:focus {
    border-color: var(--color-border-focus, #ff9d00);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .form-input::placeholder {
    color: var(--color-text-tertiary);
  }

  /* ── Actions ─────────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-top: var(--space-2);
  }

  /* ── Buttons ─────────────────────────────────────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    cursor: pointer;
    border: none;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary);
    color: var(--color-text-inverse);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    padding: var(--space-2);
    border-radius: var(--radius-md);
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--color-text);
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }

  /* ── Spinner ─────────────────────────────────────────────────── */

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .spin {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 768px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
