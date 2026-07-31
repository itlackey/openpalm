<script lang="ts">
  import { PORTALS, friendlyProviderName } from '$lib/client/constants.js';
  import IconAgent from '$lib/components/icons/IconAgent.svelte';
  import IconMic from '$lib/components/icons/IconMic.svelte';
  import IconLock from '$lib/components/icons/IconLock.svelte';
  import { isPortalEnabled as _isPortalEnabled } from '$lib/client/helpers.js';
  import FriendlyError from '$lib/components/common/FriendlyError.svelte';
  import { friendlyError } from '$lib/client/error-messages.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';
  import { ACCESS_TOGGLE_KEYS, ACCESS_TOGGLE_LABELS } from '@openpalm/lib/control-plane/access-toggles.js';
  import NetworkAccessStep from './NetworkAccessStep.svelte';

  // Takes NO props: this step reads the setup-state store directly. Local
  // aliases (`$derived` off the store) keep the rest of the component body
  // unchanged; the edit actions call the store's navigation.
  const s = setupState;

  const uiLoginPassword = $derived(s.uiLoginPassword);
  const passwordValid = $derived(s.passwordValid);
  const verifiedProviders = $derived(s.verifiedProviders);
  const modelSelection = $derived(s.modelSelection);
  const portalSelection = $derived(s.portalSelection);
  const ollamaEnabled = $derived(s.ollamaEnabled);
  // Label for the running host provider (e.g. "Ollama"). Shown when ollamaEnabled is false.
  const hostProviderLabel = $derived(s.detectedHostProviders.length > 0 ? s.detectedHostProviders[0].provider : '');
  const payload = $derived(s.payload);
  const installError = $derived(s.installError);
  const isRerun = $derived(s.isRerun);
  const systemCheckPassed = $derived(s.systemCheckPassed);
  const oneditmodels = (): void => s.goToStep(1);
  const oneditextras = (): void => s.goToStep(2);
  // Summarise what is OPEN. Nothing open is the default and the common case,
  // so it gets a plain sentence rather than a list of four "off"s.
  const accessSummary = $derived(
    ACCESS_TOGGLE_KEYS.filter((k) => s.access[k]).map((k) => ACCESS_TOGGLE_LABELS[k]).join('; ')
      || 'This computer only',
  );
  // "Change" stays on the Finish step (D5: the network step is a section of
  // it, not a separate screen) and just scrolls/focuses that section.
  const oneditnetwork = (): void => {
    document.getElementById('network-access-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function isPortalEnabled(chId: string): boolean {
    return _isPortalEnabled(portalSelection, chId);
  }

  // Friendly AI label: resolved from the chat model's provider connId
  const aiLabel = $derived.by(() => {
    const connId = modelSelection.llm?.connId;
    if (!connId) return '';
    return friendlyProviderName(connId, { localLabel: 'Runs on this computer' });
  });

  // Voice = the bundled voice addon toggle.
  const voiceActive = $derived(s.voiceEnabled);

  // Active portals
  const activePortals = $derived(
    PORTALS.filter((ch) => isPortalEnabled(ch.id))
  );

  // Password reveal/copy state
  let passwordVisible = $state(false);
  let passwordCopied = $state(false);
  let passwordInputEl: HTMLInputElement | null = $state(null);
  // W12: the rerun password field starts collapsed — the default is "keep
  // the existing secret", so the input only appears once the operator asks
  // to replace it. Seeded from the STORE's dirty flag (not hardcoded false):
  // this component unmounts/remounts every time the wizard navigates off and
  // back onto step 3 (routes/setup/+page.svelte wraps it in `{#if
  // s.currentStep === 3}`), while `uiLoginPasswordDirty` lives in the
  // module-singleton store and survives that. Hardcoding false here used to
  // let a remount silently re-collapse an in-progress password change: the
  // store still had the typed password + dirty=true (so Update would send
  // and ROTATE it), but the UI rendered the "Previously set — not changed"
  // branch with dots, telling the operator nothing was changing. Seeding
  // from the store keeps the two in lockstep on every mount.
  let showRerunPasswordInput = $state(s.uiLoginPasswordDirty);

  function onPasswordInput(e: Event): void {
    s.updateUiLoginPassword((e.currentTarget as HTMLInputElement).value);
  }

  function cancelRerunPasswordChange(): void {
    s.cancelUiLoginPasswordChange();
    showRerunPasswordInput = false;
  }

  async function copyPassword(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(uiLoginPassword);
        passwordCopied = true;
        setTimeout(() => { passwordCopied = false; }, 2000);
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch {
      // Clipboard API unavailable (older browser, permissions) — the field is
      // a real input now, so fall back to focus+select for a manual Ctrl+C.
      if (passwordInputEl) {
        passwordInputEl.focus();
        passwordInputEl.select();
      }
    }
  }

  function saveConfig(config: unknown): void {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'openpalm-setup.json';
    a.click();
    URL.revokeObjectURL(url);
  }

</script>

<!-- Step title/lede come from the wizard shell header; no duplicate heading here. -->

{#if verifiedProviders.length === 0}
  <div class="review-note">
    No AI set up here yet — that's fine. After install you can connect this app to an
    assistant running on another computer, or add a provider, anytime from your dashboard.
  </div>
{/if}

<!-- ── Password block (tinted surface, no border) ──────────────── -->
{#if !isRerun}
  <div class="password-block">
    <label class="password-label" for="setup-ui-login-password">Sign-in password</label>
    <div class="password-row">
      <!-- W12: a real, editable field — a generated default the operator can
           just keep, or replace with their own. -->
      <input
        id="setup-ui-login-password"
        bind:this={passwordInputEl}
        class="password-value password-value--mono"
        type={passwordVisible ? 'text' : 'password'}
        autocomplete="new-password"
        spellcheck="false"
        value={uiLoginPassword}
        oninput={onPasswordInput}
        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        aria-invalid={!passwordValid}
        aria-describedby={!passwordValid ? 'password-error' : undefined}
      />
      <div class="password-actions">
        <!-- Reveal/hide toggle -->
        <button
          type="button"
          class="btn-icon"
          aria-label={passwordVisible ? 'Hide password' : 'Show password'}
          onclick={() => { passwordVisible = !passwordVisible; }}
          title={passwordVisible ? 'Hide' : 'Show'}
        >
          {#if passwordVisible}
            <!-- Eye-off icon -->
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 2l12 12"/>
              <path d="M6.7 6.8A3 3 0 009.3 9.2M4 4.5C2.5 5.7 1.5 7 1 8c1 2.5 3.8 5 7 5a8.4 8.4 0 003-.6M7 3.1A8.4 8.4 0 018 3c3.2 0 6 2.5 7 5-.4 1-.9 1.9-1.7 2.7"/>
            </svg>
          {:else}
            <!-- Eye icon -->
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/>
              <circle cx="8" cy="8" r="2"/>
            </svg>
          {/if}
        </button>
        <!-- Copy button -->
        <button
          type="button"
          class="btn-icon"
          class:btn-icon--copied={passwordCopied}
          aria-label={passwordCopied ? 'Copied!' : 'Copy password'}
          onclick={() => void copyPassword()}
          title="Copy"
        >
          {#if passwordCopied}
            <!-- Check icon -->
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 8l4 4 8-8"/>
            </svg>
          {:else}
            <!-- Copy icon -->
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="5" y="5" width="8" height="8" rx="1.5"/>
              <path d="M3 11V3h8"/>
            </svg>
          {/if}
        </button>
      </div>
    </div>
    {#if !passwordValid}
      <p class="password-error" id="password-error" role="alert">Password must be at least 8 characters.</p>
    {/if}
    <p class="password-note">This becomes your sign-in password when you install — keep a copy somewhere safe, or edit it above.</p>
  </div>
{:else if !showRerunPasswordInput}
  <div class="password-block">
    <p class="password-label">Sign-in password</p>
    <div class="password-row">
      <span class="password-value password-value--dots" aria-label="Sign-in password">••••••••</span>
      <div class="password-actions">
        <button type="button" class="btn-text" onclick={() => { showRerunPasswordInput = true; }}>
          Change password
        </button>
      </div>
    </div>
    <!-- Defensive: this branch should only ever render while passwordValid is
         true (collapsed ⇒ !uiLoginPasswordDirty ⇒ the isRerun && !dirty OR
         clause in passwordValid), but render the same error affordance the
         other two branches have rather than leaving a silently-disabled
         Update with no explanation if that invariant is ever broken. -->
    {#if !passwordValid}
      <p class="password-error" id="password-error" role="alert">Password must be at least 8 characters.</p>
    {/if}
    <p class="password-note">Previously set — not changed unless you set a new one.</p>
  </div>
{:else}
  <div class="password-block">
    <label class="password-label" for="setup-ui-login-password">New sign-in password</label>
    <div class="password-row">
      <input
        id="setup-ui-login-password"
        bind:this={passwordInputEl}
        class="password-value password-value--mono"
        type={passwordVisible ? 'text' : 'password'}
        autocomplete="new-password"
        spellcheck="false"
        placeholder="Type a new password"
        value={uiLoginPassword}
        oninput={onPasswordInput}
        aria-invalid={!passwordValid}
        aria-describedby={!passwordValid ? 'password-error' : undefined}
      />
      <div class="password-actions">
        <button
          type="button"
          class="btn-icon"
          aria-label={passwordVisible ? 'Hide password' : 'Show password'}
          onclick={() => { passwordVisible = !passwordVisible; }}
          title={passwordVisible ? 'Hide' : 'Show'}
        >
          {#if passwordVisible}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 2l12 12"/>
              <path d="M6.7 6.8A3 3 0 009.3 9.2M4 4.5C2.5 5.7 1.5 7 1 8c1 2.5 3.8 5 7 5a8.4 8.4 0 003-.6M7 3.1A8.4 8.4 0 018 3c3.2 0 6 2.5 7 5-.4 1-.9 1.9-1.7 2.7"/>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/>
              <circle cx="8" cy="8" r="2"/>
            </svg>
          {/if}
        </button>
        <button type="button" class="btn-text" onclick={cancelRerunPasswordChange}>Cancel</button>
      </div>
    </div>
    {#if !passwordValid}
      <p class="password-error" id="password-error" role="alert">Password must be at least 8 characters.</p>
    {/if}
  </div>
{/if}

<div id="network-access-section">
  <NetworkAccessStep />
</div>

<!-- ── What's being set up: hairline-divider summary rows ─────── -->
<div class="summary-list" aria-label="What's set up">
  <p class="summary-section-label">What's being set up</p>

  <!-- AI (always shown) -->
  {#if aiLabel}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true"><IconAgent size={16} /></span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">{aiLabel}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if verifiedProviders.length > 0}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true"><IconAgent size={16} /></span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">{friendlyProviderName(verifiedProviders[0].id)}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if ollamaEnabled}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true"><IconAgent size={16} /></span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">Runs on this computer</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if hostProviderLabel}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true"><IconAgent size={16} /></span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">{friendlyProviderName(hostProviderLabel)}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {/if}

  <!-- Voice (only if active) -->
  {#if voiceActive}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true"><IconMic size={16} /></span>
      <div class="summary-body">
        <div class="summary-key">Voice</div>
        <div class="summary-val">On — built-in voice</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditextras}>Change</button>
    </div>
  {/if}

  <!-- Network access (#563) -->
  <div class="summary-row">
    <span class="summary-icon" aria-hidden="true"><IconLock size={16} /></span>
    <div class="summary-body">
      <div class="summary-key">Network access</div>
      <div class="summary-val">{accessSummary}</div>
    </div>
    <button type="button" class="btn-change" onclick={oneditnetwork}>Change</button>
  </div>

  <!-- Portals (only those enabled) -->
  {#each activePortals as ch (ch.id)}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true">{ch.icon}</span>
      <div class="summary-body">
        <div class="summary-key">Chat app</div>
        <div class="summary-val">{ch.name}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditextras}>Change</button>
    </div>
  {/each}

</div>

{#if installError}
  <FriendlyError error={friendlyError(installError, 'setup-complete')} />
{/if}

{#if !systemCheckPassed}
  <div class="review-warning" role="alert">
    ⚠ System check has not passed yet — Install is disabled until Docker is confirmed available.
  </div>
{/if}

<!-- Save configuration utility: quiet link, no primary prominence -->
<div class="review-save-row">
  <button
    type="button"
    class="btn-save"
    onclick={() => saveConfig(payload)}
    aria-label="Save configuration as JSON file — contains your password and API keys in plain text"
  >
    Save configuration
  </button>
  <!-- W14: the download is the full install payload — password, provider API
       keys, and portal (Discord/Slack) tokens, all in plaintext. -->
  <span class="review-save-warning">Contains your password, API keys, and tokens in plain text — store it somewhere private.</span>
</div>

<style>
  /* ── Warning banner ────────────────────────────────────────────── */
  .review-warning {
    margin: 12px 0;
    padding: 10px 14px;
    background: rgba(242, 92, 92, 0.12);
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-seal);
  }

  /* ── Informational note (no-AI is a valid client-only choice) ──── */
  .review-note {
    margin: 12px 0;
    padding: 10px 14px;
    background: var(--s-paper-deep);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    line-height: 1.5;
    color: var(--s-ink-2);
  }

  /* ── Password block (tinted surface, rounded, no border) ──────── */
  .password-block {
    background: var(--s-paper-deep);
    border-radius: 2px;
    padding: 18px 20px;
    margin-bottom: 8px;
  }

  .password-label {
    display: block;
    font-size: var(--s-type-deed);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-bottom: 10px;
  }

  .password-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .password-value {
    flex: 1;
    word-break: break-all;
  }

  .password-value--mono {
    font-family: "Courier New", Courier, monospace;
    font-size: var(--s-type-whisper);
    font-weight: 600;
    color: var(--s-ink);
    letter-spacing: 0.04em;
    background: none;
    border: none;
    padding: 0;
    width: 100%;
  }

  input.password-value--mono:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
    border-radius: 2px;
  }

  input.password-value--mono[aria-invalid="true"] {
    color: var(--s-seal);
  }

  input.password-value--mono::placeholder {
    color: var(--s-ink-3);
    font-family: inherit;
    font-weight: 400;
    letter-spacing: normal;
  }

  .password-value--dots {
    font-family: inherit;
    letter-spacing: 0.18em;
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .password-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .password-error {
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    margin-top: 8px;
  }

  .btn-text {
    background: none;
    border: none;
    font-size: var(--s-type-deed);
    font-weight: 600;
    color: var(--s-ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 4px 0;
    min-height: 24px; /* WCAG 2.5.8 target size */
    white-space: nowrap;
    cursor: pointer;
    font-family: inherit;
    transition: color 150ms;
  }

  .btn-text:hover {
    color: var(--s-ink-2);
  }

  /* ── Icon buttons (reveal/copy) ────────────────────────────────── */
  .btn-icon {
    width: 34px;
    height: 34px;
    border-radius: 2px;
    border: var(--s-hair) solid var(--s-line);
    background: var(--s-paper);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--s-ink-2);
    cursor: pointer;
    transition: border-color 150ms, color 150ms, background 150ms;
    flex-shrink: 0;
  }

  .btn-icon:hover {
    border-color: var(--s-ink-2);
    color: var(--s-ink);
    background: var(--s-paper-deep);
  }

  .btn-icon--copied {
    border-color: color-mix(in srgb, var(--s-moss) 25%, transparent);
    color: var(--s-moss);
    background: color-mix(in srgb, var(--s-moss) 12%, transparent);
  }

  .password-note {
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    margin-top: 10px;
    line-height: 1.5;
  }

  /* ── Summary list: hairline dividers, no bordered cards ──────── */
  .summary-list {
    display: flex;
    flex-direction: column;
    margin-top: 24px;
  }

  .summary-section-label {
    font-size: var(--s-type-deed);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--s-ink-3);
    margin-bottom: 6px;
  }

  .summary-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 4px;
    border-top: var(--s-hair) solid var(--s-line);
  }

  .summary-row:last-child {
    border-bottom: var(--s-hair) solid var(--s-line);
  }

  .summary-icon {
    font-size: 18px;
    flex-shrink: 0;
    width: 24px;
    text-align: center;
  }

  .summary-body {
    flex: 1;
    min-width: 0;
  }

  .summary-key {
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    font-weight: 500;
  }

  .summary-val {
    font-size: var(--s-type-deed);
    font-weight: 500;
    color: var(--s-ink);
    margin-top: 1px;
  }

  .btn-change {
    background: none;
    border: none;
    font-size: var(--s-type-deed);
    font-weight: 600;
    color: var(--s-ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 4px 0;
    min-height: 24px; /* WCAG 2.5.8 target size */
    flex-shrink: 0;
    cursor: pointer;
    transition: color 150ms;
  }

  .btn-change:hover {
    color: var(--s-ink-2);
  }

  /* ── Save configuration quiet link ─────────────────────────────── */
  .review-save-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin: 16px 0 4px;
  }

  .btn-save {
    background: none;
    border: none;
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 4px 0;
    min-height: 24px; /* WCAG 2.5.8 target size */
    cursor: pointer;
    transition: color 150ms;
  }

  .btn-save:hover {
    color: var(--s-ink-2);
  }

  .review-save-warning {
    font-size: var(--s-type-whisper);
    color: var(--s-ink-3);
  }
</style>
