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
   * Props:
   *   modelMode               — currently selected mode ('cloud'|'local'|'both')
   *   detectionLoading        — true while /api/setup/recommend is in flight
   *   detectionTimedOut       — true when detection did not complete within 3s
   *   systemCheckError        — non-empty string when SystemCheck failed (shows inline alert)
   *   systemCheckRetrying     — true while system check retry is in progress
   *   gpuVramMb               — VRAM in MiB (0 = not detected)
   *   gpuVendor               — 'apple' | 'nvidia' | 'amd' | '' (empty = none detected)
   *   gpuName                 — human-readable GPU name
   *   hostProviders           — local runtimes running on host
   *   credentialCount         — importable host credential count
   *   cloudProviders          — provider ids configured on host
   *   opencodeProviders       — all OpenCode providers (for OAuth list)
   *   opencodeAuth            — auth methods per provider id
   *   providerState           — verification state per provider id
   *   ollamaEnabled           — whether in-stack Ollama is active
   *   selectedOllamaProfile   — ollama profile id (cuda/rocm/cpu)
   *   hostImporting           — true while host import is in flight
   *   verifiedCount           — number of providers currently verified
   *   allowEmptyInstall       — whether "install without provider" escape is active
   *   llmModel                — selected chat model id
   *   llmProvider             — provider name for selected chat model
   *
   * Events:
   *   onmodelmodechange       — user picked a different model mode
   *   onhostimport            — trigger host provider import
   *   onoauthstart            — OAuth flow start
   *   onoauthcancel           — OAuth flow cancel
   *   onbaseurl               — custom base URL changed
   *   onapikey                — custom API key changed
   *   onverify                — verify custom endpoint
   *   onrecheck               — re-call /api/setup/recommend
   *   onsystemcheckretry      — retry the system check
   *   onallowemptyinstallchange — toggle empty install escape
   *   onnext                  — proceed to Screen 2
   */

  import { untrack } from 'svelte';
  import CloudAttachPanel from './CloudAttachPanel.svelte';
  import LocalModelsStatus from './LocalModelsStatus.svelte';
  import type { OpenCodeProvider, AuthMethod, ProviderState } from '$lib/client/types.js';

  export type ModelMode = 'cloud' | 'local' | 'both';

  interface HostProvider {
    provider: string;
    url: string;
  }

  interface Props {
    /** Currently selected model mode. */
    modelMode: ModelMode;
    /** True while Phase-0 detection is in flight. */
    detectionLoading?: boolean;
    /** True when the 3-second detection timeout elapsed. */
    detectionTimedOut?: boolean;
    /** Non-empty string = SystemCheck failed; shown as inline alert on this screen. */
    systemCheckError?: string;
    /** True while the system check retry is running. */
    systemCheckRetrying?: boolean;
    /** VRAM in MiB from detection (0 = not detected). */
    gpuVramMb?: number;
    /** GPU vendor from detection ('apple'|'nvidia'|'amd'|''). */
    gpuVendor?: string;
    /** Human-readable GPU name. */
    gpuName?: string;
    /** Local runtimes already running on the host. */
    hostProviders?: HostProvider[];
    /** Number of importable host credentials. */
    credentialCount?: number;
    /** Provider ids detected as configured on the host. */
    cloudProviders?: string[];
    /** Full OpenCode provider list (for OAuth sub-panel). */
    opencodeProviders?: OpenCodeProvider[];
    /** Auth methods per provider id. */
    opencodeAuth?: Record<string, AuthMethod[]>;
    /** Verification state per provider id. */
    providerState?: Record<string, ProviderState>;
    /** Whether in-stack Ollama will be added. */
    ollamaEnabled?: boolean;
    /** Selected Ollama profile (cuda/rocm/cpu). */
    selectedOllamaProfile?: string;
    /** True while host-import is in flight. */
    hostImporting?: boolean;
    /** Number of currently verified providers. */
    verifiedCount?: number;
    /** Whether the "install without provider" escape is checked. */
    allowEmptyInstall?: boolean;
    /** Currently selected chat model id. */
    llmModel?: string;
    /** Provider name for the selected chat model (connId). */
    llmProvider?: string;
    /** Chat-model options across verified providers (for the model picker). */
    llmModelOptions?: Array<{ id: string; connId: string; isDefault: boolean; dims: number }>;
    /** Stable connId of the detected cloud service (persists across local↔cloud switches). */
    detectedCloudConn?: string;

    onmodelmodechange: (mode: ModelMode) => void;
    /** Choose the default chat model. */
    onselectmodel?: (connId: string, model: string, dims: number) => void;
    onhostimport?: () => void;
    onoauthstart?: (id: string, methodIndex: number) => void;
    onoauthcancel?: (id: string) => void;
    onbaseurl?: (id: string, url: string) => void;
    onapikey?: (id: string, key: string) => void;
    onverify?: (id: string) => void;
    onrecheck?: () => void;
    onsystemcheckretry?: () => void;
    onallowemptyinstallchange?: (v: boolean) => void;
    onnext: () => void;
  }

  const MIN_LOCAL_GPU_VRAM_MB = 8192;

  // Friendly display names for well-known cloud connIds.
  const SERVICE_LABELS: Record<string, string> = {
    openai: 'ChatGPT (OpenAI)',
    google: 'Gemini (Google)',
    'github-copilot': 'GitHub Copilot',
    groq: 'Groq',
    anthropic: 'Claude (Anthropic)',
    mistral: 'Mistral',
    cohere: 'Cohere',
  };

  let {
    modelMode,
    detectionLoading = false,
    detectionTimedOut = false,
    systemCheckError = '',
    systemCheckRetrying = false,
    gpuVramMb = 0,
    gpuVendor = '',
    gpuName = '',
    hostProviders = [],
    credentialCount = 0,
    cloudProviders = [],
    opencodeProviders = [],
    opencodeAuth = {},
    providerState = {},
    ollamaEnabled = false,
    selectedOllamaProfile = '',
    hostImporting = false,
    verifiedCount = 0,
    allowEmptyInstall = false,
    llmModel = '',
    llmProvider = '',
    llmModelOptions = [],
    detectedCloudConn = '',
    onselectmodel,
    onmodelmodechange,
    onhostimport,
    onoauthstart,
    onoauthcancel,
    onbaseurl,
    onapikey,
    onverify,
    onrecheck,
    onsystemcheckretry,
    onallowemptyinstallchange,
    onnext,
  }: Props = $props();

  // Local-models gate: available when GPU >= 8 GiB, Apple Silicon, or runtime running.
  const localAvailable = $derived(
    gpuVramMb >= MIN_LOCAL_GPU_VRAM_MB ||
    gpuVendor === 'apple' ||
    hostProviders.length > 0
  );

  // Can proceed: at least one provider verified, OR local is active, OR empty escape
  const canProceed = $derived(
    allowEmptyInstall ||
    verifiedCount > 0 ||
    ollamaEnabled ||
    hostProviders.length > 0
  );

  let timeoutBannerDismissed = $state(false);

  // Resolve a friendly display name for a provider connId.
  function friendlyServiceLabel(connId: string): string {
    if (SERVICE_LABELS[connId]) return SERVICE_LABELS[connId];
    const fromProviders = opencodeProviders.find((p) => p.id === connId)?.name;
    if (fromProviders) return fromProviders;
    return connId;
  }

  const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'localai', 'model-runner']);

  // The "detected" cloud service — a STABLE value so this row stays visible even
  // after the user switches to local (so they can switch back). Falls back to the
  // current cloud selection before the parent has captured it.
  const detectedConn = $derived(
    detectedCloudConn || (llmProvider && !LOCAL_PROVIDER_IDS.has(llmProvider) ? llmProvider : '')
  );
  const detectedServiceLabel = $derived(detectedConn ? friendlyServiceLabel(detectedConn) : '');

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

  <!-- System check failure inline alert -->
  {#if systemCheckError}
    <div class="s1-alert s1-alert--error" role="alert">
      <span class="s1-alert-text">{systemCheckError}</span>
      <button
        type="button"
        class="s1-alert-btn"
        id="btn-syscheck-retry"
        disabled={systemCheckRetrying}
        onclick={onsystemcheckretry}
      >
        {systemCheckRetrying ? 'Checking…' : 'Retry'}
      </button>
    </div>
  {/if}

  <!-- Detection timeout banner -->
  {#if detectionTimedOut && !timeoutBannerDismissed}
    <div class="s1-alert s1-alert--warn" role="alert">
      <span class="s1-alert-text">Detection timed out — results may be incomplete.</span>
      <button type="button" class="s1-alert-btn s1-alert-btn--warn" onclick={onrecheck}>Re-run detection</button>
      <button
        type="button"
        class="s1-dismiss"
        aria-label="Dismiss"
        onclick={() => { timeoutBannerDismissed = true; }}
      >✕</button>
    </div>
  {/if}

  <!-- Loading shimmer while importing -->
  {#if detectionLoading || hostImporting}
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
    <div class="s1-choice-list" role="radiogroup" aria-label="Which AI should your assistant use">

      <!-- Row 1: Detected cloud service (only when a cloud provider is verified) -->
      {#if showDetectedRow}
        <button
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
          <LocalModelsStatus
            {hostProviders}
            {gpuVramMb}
            {gpuVendor}
            {gpuName}
            {ollamaEnabled}
            {selectedOllamaProfile}
            {onrecheck}
          />
        </div>
      {/if}

      <!-- Row 3: Sign in to a cloud service -->
      <button
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
          <CloudAttachPanel
            credentialCount={0}
            cloudProviders={[]}
            {opencodeProviders}
            {opencodeAuth}
            {providerState}
            {hostImporting}
            {verifiedCount}
            {onhostimport}
            onoauthstart={(id, idx) => onoauthstart?.(id, idx)}
            onoauthcancel={(id) => onoauthcancel?.(id)}
            onbaseurl={(id, url) => onbaseurl?.(id, url)}
            onapikey={(id, key) => onapikey?.(id, key)}
            onverify={(id) => onverify?.(id)}
          />
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

  /* ── Alerts ─────────────────────────────────────────────── */
  .s1-alert {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    margin-bottom: 12px;
    border-radius: 8px;
    font-size: 13px;
    flex-wrap: wrap;
  }

  .s1-alert--error {
    background: rgba(242, 92, 92, 0.1);
    border: 1px solid rgba(242, 92, 92, 0.3);
  }

  .s1-alert--warn {
    background: rgba(255, 157, 0, 0.08);
    border: 1px solid rgba(255, 157, 0, 0.25);
  }

  .s1-alert-text {
    flex: 1;
    color: var(--s-ink-2);
  }

  .s1-alert--error .s1-alert-text { color: var(--s-seal); }

  .s1-alert-btn {
    padding: 4px 10px;
    background: none;
    border: 1px solid currentColor;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    min-height: 28px;
    color: var(--s-seal);
    font-family: inherit;
    transition: opacity 150ms;
  }

  .s1-alert-btn--warn { color: var(--s-seal); }
  .s1-alert-btn:disabled { opacity: 0.55; cursor: not-allowed; }

  .s1-dismiss {
    background: none;
    border: none;
    color: var(--s-ink-3);
    cursor: pointer;
    font-size: 15px;
    min-width: 26px;
    min-height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: color 150ms;
  }
  .s1-dismiss:hover { color: var(--s-ink-2); }

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
