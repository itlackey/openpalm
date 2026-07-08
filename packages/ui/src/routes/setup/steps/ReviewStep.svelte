<script lang="ts">
  import { PORTALS, friendlyProviderName } from '$lib/client/constants.js';
  import IconAgent from '@openpalm/ui-kit/components/icons/IconAgent.svelte';
  import IconMic from '@openpalm/ui-kit/components/icons/IconMic.svelte';
  import { isPortalEnabled as _isPortalEnabled } from '$lib/client/helpers.js';
  import FriendlyError from '@openpalm/ui-kit/components/common/FriendlyError.svelte';
  import { friendlyError } from '$lib/client/error-messages.js';
  import { setupState } from '$lib/setup/setup-state.svelte.js';

  // Takes NO props: this step reads the setup-state store directly. Local
  // aliases (`$derived` off the store) keep the rest of the component body
  // unchanged; the edit actions call the store's navigation.
  const s = setupState;

  const uiLoginPassword = $derived(s.uiLoginPassword);
  const verifiedProviders = $derived(s.verifiedProviders);
  const modelSelection = $derived(s.modelSelection);
  const activeTts = $derived(s.voiceEnabled ? s.displayedVoiceTts.engine : '');
  const activeStt = $derived(s.voiceEnabled ? s.displayedVoiceStt.engine : '');
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

  function isPortalEnabled(chId: string, locked?: boolean): boolean {
    return _isPortalEnabled(portalSelection, chId, locked);
  }

  // Friendly AI label: resolved from the chat model's provider connId
  const aiLabel = $derived.by(() => {
    const connId = modelSelection.llm?.connId;
    if (!connId) return '';
    return friendlyProviderName(connId, { localLabel: 'Runs on this computer' });
  });

  // Voice is active when either side has an actual engine (not skip/empty)
  const voiceActive = $derived(
    !!(activeTts && !activeTts.startsWith('skip-')) ||
    !!(activeStt && !activeStt.startsWith('skip-'))
  );

  // Active non-locked portals
  const activePortals = $derived(
    PORTALS.filter((ch) => !ch.locked && isPortalEnabled(ch.id, ch.locked))
  );

  // Password reveal/copy state
  let passwordVisible = $state(false);
  let passwordCopied = $state(false);
  let copyFallback = $state(false);
  let passwordInputEl: HTMLInputElement | null = $state(null);

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
      copyFallback = true;
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
    <p class="password-label">Sign-in password</p>
    <div class="password-row">
      {#if copyFallback}
        <input
          bind:this={passwordInputEl}
          class="password-value password-value--mono"
          type={passwordVisible ? 'text' : 'password'}
          readonly
          value={uiLoginPassword}
          onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
      {:else if passwordVisible}
        <span class="password-value password-value--mono" aria-label="Sign-in password">{uiLoginPassword}</span>
      {:else}
        <span class="password-value password-value--dots" aria-label="Sign-in password">••••••••••••••••</span>
      {/if}
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
    <p class="password-note">Already saved on this computer — keep a copy somewhere safe just in case.</p>
  </div>
{:else}
  <div class="password-block">
    <p class="password-label">Sign-in password</p>
    <div class="password-row">
      <span class="password-value password-value--dots" aria-label="Sign-in password">••••••••</span>
      <div class="password-actions">
        <span class="rerun-note">Previously set — not changed.</span>
      </div>
    </div>
  </div>
{/if}

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
    aria-label="Save configuration as JSON file"
  >
    Save configuration
  </button>
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

  .rerun-note {
    font-size: var(--s-type-deed);
    color: var(--s-ink-3);
    font-style: italic;
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
</style>
