<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  import IconHide from '$lib/components/icons/IconHide.svelte';
  import IconReveal from '$lib/components/icons/IconReveal.svelte';
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
        <label for="admin-token" class="sr-only">Admin Password</label>
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
          aria-label={showToken ? 'Hide token' : 'Show token'}
        >
          {#if showToken}
            <IconHide size={14} />
          {:else}
            <IconReveal size={14} />
          {/if}
        </button>
      </div>

      {#if error}
        <p class="s-gate-error" role="alert">{error}</p>
      {/if}

      <button class="s-gate-submit" type="submit" aria-label="Unlock Console" disabled={loading || !tokenInput.trim()}>
        {#if loading}<Spinner />{:else}Unlock Console{/if}
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
    font-family: var(--s-font-header);
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
    border-color: var(--s-seal);
  }

  .s-gate-reveal:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
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
