<script lang="ts">
  interface Props {
    onSuccess: (token: string) => void;
    loading: boolean;
    error: string;
  }

  let { onSuccess, loading, error }: Props = $props();

  let tokenInput = $state('');

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token || loading) return;
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
      <input
        id="admin-token"
        name="admin-token"
        type="password"
        bind:value={tokenInput}
        placeholder="Enter admin token"
        autocomplete="current-password"
      />
      {#if error}
        <p class="auth-error">{error}</p>
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
    background: radial-gradient(circle at 20% 20%, rgba(20, 184, 166, 0.12), transparent 38%),
      radial-gradient(circle at 85% 0%, rgba(59, 130, 246, 0.12), transparent 32%),
      var(--color-bg-secondary);
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
</style>
