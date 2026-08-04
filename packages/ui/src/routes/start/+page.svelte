<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';
  import { getRuntimeContext } from '$lib/runtime-context.svelte.js';
  import { bootstrapStart } from './bootstrap.js';

  const runtimeContext = getRuntimeContext();
  let viewState = $state<'loading' | 'choice' | 'error'>('loading');
  let error = $state('');

  async function begin(force = false): Promise<void> {
    viewState = 'loading';
    error = '';
    try {
      // The root layout resolves Electron/browser/standalone-PWA display mode
      // on mount. Wait one frame so standalone never sees the host choice.
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      const result = await bootstrapStart(
        runtimeContext,
        endpointsService,
        force,
      );
      if (result.kind === 'navigate') {
        // bootstrapStart returns only internal paths, including dynamic chat queries.
        // eslint-disable-next-line svelte/no-navigation-without-resolve
        await goto(result.href, { replaceState: true });
        return;
      }
      viewState = 'choice';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      viewState = 'error';
    }
  }

  onMount(() => {
    void begin();
  });
</script>

<svelte:head>
  <title>Welcome to OpenPalm</title>
</svelte:head>

<main class="start-page">
  <section class="start-card" aria-live="polite">
    {#if viewState === 'loading'}
      <div class="loading" role="status">
        <span class="loading-mark" aria-hidden="true"></span>
        <p>Checking this browser for your OpenPalm connections...</p>
      </div>
    {:else if viewState === 'error'}
      <div class="error" role="alert">
        <h1>OpenPalm could not finish starting</h1>
        <p>{error}</p>
      </div>
      <button class="retry" type="button" onclick={() => void begin(true)}>Retry</button>
    {:else}
      <p class="eyebrow">Your private assistant</p>
      <h1>Welcome to OpenPalm</h1>
      <p class="lede">Choose how you want to begin. You can change this later.</p>

      <!-- Both routes are first-class. Connecting to an OpenPalm that already
           exists is not a fallback for people who failed to install one, and
           styling it as a lesser option made it read that way — so the cards
           carry the same weight and each says plainly what it costs. -->
      <div class="choices">
        <a class="choice" href={resolve('/setup?from=start')}>
          <strong>Set up OpenPalm on this computer</strong>
          <span>Run your own private assistant here. We will guide you through the setup.</span>
          <small>Recommended</small>
        </a>
        <a class="choice" href={resolve('/connections/new?onboarding=1')}>
          <strong>Connect to an existing OpenPalm</strong>
          <span>Nothing to install — connect with an address or a pairing code.</span>
          <small>No install needed</small>
        </a>
      </div>
    {/if}
  </section>
</main>

<style>
  .start-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    background:
      radial-gradient(circle at 15% 15%, color-mix(in srgb, var(--s-moss) 18%, transparent), transparent 34%),
      var(--s-paper);
  }

  .start-card {
    width: min(680px, 100%);
    padding: clamp(28px, 6vw, 56px);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 20px;
    background: color-mix(in srgb, var(--s-paper) 94%, transparent);
    box-shadow: 0 24px 70px color-mix(in srgb, var(--s-ink) 12%, transparent);
  }

  .eyebrow {
    margin: 0 0 8px;
    color: var(--s-moss);
    font-size: var(--s-type-deed);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    color: var(--s-ink);
    font-size: clamp(2rem, 7vw, 3.5rem);
    line-height: 1;
    letter-spacing: -0.04em;
  }

  .lede {
    margin: 16px 0 32px;
    color: var(--s-ink-2);
    font-size: 1.05rem;
  }

  .choices {
    display: grid;
    gap: 14px;
  }

  /* One treatment for both cards. The accent border and tinted fill used to
     belong to the install option alone, which made connecting to an existing
     OpenPalm look like the consolation prize. The badges carry the difference
     in meaning now; the styling no longer picks a winner. */
  .choice {
    position: relative;
    display: grid;
    gap: 7px;
    padding: 22px;
    border: 2px solid var(--s-moss);
    border-radius: 12px;
    background: color-mix(in srgb, var(--s-moss) 9%, var(--s-paper));
    color: var(--s-ink);
    text-decoration: none;
    transition: border-color 120ms ease, transform 120ms ease;
  }

  .choice:hover,
  .choice:focus-visible {
    border-color: var(--s-ink);
    transform: translateY(-2px);
  }

  .choice strong {
    padding-right: 130px;
    font-size: 1.08rem;
  }

  .choice span {
    color: var(--s-ink-2);
    line-height: 1.5;
  }

  .choice small {
    position: absolute;
    top: 20px;
    right: 20px;
    color: var(--s-moss);
    font-weight: 700;
  }

  .loading {
    min-height: 180px;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 18px;
    color: var(--s-ink-2);
    text-align: center;
  }

  .loading-mark {
    width: 38px;
    height: 38px;
    border: 3px solid var(--s-line);
    border-top-color: var(--s-moss);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  .error p {
    margin: 18px 0 24px;
    color: var(--s-seal);
  }

  .retry {
    padding: 11px 18px;
    border: 0;
    border-radius: 8px;
    background: var(--s-ink);
    color: var(--s-paper);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 520px) {
    .start-page { padding: 0; }
    .start-card {
      min-height: 100vh;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }
    .choice strong { padding-right: 0; }
    .choice small {
      position: static;
      order: -1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .choice { transition: none; }
    .loading-mark { animation: none; }
  }
</style>
