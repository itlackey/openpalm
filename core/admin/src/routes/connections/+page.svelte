<script lang="ts">
  import { untrack } from "svelte";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const apiBase = "";

  // ── Form State ──────────────────────────────────────────────────────────
  // LLM Provider Keys (secrets — always empty on load; user types a new value to update)
  let openaiKey = $state("");
  let anthropicKey = $state("");
  let groqKey = $state("");
  let mistralKey = $state("");
  let googleKey = $state("");

  // Guardian LLM Config — pre-seeded from server data (plain text, not secret).
  // untrack() is used to read props without establishing a reactive dependency,
  // since these are one-time initial values for editable inputs.
  let guardianProvider: string = $state(untrack(() => data.connections["GUARDIAN_LLM_PROVIDER"] ?? ""));
  let guardianModel: string = $state(untrack(() => data.connections["GUARDIAN_LLM_MODEL"] ?? ""));

  // OpenMemory Config
  let openMemoryBaseUrl: string = $state(untrack(() => data.connections["OPENMEMORY_OPENAI_BASE_URL"] ?? ""));
  let openMemoryApiKey = $state("");

  // ── UI State ────────────────────────────────────────────────────────────
  let saving = $state(false);
  let saveSuccess = $state(false);
  let saveError = $state("");

  function getAdminToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("openpalm.adminToken");
  }

  function buildPatches(): Record<string, string> {
    const patches: Record<string, string> = {};

    // Only include keys that have a non-empty value (user typed something)
    if (openaiKey.trim()) patches["OPENAI_API_KEY"] = openaiKey.trim();
    if (anthropicKey.trim()) patches["ANTHROPIC_API_KEY"] = anthropicKey.trim();
    if (groqKey.trim()) patches["GROQ_API_KEY"] = groqKey.trim();
    if (mistralKey.trim()) patches["MISTRAL_API_KEY"] = mistralKey.trim();
    if (googleKey.trim()) patches["GOOGLE_API_KEY"] = googleKey.trim();

    // Plain config — always include if set
    if (guardianProvider.trim()) patches["GUARDIAN_LLM_PROVIDER"] = guardianProvider.trim();
    if (guardianModel.trim()) patches["GUARDIAN_LLM_MODEL"] = guardianModel.trim();
    if (openMemoryBaseUrl.trim()) patches["OPENMEMORY_OPENAI_BASE_URL"] = openMemoryBaseUrl.trim();
    if (openMemoryApiKey.trim()) patches["OPENMEMORY_OPENAI_API_KEY"] = openMemoryApiKey.trim();

    return patches;
  }

  async function saveConnections(): Promise<void> {
    const token = getAdminToken();
    if (!token) {
      saveError = "Admin token required. Please sign in from the main console.";
      return;
    }

    const patches = buildPatches();
    if (Object.keys(patches).length === 0) {
      saveError = "No values entered. Fill in at least one field to save.";
      return;
    }

    saving = true;
    saveError = "";
    saveSuccess = false;

    try {
      const res = await fetch(`${apiBase}/admin/connections`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": token,
          "x-requested-by": "ui",
          "x-request-id": crypto.randomUUID()
        },
        body: JSON.stringify(patches)
      });

      if (res.status === 401) {
        saveError = "Invalid admin token.";
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        saveError = body.message ?? "Failed to save connections.";
        return;
      }

      saveSuccess = true;
      // Clear entered secret fields after successful save
      openaiKey = "";
      anthropicKey = "";
      groqKey = "";
      mistralKey = "";
      googleKey = "";
      openMemoryApiKey = "";
    } catch {
      saveError = "Unable to reach admin API.";
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
    saveError = "";
  }
</script>

<svelte:head>
  <title>Connections — OpenPalm Console</title>
</svelte:head>

<main>
  <header class="page-header">
    <div class="header-content">
      <div class="header-nav">
        <a href="/" class="back-link">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Console
        </a>
      </div>
      <h1>Connections</h1>
      <p class="header-subtitle">
        Configure LLM provider API keys and service connection settings.
        Keys are stored in <code>CONFIG_HOME/secrets.env</code> and never overwritten.
      </p>
    </div>
  </header>

  <!-- ── Feedback Messages ───────────────────────────────────────── -->
  {#if saveSuccess}
    <div class="feedback feedback--success" role="status" aria-live="polite">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <span>Connections saved successfully.</span>
      <button class="btn-ghost btn-sm" type="button" aria-label="Dismiss" onclick={dismissSuccess}>
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
      <button class="btn-ghost btn-sm" type="button" aria-label="Dismiss" onclick={dismissError}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  <form onsubmit={handleSubmit} novalidate>
    <!-- ── Section 1: LLM Provider API Keys ───────────────────────── -->
    <section class="panel connections-section">
      <div class="panel-header">
        <h2>LLM Provider API Keys</h2>
        <p class="section-desc">
          Enter a new value to update an existing key. Leave blank to keep the current value.
          Existing values are shown masked.
        </p>
      </div>
      <div class="panel-body">
        <div class="form-grid">

          <div class="form-field">
            <label for="openai-key" class="form-label">
              OpenAI API Key
              {#if data.connections["OPENAI_API_KEY"]}
                <span class="current-value">Current: {data.connections["OPENAI_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="openai-key"
              type="password"
              class="form-input"
              bind:value={openaiKey}
              placeholder="sk-..."
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="anthropic-key" class="form-label">
              Anthropic API Key
              {#if data.connections["ANTHROPIC_API_KEY"]}
                <span class="current-value">Current: {data.connections["ANTHROPIC_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="anthropic-key"
              type="password"
              class="form-input"
              bind:value={anthropicKey}
              placeholder="sk-ant-..."
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="groq-key" class="form-label">
              Groq API Key
              {#if data.connections["GROQ_API_KEY"]}
                <span class="current-value">Current: {data.connections["GROQ_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="groq-key"
              type="password"
              class="form-input"
              bind:value={groqKey}
              placeholder="gsk_..."
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="mistral-key" class="form-label">
              Mistral API Key
              {#if data.connections["MISTRAL_API_KEY"]}
                <span class="current-value">Current: {data.connections["MISTRAL_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="mistral-key"
              type="password"
              class="form-input"
              bind:value={mistralKey}
              placeholder="..."
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="google-key" class="form-label">
              Google API Key
              {#if data.connections["GOOGLE_API_KEY"]}
                <span class="current-value">Current: {data.connections["GOOGLE_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="google-key"
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

    <!-- ── Section 2: Guardian LLM Config ─────────────────────────── -->
    <section class="panel connections-section">
      <div class="panel-header">
        <h2>Guardian LLM Config</h2>
        <p class="section-desc">
          Configure which LLM provider and model the Guardian uses for message routing decisions.
        </p>
      </div>
      <div class="panel-body">
        <div class="form-grid">

          <div class="form-field">
            <label for="guardian-provider" class="form-label">Guardian LLM Provider</label>
            <input
              id="guardian-provider"
              type="text"
              class="form-input"
              bind:value={guardianProvider}
              placeholder="openai"
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="guardian-model" class="form-label">Guardian LLM Model</label>
            <input
              id="guardian-model"
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

    <!-- ── Section 3: OpenMemory Config ───────────────────────────── -->
    <section class="panel connections-section">
      <div class="panel-header">
        <h2>OpenMemory Config</h2>
        <p class="section-desc">
          Configure the OpenAI-compatible endpoint that OpenMemory uses for embeddings.
        </p>
      </div>
      <div class="panel-body">
        <div class="form-grid">

          <div class="form-field">
            <label for="openmemory-url" class="form-label">
              OpenMemory OpenAI Base URL
              {#if data.connections["OPENMEMORY_OPENAI_BASE_URL"]}
                <span class="current-value">Current: {data.connections["OPENMEMORY_OPENAI_BASE_URL"]}</span>
              {/if}
            </label>
            <input
              id="openmemory-url"
              type="url"
              class="form-input"
              bind:value={openMemoryBaseUrl}
              placeholder="https://api.openai.com/v1"
              autocomplete="off"
            />
          </div>

          <div class="form-field">
            <label for="openmemory-key" class="form-label">
              OpenMemory OpenAI API Key
              {#if data.connections["OPENMEMORY_OPENAI_API_KEY"]}
                <span class="current-value">Current: {data.connections["OPENMEMORY_OPENAI_API_KEY"]}</span>
              {/if}
            </label>
            <input
              id="openmemory-key"
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

    <!-- ── Save Button ─────────────────────────────────────────────── -->
    <div class="form-actions">
      <button class="btn btn-primary" type="submit" disabled={saving}>
        {#if saving}
          <span class="spinner"></span>
        {/if}
        Save Connections
      </button>
      <a href="/" class="btn btn-secondary">Cancel</a>
    </div>
  </form>
</main>

<style>
  main {
    max-width: var(--max-width, 1200px);
    margin: 0 auto;
    padding: var(--space-6, 1.5rem) var(--space-4, 1rem);
  }

  .page-header {
    margin-bottom: var(--space-6, 1.5rem);
  }

  .header-nav {
    margin-bottom: var(--space-3, 0.75rem);
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    color: var(--color-text-secondary, #6b7280);
    text-decoration: none;
    font-size: var(--text-sm, 0.8125rem);
    transition: color var(--transition-fast, 120ms ease);
  }

  .back-link:hover {
    color: var(--color-text, #111827);
  }

  .page-header h1 {
    font-size: var(--text-2xl, 1.375rem);
    font-weight: var(--font-bold, 700);
    color: var(--color-text, #111827);
    margin-bottom: var(--space-2, 0.5rem);
  }

  .header-subtitle {
    color: var(--color-text-secondary, #6b7280);
    font-size: var(--text-base, 0.875rem);
  }

  .header-subtitle code {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs, 0.75rem);
    background: var(--color-bg-tertiary, #f3f4f6);
    padding: 0.1em 0.35em;
    border-radius: var(--radius-sm, 6px);
  }

  /* ── Feedback Banners ────────────────────────────────────────────── */

  .feedback {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm, 0.8125rem);
    margin-bottom: var(--space-4, 1rem);
  }

  .feedback span {
    flex: 1;
  }

  .feedback--success {
    background: var(--color-success-bg, rgba(64, 192, 87, 0.1));
    border: 1px solid var(--color-success-border, rgba(64, 192, 87, 0.25));
    color: var(--color-text, #111827);
  }

  .feedback--success svg {
    color: var(--color-success, #40c057);
    flex-shrink: 0;
  }

  .feedback--error {
    background: var(--color-danger-bg, rgba(250, 82, 82, 0.1));
    border: 1px solid var(--color-danger, #fa5252);
    color: var(--color-text, #111827);
  }

  .feedback--error svg {
    color: var(--color-danger, #fa5252);
    flex-shrink: 0;
  }

  /* ── Sections ────────────────────────────────────────────────────── */

  .connections-section {
    margin-bottom: var(--space-6, 1.5rem);
  }

  .panel {
    background: var(--color-surface, #ffffff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-lg, 12px);
    box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.08));
    overflow: hidden;
  }

  .panel-header {
    padding: var(--space-4, 1rem) var(--space-6, 1.5rem);
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    background: var(--color-bg-secondary, #f9fafb);
  }

  .panel-header h2 {
    font-size: var(--text-base, 0.875rem);
    font-weight: var(--font-semibold, 600);
    color: var(--color-text, #111827);
    margin-bottom: var(--space-1, 0.25rem);
  }

  .section-desc {
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text-secondary, #6b7280);
    margin: 0;
  }

  .panel-body {
    padding: var(--space-5, 1.25rem) var(--space-6, 1.5rem);
  }

  /* ── Form Grid ───────────────────────────────────────────────────── */

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-4, 1rem);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }

  .form-label {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    font-size: var(--text-sm, 0.8125rem);
    font-weight: var(--font-medium, 500);
    color: var(--color-text, #111827);
  }

  .current-value {
    font-size: var(--text-xs, 0.75rem);
    font-family: var(--font-mono, monospace);
    color: var(--color-text-tertiary, #9ca3af);
    font-weight: 400;
  }

  .form-input {
    width: 100%;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-base, 0.875rem);
    font-family: var(--font-sans, sans-serif);
    color: var(--color-text, #111827);
    background: var(--color-surface, #ffffff);
    transition:
      border-color var(--transition-fast, 120ms ease),
      box-shadow var(--transition-fast, 120ms ease);
    outline: none;
  }

  .form-input:focus {
    border-color: var(--color-border-focus, #ff9d00);
    box-shadow: 0 0 0 3px var(--color-primary-subtle, rgba(255,157,0,0.08));
  }

  .form-input::placeholder {
    color: var(--color-text-tertiary, #9ca3af);
  }

  /* ── Actions ─────────────────────────────────────────────────────── */

  .form-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    padding-top: var(--space-2, 0.5rem);
  }

  /* ── Buttons (reuse global styles via class names) ────────────────── */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm, 0.8125rem);
    font-weight: var(--font-semibold, 600);
    cursor: pointer;
    border: none;
    text-decoration: none;
    transition: background var(--transition-fast, 120ms ease), color var(--transition-fast, 120ms ease);
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary, #ff9d00);
    color: var(--color-text-inverse, #ffffff);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover, #e68a00);
  }

  .btn-secondary {
    background: var(--color-bg-tertiary, #f3f4f6);
    color: var(--color-text, #111827);
    border: 1px solid var(--color-border, #e5e7eb);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary, #f9fafb);
  }

  .btn-ghost {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: var(--space-1, 0.25rem);
    color: inherit;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm, 6px);
  }

  .btn-ghost:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  .btn-sm {
    font-size: var(--text-xs, 0.75rem);
    padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
  }

  /* ── Spinner ─────────────────────────────────────────────────────── */

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
