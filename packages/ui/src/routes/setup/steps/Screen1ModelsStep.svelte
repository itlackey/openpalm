<script lang="ts">
  /**
   * Screen1ModelsStep — "Connect your AI brain"
   *
   * Redesigned flat RadioRow layout (spec: /tmp/wiz/connect-redesign.html).
   * Three primary choices in a hairline-divided list:
   *   1. Detected cloud service (shown only when verifiedCount > 0 or llmProvider set)
   *   2. Run on this computer (local AI — co-equal primary option)
   *   3. Sign in to a cloud service (expands ProviderOAuthList inline)
   *
   * Takes NO props: this step reads the setup-state store
   * ($lib/setup/setup-state.svelte.ts) directly for its reactive inputs
   * (providerState, verifiedCount, detected GPU/host info, model selection, …)
   * and calls the store's methods for actions (handleConnectModeChange,
   * handleHostImport, startOpenCodeOAuth/cancelOAuth, fetchAndApplyRecommendation,
   * goToStep, allowEmptyInstall). Local aliases near the top of the script map
   * those store members to the names the template uses.
   */

  import { untrack } from 'svelte';
  import CloudAttachPanel from './CloudAttachPanel.svelte';
  import LocalModelsStatus from './LocalModelsStatus.svelte';
  import { LOCAL_PROVIDER_IDS, friendlyProviderName } from '$lib/client/constants.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';
  // G-series: this used to hardcode its own copy of the threshold
  // setup-recommendation.ts (the macOS/GPU decision engine) already exports —
  // the two had already drifted apart in spirit even though the value matched.
  import { MIN_LOCAL_GPU_VRAM_MB } from '@openpalm/lib';

  type ModelMode = 'cloud' | 'local' | 'both';

  // This step reads the wizard store directly instead of receiving ~20 drilled
  // props from +page.svelte. Local aliases keep the rest of the component body
  // unchanged: state aliases are `$derived` off the store; the action aliases
  // wrap the store's methods.
  const s = setupState;

  const gpuVramMb = $derived(s.detectedGpuVramMb);
  const gpuVendor = $derived(s.detectedGpuVendor);
  const hostProviders = $derived(s.detectedHostProviders);
  const opencodeProviders = $derived(s.opencodeProviders);
  const hostImporting = $derived(s.hostImporting);
  const verifiedCount = $derived(s.verifiedCount);
  const allowEmptyInstall = $derived(s.allowEmptyInstall);
  const llmModel = $derived(s.modelSelection.llm?.model ?? '');
  const llmProvider = $derived(s.modelSelection.llm?.connId ?? '');
  const detectedCloudConn = $derived(s.detectedCloudConn);

  const onmodelmodechange = (mode: ModelMode): void => s.handleConnectModeChange(mode);
  const onallowemptyinstallchange = (v: boolean): void => { s.allowEmptyInstall = v; };

  // Local-models gate: available when GPU >= 8 GiB, Apple Silicon, or runtime running.
  const localAvailable = $derived(
    gpuVramMb >= MIN_LOCAL_GPU_VRAM_MB ||
    gpuVendor === 'apple' ||
    hostProviders.length > 0
  );

  // The "detected" cloud service — a STABLE value so this row stays visible even
  // after the user switches to local (so they can switch back). Falls back to the
  // current cloud selection before the parent has captured it.
  const detectedConn = $derived(
    detectedCloudConn || (llmProvider && !LOCAL_PROVIDER_IDS.has(llmProvider) ? llmProvider : '')
  );
  // G-series: friendlyProviderName (constants.js) is the shared label
  // resolver — this used to reimplement the same curated-name-then-fallback
  // logic locally.
  const detectedServiceLabel = $derived(
    detectedConn ? friendlyProviderName(detectedConn, { extraProviders: opencodeProviders }) : ''
  );

  // Whether the current selection is a local runtime (drives initial row pick).
  const detectedIsLocal = $derived(LOCAL_PROVIDER_IDS.has(llmProvider));

  // Show the detected cloud row whenever a cloud service was detected — STABLE,
  // so it doesn't vanish when the user switches the active selection to local.
  const showDetectedRow = $derived(!!detectedConn && verifiedCount > 0);

  // Which row is selected in the choice list.
  // 'detected' | 'local' | 'cloud' | null
  type RowChoice = 'detected' | 'local' | 'cloud' | null;

  // One-time initialization from derived prop values. untrack() signals intentionality
  // — the user modifies selectedRow via selectRow() after this point.
  let selectedRow = $state<RowChoice>(
    untrack(() => showDetectedRow ? 'detected' : (detectedIsLocal && llmProvider ? 'local' : null))
  );

  function selectRow(row: RowChoice): void {
    if (row === 'local' && !localAvailable) return;
    selectedRow = row;
    if (row === 'local') {
      onmodelmodechange('local');
    } else if (row === 'detected') {
      onmodelmodechange('cloud');
    }
    // 'cloud' row stays open for sign-in; mode change happens after OAuth completes
  }

  // Show local status panel when local row is selected.
  const showLocalPanel = $derived(selectedRow === 'local');
  // Show cloud sign-in panel when cloud row is selected.
  const showSignInPanel = $derived(selectedRow === 'cloud');

  // W14: arrow-key navigation for the role="radiogroup" choice list — the
  // rows were plain click targets with no keyboard equivalent to the arrow
  // keys a native radio group supports. Order follows visual top-to-bottom
  // order; the local row is skipped when disabled, matching how a native
  // radiogroup skips disabled radios.
  type SelectableRow = 'detected' | 'local' | 'cloud';
  let detectedRowEl: HTMLButtonElement | null = $state(null);
  let localRowEl: HTMLButtonElement | null = $state(null);
  let cloudRowEl: HTMLButtonElement | null = $state(null);

  function rowEl(row: SelectableRow): HTMLButtonElement | null {
    if (row === 'detected') return detectedRowEl;
    if (row === 'local') return localRowEl;
    return cloudRowEl;
  }

  function visibleRowOrder(): SelectableRow[] {
    const order: SelectableRow[] = [];
    if (showDetectedRow) order.push('detected');
    if (localAvailable) order.push('local');
    order.push('cloud');
    return order;
  }

  function onRadiogroupKeydown(e: KeyboardEvent): void {
    const order = visibleRowOrder();
    const currentIndex = selectedRow ? order.indexOf(selectedRow as SelectableRow) : -1;
    let nextIndex: number;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % order.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      nextIndex = currentIndex < 0 ? order.length - 1 : (currentIndex - 1 + order.length) % order.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = order.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const nextRow = order[nextIndex];
    selectRow(nextRow);
    rowEl(nextRow)?.focus();
  }

  // In detected state, the cloud row label changes.
  const cloudRowTitle = $derived(
    showDetectedRow ? 'Sign in to a different service' : 'Sign in to a cloud AI service'
  );
  const cloudRowSub = $derived(
    showDetectedRow
      ? 'Google Gemini, GitHub Copilot, and others'
      : 'OpenAI, Google Gemini, GitHub Copilot, and others'
  );
</script>

<div data-testid="step-models" class="screen-models">

  <!-- Loading shimmer while importing -->
  {#if hostImporting}
    <div class="s1-shimmer" aria-busy="true" aria-label="Detecting AI services…">
      <span class="s1-shimmer-bar"></span>
      <span class="s1-shimmer-bar s1-shimmer-bar--short"></span>
      <span class="s1-shimmer-bar s1-shimmer-bar--shorter"></span>
    </div>
  {:else}

    <!-- Detected banner: green status when something is already connected -->
    {#if verifiedCount > 0 && showDetectedRow}
      <div class="s1-detected-banner" role="status">
        <div class="s1-detected-check" aria-hidden="true">✓</div>
        <div class="s1-detected-text">
          <div class="s1-detected-title">{detectedServiceLabel} is already connected — you're good to go</div>
          <div class="s1-detected-sub">We found your account on this computer. Just continue, or choose something different below.</div>
        </div>
      </div>
    {/if}

    <!-- Primary choice list -->
    <div class="s1-choice-list" role="radiogroup" aria-label="Which AI should your assistant use" onkeydown={onRadiogroupKeydown}>

      <!-- Row 1: Detected cloud service (only when a cloud provider is verified) -->
      {#if showDetectedRow}
        <button
          bind:this={detectedRowEl}
          type="button"
          class="s1-choice-row"
          class:s1-choice-row--selected={selectedRow === 'detected'}
          role="radio"
          aria-checked={selectedRow === 'detected'}
          onclick={() => selectRow('detected')}
        >
          <div class="s1-radio-dot">
            <div class="s1-radio-dot-inner"></div>
          </div>
          <div class="s1-choice-body">
            <div class="s1-choice-title">{detectedServiceLabel}</div>
            <div class="s1-choice-sub">Use your existing {detectedServiceLabel} subscription</div>
          </div>
          <span class="s1-badge-recommended">Recommended</span>
        </button>
      {/if}

      <!-- Row 2: Run on this computer (local AI — always shown, co-equal primary) -->
      <button
        bind:this={localRowEl}
        type="button"
        class="s1-choice-row"
        class:s1-choice-row--selected={selectedRow === 'local'}
        class:s1-choice-row--unavailable={!localAvailable}
        role="radio"
        aria-checked={selectedRow === 'local'}
        disabled={!localAvailable}
        onclick={() => selectRow('local')}
      >
        <div class="s1-radio-dot">
          <div class="s1-radio-dot-inner"></div>
        </div>
        <div class="s1-choice-icon" aria-hidden="true">
          <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="1.5" y="2.5" width="15" height="10" rx="1.5"/>
            <path d="M5.5 15.5h7M9 12.5v3" stroke-linecap="round"/>
            <circle cx="9" cy="7.5" r="2.5"/>
          </svg>
        </div>
        <div class="s1-choice-body">
          <div class="s1-choice-title">Run on this computer</div>
          <div class="s1-choice-sub">
            {#if localAvailable}
              Private &amp; free — no account needed, no data leaves your machine
            {:else}
              Needs a more capable computer — requires 8 GB+ graphics card or Apple Silicon
            {/if}
          </div>
        </div>
      </button>

      <!-- Local AI expansion panel (accordion below local row) -->
      {#if showLocalPanel}
        <div class="s1-local-panel" aria-live="polite">
          <LocalModelsStatus />
        </div>
      {/if}

      <!-- Row 3: Sign in to a cloud service -->
      <button
        bind:this={cloudRowEl}
        type="button"
        class="s1-choice-row"
        class:s1-choice-row--selected={selectedRow === 'cloud'}
        role="radio"
        aria-checked={selectedRow === 'cloud'}
        onclick={() => selectRow('cloud')}
      >
        <div class="s1-radio-dot">
          <div class="s1-radio-dot-inner"></div>
        </div>
        <div class="s1-choice-body">
          <div class="s1-choice-title">{cloudRowTitle}</div>
          <div class="s1-choice-sub">{cloudRowSub}</div>
        </div>
      </button>

      <!-- Sign-in panel expands inline below the cloud row -->
      {#if showSignInPanel}
        <div class="s1-signin-panel" aria-live="polite">
          <CloudAttachPanel />
        </div>
      {/if}

    </div><!-- /.s1-choice-list -->

    <!-- "Install without a usable AI" escape hatch.
         Keyed on the actual chat model, not on whether *some* provider is
         "connected" — a verified provider with no usable model would otherwise
         leave the user stuck (Continue disabled, no escape). This is also the
         path for a client-only install: skip AI here and point the app at an
         assistant running on another computer. -->
    {#if !llmModel && !allowEmptyInstall}
      <div class="s1-empty-install-row">
        <p class="s1-empty-install-hint">
          No AI here? You can still continue — connect this app to an assistant
          running on another computer, or add a provider later from your dashboard.
        </p>
        <button
          type="button"
          class="s1-btn-empty-install"
          onclick={() => onallowemptyinstallchange?.(true)}
        >
          I'll set this up later
        </button>
      </div>
    {/if}

  {/if}<!-- /loading else -->

</div>

<style>
  .screen-models {
    display: flex;
    flex-direction: column;
    gap: 0;
    font-family: var(--s-font-display);
  }

  /* ── Detection shimmer ───────────────────────────────────── */
  .s1-shimmer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 0;
    margin-bottom: 8px;
  }

  .s1-shimmer-bar {
    display: block;
    height: 52px;
    border-radius: 2px;
    background: linear-gradient(
      90deg,
      var(--s-line) 25%,
      var(--s-paper-deep) 50%,
      var(--s-line) 75%
    );
    background-size: 200% 100%;
    animation: s1shimmer 1.4s infinite;
    width: 100%;
  }

  .s1-shimmer-bar--short { animation-delay: 0.15s; }
  .s1-shimmer-bar--shorter { animation-delay: 0.3s; }

  @keyframes s1shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ── Detected banner ─────────────────────────────────────── */
  .s1-detected-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    background: color-mix(in srgb, var(--s-moss) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--s-moss) 25%, transparent);
    border-radius: 2px;
    padding: 14px 16px;
    margin-bottom: 20px;
  }

  .s1-detected-check {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--s-moss);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .s1-detected-text { flex: 1; min-width: 0; }

  .s1-detected-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--s-moss);
    line-height: 1.3;
  }

  .s1-detected-sub {
    font-size: 13px;
    color: var(--s-ink-2);
    margin-top: 2px;
  }

  /* ── Primary choice list: hairline dividers, no container border ── */
  .s1-choice-list {
    display: flex;
    flex-direction: column;
    margin-bottom: 4px;
  }

  /* ── Choice row ──────────────────────────────────────────── */
  .s1-choice-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 4px;
    border: none;
    border-bottom: var(--s-hair) solid var(--s-line);
    background: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms;
    -webkit-tap-highlight-color: transparent;
  }

  .s1-choice-row:first-child { border-top: var(--s-hair) solid var(--s-line); }

  /* When a local-panel or signin-panel follows a row, the panel's top
     border acts as the row's bottom divider — remove the row's own bottom. */
  .s1-choice-row:has(+ .s1-local-panel),
  .s1-choice-row:has(+ .s1-signin-panel) {
    border-bottom: none;
  }

  .s1-choice-row:hover:not(:disabled) { background: var(--s-paper-deep); }

  .s1-choice-row--selected { background: color-mix(in srgb, var(--s-seal) 8%, transparent); }
  .s1-choice-row--selected:hover { background: color-mix(in srgb, var(--s-seal) 8%, transparent); }

  .s1-choice-row--unavailable {
    cursor: default;
    opacity: 0.5;
  }
  .s1-choice-row--unavailable:hover { background: none; }

  .s1-choice-row:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: -2px;
    border-radius: 2px;
  }

  /* ── Radio dot ───────────────────────────────────────────── */
  .s1-radio-dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--s-line);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 150ms;
  }

  .s1-choice-row--selected .s1-radio-dot {
    border-color: var(--s-seal);
  }

  .s1-radio-dot-inner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--s-seal);
    opacity: 0;
    transform: scale(0.5);
    transition: opacity 150ms, transform 150ms;
  }

  .s1-choice-row--selected .s1-radio-dot-inner {
    opacity: 1;
    transform: scale(1);
  }

  /* ── Choice body ─────────────────────────────────────────── */
  .s1-choice-body { flex: 1; min-width: 0; }

  .s1-choice-title {
    font-size: 15px;
    font-weight: 500;
    color: var(--s-ink);
    line-height: 1.3;
  }

  .s1-choice-row--selected .s1-choice-title { font-weight: 600; }

  .s1-choice-sub {
    font-size: 13px;
    color: var(--s-ink-2);
    margin-top: 3px;
    line-height: 1.45;
  }

  /* ── Recommended badge (amber pill) ─────────────────────── */
  .s1-badge-recommended {
    font-size: 11px;
    font-weight: 600;
    color: #7a4800;
    background: rgba(255, 157, 0, 0.14);
    border-radius: 9999px;
    padding: 3px 9px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Dark mode: darken text on light badge */
  :global(.dark) .s1-badge-recommended,
  :global([data-theme="dark"]) .s1-badge-recommended {
    color: #ffb733;
    background: rgba(255, 157, 0, 0.18);
  }

  /* ── Computer icon bubble ────────────────────────────────── */
  .s1-choice-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: rgba(139, 92, 246, 0.10);
    color: #a78bfa;
  }

  .s1-choice-icon svg { width: 18px; height: 18px; }

  /* ── Local AI expansion panel ────────────────────────────── */
  .s1-local-panel {
    border-top: var(--s-hair) solid var(--s-line);
    border-bottom: var(--s-hair) solid var(--s-line);
    padding: 14px 4px;
    background: var(--s-paper-deep);
  }

  /* ── Sign-in panel (cloud accordion) ────────────────────── */
  .s1-signin-panel {
    border-top: var(--s-hair) solid var(--s-line);
    border-bottom: var(--s-hair) solid var(--s-line);
    padding: 16px 4px;
    background: var(--s-paper-deep);
  }

  /* ── Empty install escape ────────────────────────────────── */
  .s1-empty-install-row {
    margin-top: 12px;
    text-align: center;
  }

  .s1-empty-install-hint {
    margin: 0 auto 4px;
    max-width: 46ch;
    font-size: 13px;
    line-height: 1.5;
    color: var(--s-ink-3);
  }

  .s1-btn-empty-install {
    background: none;
    border: none;
    padding: 4px 0;
    min-height: 24px;
    font-size: 13px;
    color: var(--s-ink-3);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    line-height: 1.6;
    display: inline-flex;
    align-items: center;
    font-family: inherit;
    transition: color 150ms;
  }

  .s1-btn-empty-install:hover {
    color: var(--s-ink-2);
  }
</style>
