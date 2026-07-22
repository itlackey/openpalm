<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { LOCAL_PROVIDER_IDS, friendlyProviderName } from '$lib/client/constants.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';
  import SystemCheckStep from './steps/SystemCheckStep.svelte';
  import Screen1ModelsStep from './steps/Screen1ModelsStep.svelte';
  import Screen2ExtrasStep from './steps/Screen2ExtrasStep.svelte';
  import ReviewStep from './steps/ReviewStep.svelte';
  import DeployStep from './steps/DeployStep.svelte';
  import IconLogo from '@openpalm/ui-kit/components/icons/IconLogo.svelte';

  // All wizard state + logic lives in the setup-state store (Svelte 5 runes
  // class), mirroring the store-per-domain pattern (endpoints-state /
  // theme-state / chat-state). This page is a thin shell: it wires onMount to
  // the store and renders from `setupState.*`. The step components read the
  // store directly (Screen1ModelsStep, ReviewStep) or via callbacks below.
  const s = setupState;
  const fromStart = $derived(page.url.searchParams.get('from') === 'start');

  onMount(() => {
    s.init();
    // The store is a module singleton — stop its deploy polling / OAuth polls
    // when the wizard unmounts so nothing outlives the page.
    return () => s.dispose();
  });
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
</svelte:head>

<main class="setup-page" aria-label="Setup wizard">

  {#if s.isRerun}
    <div class="rerun-banner">
      <span>Updating existing installation</span>
      <a href={resolve('/')} class="rerun-back-link">← Back to Admin</a>
    </div>
  {:else if fromStart}
    <a class="remote-onboarding-link" href={resolve('/start')}>
      Back to welcome choices
    </a>
  {:else}
    <a class="remote-onboarding-link" href={resolve('/connections/new?onboarding=1')}>
      Connect to an existing OpenPalm instead
    </a>
  {/if}

  <!-- SystemCheck is the visible prerequisite step for local installation. -->
  {#if s.currentStep === 0 && !s.showDeploy}
    <div class="system-check-stage">
      <section class="step-content" id="step-0" data-testid="step-system-check">
        <SystemCheckStep />
      </section>
    </div>
  {/if}

  {#if s.showDeploy}
    <!-- Deploy: full width, no header chrome -->
    <div style="flex:1; padding: 32px; overflow-y: auto;">
      <DeployStep
        deployData={s.deployData}
        deployDone={s.deployDone}
        deployHasWarnings={s.deployHasWarnings}
        deployError={s.deployError}
        onback={() => s.handleDeployBack()}
        onretry={() => void s.handleDeployRetry()}
      />
    </div>
  {:else if s.currentStep >= 1}
    <!-- Topbar -->
    <header class="wiz-topbar">
      <div class="wiz-wordmark">
        <IconLogo size={30} />
        <b>OpenPalm</b><span>setup</span>
      </div>
      <nav class="wiz-ticker" aria-label="Setup steps">
        {#each [
          { n: 1, label: 'Connect' },
          { n: 2, label: 'Add-ons' },
          { n: 3, label: 'Finish' },
        ] as tick (tick.n)}
          <div
            class="wiz-tick"
            class:wiz-tick--active={s.currentStep === tick.n}
            class:wiz-tick--done={s.currentStep > tick.n}
            aria-current={s.currentStep === tick.n ? 'step' : undefined}
          >
            {#if s.currentStep > tick.n}
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M2 6l3 3 5-5"/></svg>
            {:else}
              <span class="wiz-tick-num">{tick.n}</span>
            {/if}
            {tick.label}
          </div>
        {/each}
      </nav>
    </header>

    <!-- Stage: content + aside -->
    <div class="wiz-stage">
      <!-- Left: content -->
      <div class="wiz-content">
        <div class="wiz-content-scroll">
          <!-- Step header -->
          <div class="wiz-eyebrow">
            {#if s.currentStep === 1}STEP 1 · Connect
            {:else if s.currentStep === 2}STEP 2 · Add-ons
            {:else if s.currentStep === 3}STEP 3 · Finish
            {/if}
          </div>
          <h1 class="wiz-title">
            {#if s.currentStep === 1}Connect your <span class="accent">AI brain</span>
            {:else if s.currentStep === 2}Optional <span class="accent">extras</span>
            {:else if s.currentStep === 3}You're all <span class="accent">set</span>
            {/if}
          </h1>
          <p class="wiz-lede">
            {#if s.currentStep === 1}
              {#if s.hasUsableAI}We found an AI service already set up. Just continue, or choose something different.
              {:else}Your assistant needs a source of intelligence. Pick one and you're set — you can add more later.
              {/if}
            {:else if s.currentStep === 2}All optional — turn on only what you want now. You can add or remove anything later from your dashboard.
            {:else if s.currentStep === 3}OpenPalm is ready to install. Save the password you'll use to sign in.
            {/if}
          </p>

          <!-- Recommendation alert (step 1 only) -->
          {#if s.recommendationAlert && s.currentStep === 1}
            <div class="feedback feedback--warning" role="alert" data-testid="recommendation-alert">
              <span>{s.recommendationAlert}</span>
            </div>
          {/if}

          <!-- Host-import failure (step 1 only) -->
          {#if s.hostImportError && s.currentStep === 1}
            <div class="feedback feedback--error" role="alert" data-testid="host-import-error">
              <span>{s.hostImportError}</span>
            </div>
          {/if}

          <!-- Step body -->
          {#if s.currentStep === 1}
            <section class="step-content" id="step-1">
              <!-- Screen1ModelsStep reads the setup-state store directly. -->
              <Screen1ModelsStep />
            </section>

          {:else if s.currentStep === 2}
            <section class="step-content" id="step-2">
              <!-- Screen2ExtrasStep reads the setup-state store directly. -->
              <Screen2ExtrasStep />
            </section>

          {:else if s.currentStep === 3}
            <section class="step-content" id="step-3" data-testid="step-review">
              <!-- ReviewStep reads the setup-state store directly. -->
              <ReviewStep />
            </section>
          {/if}
        </div><!-- /wiz-content-scroll -->

        <!-- Footer: Back + Continue/Install -->
        <footer class="wiz-footer">
          <div class="wiz-footer-left">
            {#if s.currentStep > 1}
              <button
                class="btn btn-secondary"
                onclick={() => s.goToStep(s.currentStep - 1)}
                aria-label="Back"
              >
                Back
              </button>
            {:else}
              <div></div>
            {/if}
          </div>
          <div class="wiz-footer-right">
            {#if s.currentStep === 1}
              <button
                class="btn btn-primary"
                id="btn-screen1-next"
                onclick={() => s.goToStep(2)}
                disabled={!s.canComplete}
              >
                {#if s.modelSelection.llm?.connId && !LOCAL_PROVIDER_IDS.has(s.modelSelection.llm.connId)}
                  Use {friendlyProviderName(s.modelSelection.llm.connId, { extraProviders: s.opencodeProviders })} — Continue
                {:else if s.ollamaEnabled || s.detectedHostProviders.length > 0 || (s.modelSelection.llm?.connId && LOCAL_PROVIDER_IDS.has(s.modelSelection.llm.connId))}
                  Use local AI — Continue
                {:else}
                  Continue
                {/if}
              </button>
            {:else if s.currentStep === 2}
              <button
                class="btn btn-primary"
                id="btn-screen2-next"
                onclick={() => s.goToStep(3)}
              >
                Continue
              </button>
            {:else if s.currentStep === 3}
              <button
                class="btn btn-primary"
                id="btn-install"
                onclick={() => void s.handleInstall()}
                disabled={!s.canComplete || s.installing}
              >
                {#if s.installing}Installing...{:else}{s.isRerun ? 'Update' : 'Install'}{/if}
              </button>
            {/if}
          </div>
        </footer>
      </div><!-- /wiz-content -->

      <!-- Right: guide aside -->
      <aside class="wiz-aside" aria-label="Setup guide">
        <div class="wiz-aside-top">
          <img class="wiz-mascot" src="/wizard-128.png" alt="OpenPalm setup guide" />
          <div>
            <b class="wiz-greet-name">
              {#if s.currentStep === 1}
                {#if s.hasUsableAI}You're almost done!
                {:else if s.modelMode === 'local' || s.ollamaEnabled || s.detectedHostProviders.length > 0}Great choice.
                {:else}Pick what works for you.
                {/if}
              {:else if s.currentStep === 2}While you're here…
              {:else if s.currentStep === 3}You're ready.
              {/if}
            </b>
            <span class="wiz-greet-sub">
              {#if s.currentStep === 1}Your setup guide
              {:else if s.currentStep === 2}A few optional extras
              {:else if s.currentStep === 3}Everything's in order
              {/if}
            </span>
          </div>
        </div>

        <p class="wiz-guide-lede">
          {#if s.currentStep === 1}
            {#if s.hasUsableAI}We found an AI account on this computer. Just hit <strong>Continue</strong> and your assistant will use it automatically.
            {:else if s.modelMode === 'local' || s.ollamaEnabled || s.detectedHostProviders.length > 0}Running AI locally means your conversations never leave your machine. Perfect for privacy.
            {:else}Sign in once and you're set. A browser tab will open for you to log in — come back here when you're done, it connects automatically.
            {/if}
          {:else if s.currentStep === 2}All of this is optional. Skip this whole step if you want — your assistant works fine without any of these. You can turn them on whenever you're ready from the dashboard.
          {:else if s.currentStep === 3}You're ready. Click <strong>Install OpenPalm</strong> and it'll start up in the background. The first launch pulls a few files — this takes a minute or two. When it's done, open your browser, sign in with that password, and you're good to go. Everything can be changed later from the dashboard.
          {/if}
        </p>

        <div class="wiz-guide-bullets">
          {#if s.currentStep === 1}
            {#if s.hasUsableAI}
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
                </div>
                <div>Your existing connection is ready to use. No extra setup needed — just continue to the next step.</div>
              </div>
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3l1.5 4.5H18l-3.75 2.7 1.5 4.5L12 12l-3.75 2.7 1.5-4.5L6 7.5h4.5z"/></svg>
                </div>
                <div>Want to use something different? Select another option from the list — you can switch any time from the dashboard.</div>
              </div>
            {:else}
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                </div>
                <div><strong>Cloud services</strong> like ChatGPT are fast and easy — you just sign in.</div>
              </div>
              <div class="wiz-bullet">
                <div class="wiz-bullet-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
                </div>
                <div><strong>Running locally</strong> keeps everything on your computer — private, free, no internet needed.</div>
              </div>
            {/if}
          {:else if s.currentStep === 2}
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>
              </div>
              <div>Voice runs locally — free, no internet needed. A small model downloads the first time you use it.</div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>
              </div>
              <div>Setup help: <a href="https://discord.com/developers/docs/quick-start/getting-started" target="_blank" rel="noopener">How to set up a Discord bot →</a></div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
              </div>
              <div><a href="https://api.slack.com/quickstart" target="_blank" rel="noopener">How to set up a Slack app →</a></div>
            </div>
          {:else if s.currentStep === 3}
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              </div>
              <div>Your sign-in password is already saved on this computer — keep a copy somewhere safe just in case.</div>
            </div>
            <div class="wiz-bullet">
              <div class="wiz-bullet-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
              </div>
              <div>Everything can be changed from the dashboard after install — providers, voice, portals, and more.</div>
            </div>
          {/if}
        </div>

        <div class="wiz-guide-privacy">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 1.5L2 4v4c0 3.3 2.5 5.8 6 6.5 3.5-.7 6-3.2 6-6.5V4L8 1.5z"/>
          </svg>
          <span>It's your own assistant, running right here on your computer.</span>
        </div>
      </aside>
    </div><!-- /wiz-stage -->
  {/if}

</main>

<style>
  .remote-onboarding-link {
    position: fixed;
    z-index: 2;
    top: 20px;
    right: 24px;
    color: var(--s-ink-2);
    font-size: var(--s-type-deed);
    font-weight: 600;
  }

  .system-check-stage {
    width: min(680px, calc(100% - 32px));
    margin: auto;
    padding: 40px;
    border: var(--s-hair) solid var(--s-line);
    border-radius: 16px;
    background: var(--s-paper);
  }

  @media (max-width: 640px) {
    .remote-onboarding-link {
      position: static;
      align-self: flex-end;
      margin: 16px;
    }

    .system-check-stage {
      width: 100%;
      padding: 24px 18px;
      border: 0;
      border-radius: 0;
    }
  }
</style>
