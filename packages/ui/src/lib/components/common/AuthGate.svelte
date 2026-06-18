<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  interface Props {
    onSuccess: (token: string) => Promise<boolean>;
    loading: boolean;
    error: string;
  }

  let { onSuccess, loading, error }: Props = $props();

  let tokenInput = $state('');
  let showToken = $state(false);
  let tokenInputEl: HTMLInputElement | undefined = $state();

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token || loading) {
      tokenInputEl?.focus();
      return;
    }
    const ok = await onSuccess(token);
    if (!ok) {
      tokenInputEl?.focus();
      tokenInputEl?.select();
    }
  }
</script>

<main class="s-gate" aria-label="Admin login gate">
  <div class="s-gate-inner">
    <div class="s-gate-mark">openpalm</div>

    <form class="s-gate-form" onsubmit={handleSubmit}>
      <input type="text" name="username" autocomplete="username" value="admin" class="sr-only" tabindex="-1" aria-hidden="true" />
      <div class="s-gate-field">
        <input
          id="admin-token"
          name="admin-token"
          class="s-gate-input"
          type={showToken ? 'text' : 'password'}
          bind:value={tokenInput}
          bind:this={tokenInputEl}
          placeholder="password"
          autocomplete="current-password"
        />
        <button
          type="button"
          class="s-gate-reveal"
          onclick={() => showToken = !showToken}
          aria-label={showToken ? 'Hide password' : 'Show password'}
        >
          {#if showToken}
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          {:else}
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          {/if}
        </button>
      </div>

      {#if error}
        <p class="s-gate-error" role="alert">{error}</p>
      {/if}

      <button class="s-gate-submit" type="submit" disabled={loading || !tokenInput.trim()}>
        {#if loading}<Spinner />{:else}enter{/if}
      </button>
    </form>
  </div>
</main>

<style>
  .s-gate {
    height: 100vh;
    height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--s-paper);
    font-family: var(--s-font-display);
    -webkit-font-smoothing: antialiased;
  }

  .s-gate-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2.8rem;
    width: min(22rem, calc(100vw - 3rem));
  }

  .s-gate-mark {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
  }

  .s-gate-form {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.6rem;
    width: 100%;
  }

  .s-gate-field {
    display: flex;
    align-items: center;
    width: 100%;
    border-bottom: var(--s-hair) solid var(--s-line);
    transition: border-color var(--s-t-quick) var(--s-ease);
  }

  .s-gate-field:focus-within {
    border-color: var(--s-ink-2);
  }

  .s-gate-input {
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    font-family: var(--s-font-display);
    font-size: var(--s-type-compose);
    color: var(--s-ink);
    text-align: center;
    padding: 0.5rem 0;
    min-width: 0;
  }

  .s-gate-input::placeholder {
    color: var(--s-ink-3);
    opacity: 1;
  }

  .s-gate-reveal {
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    padding: 0.4rem;
    color: var(--s-ink-3);
    display: flex;
    align-items: center;
    transition: color var(--s-t-quick) var(--s-ease);
    flex-shrink: 0;
  }

  .s-gate-reveal:hover { color: var(--s-ink-2); }

  .s-gate-error {
    margin: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    color: var(--s-seal);
    text-align: center;
  }

  .s-gate-submit {
    appearance: none;
    border: 0;
    background: none;
    cursor: pointer;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    padding: 0.4rem 0;
    transition: color var(--s-t-quick) var(--s-ease);
  }

  .s-gate-submit:hover:not(:disabled) { color: var(--s-ink); }

  .s-gate-submit:disabled {
    opacity: 0.38;
    cursor: default;
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
</style>
