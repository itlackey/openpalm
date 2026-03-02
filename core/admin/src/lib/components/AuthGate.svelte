<script lang="ts">
  interface Props {
    onSuccess: (token: string) => void;
    loading: boolean;
    error: string;
  }

  let { onSuccess, loading, error }: Props = $props();

  let tokenInput = $state('');
  let showToken = $state(false);
  let tokenInputEl: HTMLInputElement | undefined = $state();
  let prevError = $state('');

  // Refocus the token input when an auth error appears
  $effect(() => {
    if (error && error !== prevError) {
      prevError = error;
      tokenInputEl?.focus();
      tokenInputEl?.select();
    }
  });

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token || loading) {
      tokenInputEl?.focus();
      return;
    }
    onSuccess(token);
  }
</script>

<main class="auth-gate" aria-label="Admin login gate">
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
        <h1>OpenPalm Console</h1>
        <p>Enter your admin token to unlock the control plane.</p>
      </div>
    </div>

    <form class="auth-form" onsubmit={handleSubmit}>
      <label for="admin-token">Admin Token</label>
      <input type="text" name="username" autocomplete="username" value="admin" class="sr-only" tabindex="-1" aria-hidden="true" />
      <div class="token-input-wrapper">
        <input
          id="admin-token"
          name="admin-token"
          type={showToken ? 'text' : 'password'}
          bind:value={tokenInput}
          bind:this={tokenInputEl}
          placeholder="Enter admin token"
          autocomplete="current-password"
        />
        <button
          type="button"
          class="btn-toggle"
          onclick={() => showToken = !showToken}
          aria-label={showToken ? 'Hide token' : 'Show token'}
        >
          {#if showToken}
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            </svg>
          {:else}
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          {/if}
        </button>
      </div>
      {#if error}
        <p class="auth-error" role="alert">{error}</p>
      {/if}
      <button class="btn btn-primary" type="submit" disabled={loading || !tokenInput.trim()}>
        {#if loading}
          <span class="spinner"></span>
        {/if}
        Unlock Console
      </button>
    </form>
  </section>
</main>

<style>
  .auth-gate {
    min-height: 100vh;
    max-width: none;
    margin: 0;
    display: grid;
    place-items: center;
    padding: var(--space-6);
    background-color: var(--color-bg-secondary);
    background-image: url('/fu.png'),
      radial-gradient(circle at 20% 20%, rgba(20, 184, 166, 0.12), transparent 38%),
      radial-gradient(circle at 85% 0%, rgba(59, 130, 246, 0.12), transparent 32%);
    background-size: contain, auto, auto;
    background-position: bottom left, center, center;
    background-repeat: no-repeat, no-repeat, no-repeat;
  }

  .auth-card {
    width: 100%;
    max-width: 460px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    padding: var(--space-6);
  }

  .auth-brand {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }

  .auth-brand h1 {
    font-size: var(--text-xl);
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

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .token-input-wrapper {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .token-input-wrapper input {
    flex: 1;
  }

  .btn-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: all var(--transition-fast);
  }

  .btn-toggle:hover {
    color: var(--color-text);
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }

  .btn-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }
</style>
