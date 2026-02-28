<script lang="ts">
  import { onMount } from 'svelte';
  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';

  // ── Auth state ──────────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // ── Wizard state ────────────────────────────────────────────────────────
  type WizardStep = 'llm' | 'openmemory' | 'review';
  let step: WizardStep = $state('llm');
  let installed = $state(false);

  // ── Form fields ─────────────────────────────────────────────────────────
  let openaiApiKey = $state('');
  let openaiBaseUrl = $state('');
  let openmemoryUserId = $state('default_user');

  // ── Install state ───────────────────────────────────────────────────────
  let installing = $state(false);
  let installError = $state('');
  let startedServices: string[] = $state([]);

  // ── API helpers ─────────────────────────────────────────────────────────

  function buildHeaders(): HeadersInit {
    const token = getAdminToken();
    return {
      'x-admin-token': token ?? '',
      'x-requested-by': 'ui',
      'x-request-id': crypto.randomUUID()
    };
  }

  async function loadSetupConfig(): Promise<void> {
    try {
      const res = await fetch('/admin/setup', { headers: buildHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      openaiApiKey = data.openaiApiKey ?? '';
      openaiBaseUrl = data.openaiBaseUrl ?? '';
      openmemoryUserId = data.openmemoryUserId ?? 'default_user';
      installed = data.installed === true;
    } catch {
      // best-effort — wizard starts with defaults
    }
  }

  // ── Masked display value ────────────────────────────────────────────────

  let maskedApiKey = $derived(
    openaiApiKey
      ? '*'.repeat(Math.max(0, openaiApiKey.length - 4)) + openaiApiKey.slice(-4)
      : '(not set)'
  );

  // ── Auth handler ────────────────────────────────────────────────────────

  async function handleAuthSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const input = (document.getElementById('setup-admin-token') as HTMLInputElement)?.value?.trim();
    if (!input || authLoading) return;
    authLoading = true;
    authError = '';
    try {
      const result = await validateToken(input);
      if (!result.allowed) {
        authError = 'Invalid admin token.';
        return;
      }
      storeToken(input);
      authLocked = false;
      await loadSetupConfig();
    } catch {
      authError = 'Unable to reach admin API.';
    } finally {
      authLoading = false;
    }
  }

  // ── Install handler ─────────────────────────────────────────────────────

  async function handleInstall(): Promise<void> {
    if (installing) return;
    installing = true;
    installError = '';
    try {
      const res = await fetch('/admin/setup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...buildHeaders()
        },
        body: JSON.stringify({ openaiApiKey, openaiBaseUrl, openmemoryUserId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        installError = data.message ?? `Install failed (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      startedServices = data.started ?? [];
      installed = true;
    } catch {
      installError = 'Network error — unable to reach admin API.';
    } finally {
      installing = false;
    }
  }

  // ── Mount ───────────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      const token = getAdminToken();
      if (!token) {
        authLocked = true;
        return;
      }
      authLoading = true;
      try {
        const result = await validateToken(token);
        if (!result.allowed) {
          clearToken();
          authLocked = true;
          authError = 'Stored token is invalid.';
          return;
        }
        authLocked = false;
        await loadSetupConfig();
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
  <title>OpenPalm Setup</title>
</svelte:head>

{#if authLocked}
  <!-- Auth Gate -->
  <main class="auth-gate" aria-label="Setup login gate">
    <section class="auth-card">
      <div class="auth-brand">
        <span class="brand-icon">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </span>
        <div>
          <h1>OpenPalm Setup</h1>
          <p>Enter your admin token to begin setup.</p>
        </div>
      </div>

      <form class="auth-form" onsubmit={handleAuthSubmit}>
        <label for="setup-admin-token">Admin Token</label>
        <input
          id="setup-admin-token"
          name="admin-token"
          type="password"
          placeholder="Enter admin token"
          autocomplete="current-password"
        />
        {#if authError}
          <p class="auth-error" role="alert">{authError}</p>
        {/if}
        <button class="btn btn-primary" type="submit" disabled={authLoading}>
          {#if authLoading}
            <span class="spinner"></span>
          {/if}
          Continue
        </button>
      </form>
    </section>
  </main>

{:else if installed}
  <!-- Done state -->
  <main class="setup-page" aria-label="Setup complete">
    <section class="wizard-card">
      <div class="done-state">
        <span class="done-icon" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </span>
        <h2>Stack Installed</h2>
        <p class="done-subtitle">All services are up and running.</p>

        {#if startedServices.length > 0}
          <ul class="service-list" aria-label="Started services">
            {#each startedServices as service}
              <li>{service}</li>
            {/each}
          </ul>
        {/if}

        <a href="/" class="btn btn-primary console-link">Go to Console</a>
      </div>
    </section>
  </main>

{:else}
  <!-- Wizard -->
  <main class="setup-page" aria-label="Setup wizard">
    <section class="wizard-card">
      <div class="wizard-header">
        <h1>Setup Wizard</h1>
        <p class="wizard-subtitle">Configure your OpenPalm stack in a few steps.</p>
      </div>

      <!-- Step indicators -->
      <nav class="step-indicators" aria-label="Wizard steps">
        <button
          class="step-dot"
          class:active={step === 'llm'}
          class:completed={step === 'openmemory' || step === 'review'}
          onclick={() => { if (step !== 'llm') step = 'llm'; }}
          aria-label="Step 1: LLM Provider"
          aria-current={step === 'llm' ? 'step' : undefined}
        >1</button>
        <span class="step-line" class:active={step === 'openmemory' || step === 'review'}></span>
        <button
          class="step-dot"
          class:active={step === 'openmemory'}
          class:completed={step === 'review'}
          onclick={() => { if (step === 'review') step = 'openmemory'; }}
          aria-label="Step 2: OpenMemory"
          aria-current={step === 'openmemory' ? 'step' : undefined}
        >2</button>
        <span class="step-line" class:active={step === 'review'}></span>
        <button
          class="step-dot"
          class:active={step === 'review'}
          aria-label="Step 3: Review & Install"
          aria-current={step === 'review' ? 'step' : undefined}
          disabled
        >3</button>
      </nav>

      <!-- Step 1: LLM Provider -->
      {#if step === 'llm'}
        <div class="step-content" data-testid="step-llm">
          <h2>LLM Provider</h2>
          <div class="field-group">
            <label for="openai-api-key">OpenAI API Key</label>
            <input
              id="openai-api-key"
              type="password"
              bind:value={openaiApiKey}
              placeholder="sk-... (leave empty to configure later)"
            />
            <p class="field-hint">Required for OpenMemory embeddings. Can be added later via secrets.env.</p>
          </div>
          <div class="field-group">
            <label for="openai-base-url">OpenAI Base URL</label>
            <input
              id="openai-base-url"
              type="url"
              bind:value={openaiBaseUrl}
              placeholder="https://api.openai.com/v1 (default if empty)"
            />
            <p class="field-hint">For Ollama: <code>http://host.docker.internal:11434/v1</code></p>
          </div>
          <div class="step-actions">
            <button class="btn btn-primary" onclick={() => (step = 'openmemory')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 2: OpenMemory -->
      {#if step === 'openmemory'}
        <div class="step-content" data-testid="step-openmemory">
          <h2>OpenMemory</h2>
          <div class="field-group">
            <label for="openmemory-user-id">User ID</label>
            <input
              id="openmemory-user-id"
              type="text"
              bind:value={openmemoryUserId}
              placeholder="default_user"
            />
            <p class="field-hint">Identifies the memory owner. Use a unique name if running multiple instances.</p>
          </div>
          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'llm')}>Back</button>
            <button class="btn btn-primary" onclick={() => (step = 'review')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 3: Review & Install -->
      {#if step === 'review'}
        <div class="step-content" data-testid="step-review">
          <h2>Review & Install</h2>
          <div class="review-grid">
            <div class="review-item">
              <span class="review-label">OpenAI API Key</span>
              <span class="review-value mono">{maskedApiKey}</span>
            </div>
            <div class="review-item">
              <span class="review-label">OpenAI Base URL</span>
              <span class="review-value mono">{openaiBaseUrl || '(default)'}</span>
            </div>
            <div class="review-item">
              <span class="review-label">OpenMemory User ID</span>
              <span class="review-value">{openmemoryUserId}</span>
            </div>
          </div>

          {#if installError}
            <p class="install-error" role="alert">{installError}</p>
          {/if}

          <div class="step-actions">
            <button class="btn btn-secondary" onclick={() => (step = 'openmemory')} disabled={installing}>Back</button>
            <button class="btn btn-primary" onclick={handleInstall} disabled={installing}>
              {#if installing}
                <span class="spinner"></span>
                Installing...
              {:else}
                Install Stack
              {/if}
            </button>
          </div>

          {#if installing}
            <p class="install-progress">Pulling container images and starting services...</p>
          {/if}
        </div>
      {/if}
    </section>
  </main>
{/if}

<style>
  /* ── Auth Gate ────────────────────────────────────────────────────────── */
  .auth-gate {
    min-height: 100vh;
    max-width: none;
    margin: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6);
    background: radial-gradient(circle at 20% 20%, rgba(20, 184, 166, 0.12), transparent 38%),
      radial-gradient(circle at 85% 0%, rgba(59, 130, 246, 0.12), transparent 32%),
      var(--color-bg-secondary);
  }

  .auth-card {
    width: 100%;
    max-width: 460px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    padding: var(--space-6);
  }

  .auth-brand {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .auth-brand h1 {
    font-size: 1.25rem;
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }

  .auth-brand p {
    margin-top: 4px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    background: var(--color-primary);
    color: var(--color-text-inverse);
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }

  .auth-form {
    display: grid;
    gap: var(--space-3);
  }

  .auth-form label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }

  .auth-form input {
    width: 100%;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 12px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .auth-form input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .auth-error {
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  /* ── Setup Page ──────────────────────────────────────────────────────── */
  .setup-page {
    min-height: 100vh;
    max-width: none;
    margin: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6);
    background: var(--color-bg-secondary);
  }

  .wizard-card {
    width: 100%;
    max-width: 560px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    padding: var(--space-8);
  }

  .wizard-header {
    margin-bottom: var(--space-6);
  }

  .wizard-header h1 {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
  }

  .wizard-subtitle {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ── Step Indicators ─────────────────────────────────────────────────── */
  .step-indicators {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: var(--space-6);
  }

  .step-dot {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: default;
    transition: all var(--transition-fast);
  }

  .step-dot.active {
    border-color: var(--color-primary);
    background: var(--color-primary);
    color: #000;
  }

  .step-dot.completed {
    border-color: var(--color-success);
    background: var(--color-success);
    color: #fff;
    cursor: pointer;
  }

  .step-line {
    width: 48px;
    height: 2px;
    background: var(--color-border);
    transition: background var(--transition-fast);
  }

  .step-line.active {
    background: var(--color-success);
  }

  /* ── Step Content ────────────────────────────────────────────────────── */
  .step-content h2 {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--color-text);
    margin-bottom: var(--space-4);
  }

  .field-group {
    margin-bottom: var(--space-4);
  }

  .field-group label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-1);
  }

  .field-group input {
    width: 100%;
    height: 40px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 12px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .field-group input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  .field-hint {
    margin-top: var(--space-1);
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

  /* ── Step Actions ────────────────────────────────────────────────────── */
  .step-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  /* ── Review Grid ─────────────────────────────────────────────────────── */
  .review-grid {
    display: grid;
    gap: var(--space-3);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .review-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
  }

  .review-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .review-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    text-align: right;
    word-break: break-all;
  }

  .review-value.mono {
    font-family: var(--font-mono);
  }

  /* ── Install State ───────────────────────────────────────────────────── */
  .install-error {
    margin-top: var(--space-3);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }

  .install-progress {
    margin-top: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-align: center;
  }

  /* ── Done State ──────────────────────────────────────────────────────── */
  .done-state {
    text-align: center;
    padding: var(--space-4) 0;
  }

  .done-icon {
    display: inline-block;
    margin-bottom: var(--space-4);
  }

  .done-state h2 {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .done-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin-bottom: var(--space-5);
  }

  .service-list {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    margin-bottom: var(--space-6);
  }

  .service-list li {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-success-bg);
    color: var(--color-success);
    border: 1px solid var(--color-success-border);
    padding: 2px 10px;
    border-radius: var(--radius-full);
  }

  .console-link {
    display: inline-flex;
    text-decoration: none;
  }

  /* ── Shared Button Styles ────────────────────────────────────────────── */
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

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
    border-color: var(--color-border-hover);
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

  @media (max-width: 480px) {
    .wizard-card {
      padding: var(--space-5);
    }

    .review-item {
      flex-direction: column;
      align-items: flex-start;
    }

    .review-value {
      text-align: left;
    }
  }
</style>
