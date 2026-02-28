<script lang="ts">
  import { onMount } from 'svelte';

  // ── Wizard state ────────────────────────────────────────────────────────
  type WizardStep = 'token' | 'llm' | 'openmemory' | 'review';
  let step: WizardStep = $state('token');
  let setupComplete = $state(false);
  let loading = $state(true);

  // ── Form fields ─────────────────────────────────────────────────────────
  let adminToken = $state('');
  let openaiApiKey = $state('');
  let openaiBaseUrl = $state('');
  let openmemoryUserId = $state('default_user');

  // ── Install state ───────────────────────────────────────────────────────
  let installing = $state(false);
  let installError = $state('');
  let startedServices: string[] = $state([]);

  // ── Validation ──────────────────────────────────────────────────────────
  let tokenError = $state('');

  // ── API helpers ─────────────────────────────────────────────────────────

  function buildHeaders(): HeadersInit {
    return {
      'x-requested-by': 'ui',
      'x-request-id': crypto.randomUUID()
    };
  }

  // ── Review display values (from local state only, never from server) ──

  let maskedApiKey = $derived(
    openaiApiKey
      ? openaiApiKey.slice(0, 3) + '...' + openaiApiKey.slice(-4)
      : '(not set)'
  );

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
        body: JSON.stringify({
          adminToken,
          openaiApiKey,
          openaiBaseUrl,
          openmemoryUserId
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        installError = data.message ?? `Install failed (HTTP ${res.status})`;
        return;
      }
      const data = await res.json();
      startedServices = data.started ?? [];
      setupComplete = true;
    } catch {
      installError = 'Network error — unable to reach admin API.';
    } finally {
      installing = false;
    }
  }

  // ── Mount — check if setup already done ─────────────────────────────────

  onMount(() => {
    void (async () => {
      try {
        const res = await fetch('/admin/setup', { headers: buildHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (data.setupComplete) {
            setupComplete = true;
          }
        }
      } catch {
        // best-effort — wizard starts fresh
      } finally {
        loading = false;
      }
    })();
  });
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
</svelte:head>

{#if loading}
  <main class="setup-page" aria-label="Loading">
    <section class="wizard-card">
      <div class="loading-state">
        <span class="spinner"></span>
      </div>
    </section>
  </main>

{:else if setupComplete}
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
        <h1>OpenPalm Setup</h1>
        <p class="wizard-subtitle">Configure your OpenPalm stack in a few steps.</p>
      </div>

      <!-- Step indicators -->
      <nav class="step-indicators" aria-label="Wizard steps">
        <button
          class="step-dot"
          class:active={step === 'token'}
          class:completed={step !== 'token'}
          onclick={() => { step = 'token'; }}
          aria-label="Step 1: Admin Token"
          aria-current={step === 'token' ? 'step' : undefined}
        >1</button>
        <span class="step-line" class:active={step !== 'token'}></span>
        <button
          class="step-dot"
          class:active={step === 'llm'}
          class:completed={step === 'openmemory' || step === 'review'}
          onclick={() => { if (step === 'openmemory' || step === 'review') step = 'llm'; }}
          aria-label="Step 2: LLM Provider"
          aria-current={step === 'llm' ? 'step' : undefined}
        >2</button>
        <span class="step-line" class:active={step === 'openmemory' || step === 'review'}></span>
        <button
          class="step-dot"
          class:active={step === 'openmemory'}
          class:completed={step === 'review'}
          onclick={() => { if (step === 'review') step = 'openmemory'; }}
          aria-label="Step 3: OpenMemory"
          aria-current={step === 'openmemory' ? 'step' : undefined}
        >3</button>
        <span class="step-line" class:active={step === 'review'}></span>
        <button
          class="step-dot"
          class:active={step === 'review'}
          aria-label="Step 4: Review & Install"
          aria-current={step === 'review' ? 'step' : undefined}
          disabled
        >4</button>
      </nav>

      <!-- Step 1: Admin Token -->
      {#if step === 'token'}
        <div class="step-content" data-testid="step-token">
          <h2>Admin Token</h2>
          <div class="field-group">
            <label for="admin-token">Choose an admin token</label>
            <input
              id="admin-token"
              type="password"
              bind:value={adminToken}
              placeholder="Enter a secure admin token"
            />
            <p class="field-hint">This token protects your admin console. Keep it safe — you'll need it to log in.</p>
          </div>
          {#if tokenError}
            <p class="field-error" role="alert">{tokenError}</p>
          {/if}
          <div class="step-actions">
            <button class="btn btn-primary" onclick={() => {
              if (!adminToken.trim()) {
                tokenError = 'Admin token is required.';
                return;
              }
              tokenError = '';
              step = 'llm';
            }}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 2: LLM Provider -->
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
            <button class="btn btn-secondary" onclick={() => (step = 'token')}>Back</button>
            <button class="btn btn-primary" onclick={() => (step = 'openmemory')}>Next</button>
          </div>
        </div>
      {/if}

      <!-- Step 3: OpenMemory -->
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

      <!-- Step 4: Review & Install -->
      {#if step === 'review'}
        <div class="step-content" data-testid="step-review">
          <h2>Review & Install</h2>
          <div class="review-grid">
            <div class="review-item">
              <span class="review-label">Admin Token</span>
              <span class="review-value mono">Set</span>
            </div>
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

  /* ── Loading ─────────────────────────────────────────────────────────── */
  .loading-state {
    display: flex;
    justify-content: center;
    padding: var(--space-8);
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
    width: 36px;
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

  .field-error {
    margin: 0 0 var(--space-2);
    color: var(--color-danger);
    font-size: var(--text-sm);
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
