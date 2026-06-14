<script lang="ts">
  import { CHANNELS, PROVIDERS } from '$lib/client/constants.js';
  import type { Provider, ModelSelection, ChannelState } from '$lib/client/types.js';
  import { isChannelEnabled as _isChannelEnabled } from '$lib/client/helpers.js';
  import FriendlyError from '$lib/components/common/FriendlyError.svelte';
  import { friendlyError } from '$lib/client/error-messages.js';

  interface Props {
    uiLoginPassword: string;
    verifiedProviders: Provider[];
    modelSelection: { llm?: ModelSelection; embedding?: ModelSelection; small?: ModelSelection };
    activeTts: string;
    activeStt: string;
    voiceProfileLabel?: string;
    ollamaProfileLabel?: string;
    channelSelection: Record<string, boolean | ChannelState>;
    ollamaEnabled: boolean;
    /** When true and no host provider running, hide the Infrastructure card entirely. */
    cloudOnly?: boolean;
    /** Label for the running host provider (e.g. "Ollama"). Shown when ollamaEnabled is false. */
    hostProviderLabel?: string;
    payload: unknown;
    installError: string;
    installing: boolean;
    isRerun?: boolean;
    systemCheckPassed?: boolean;
    onback: () => void;
    oninstall: () => void;
    oneditmodels: () => void;
    oneditextras: () => void;
  }

  let {
    uiLoginPassword,
    verifiedProviders,
    modelSelection,
    activeTts,
    activeStt,
    channelSelection,
    ollamaEnabled,
    hostProviderLabel = '',
    payload,
    installError,
    installing,
    isRerun = false,
    systemCheckPassed = true,
    onback: _onback,
    oninstall: _oninstall,
    oneditmodels,
    oneditextras,
  }: Props = $props();

  // ── Local provider ids (for friendly name lookup) ────────────────────
  const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'localai', 'model-runner']);

  function friendlyProviderName(connId: string): string {
    if (!connId) return '';
    if (connId === 'openai') return 'ChatGPT (OpenAI)';
    if (connId === 'google') return 'Gemini (Google)';
    if (connId === 'github-copilot') return 'GitHub Copilot';
    if (connId === 'groq') return 'Groq';
    if (LOCAL_PROVIDER_IDS.has(connId)) return 'Runs on this computer';
    // Fall back to the static PROVIDERS list display name
    const found = PROVIDERS.find((p) => p.id === connId);
    return found?.name ?? connId;
  }

  function isChannelEnabled(chId: string, locked?: boolean): boolean {
    return _isChannelEnabled(channelSelection, chId, locked);
  }

  // Friendly AI label: resolved from the chat model's provider connId
  const aiLabel = $derived.by(() => {
    const connId = modelSelection.llm?.connId;
    if (!connId) return '';
    return friendlyProviderName(connId);
  });

  // Voice is active when either side has an actual engine (not skip/empty)
  const voiceActive = $derived(
    !!(activeTts && !activeTts.startsWith('skip-')) ||
    !!(activeStt && !activeStt.startsWith('skip-'))
  );

  // Active non-locked channels
  const activeChannels = $derived(
    CHANNELS.filter((ch) => !ch.locked && isChannelEnabled(ch.id, ch.locked))
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

  const canInstall = $derived(!installing && systemCheckPassed);
</script>

<!-- Step title/lede come from the wizard shell header; no duplicate heading here. -->

{#if verifiedProviders.length === 0}
  <div class="review-warning" role="alert">
    ⚠ No AI provider connected — your assistant won't be able to chat until you add one from the dashboard.
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
      <span class="summary-icon" aria-hidden="true">🤖</span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">{aiLabel}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if verifiedProviders.length > 0}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true">🤖</span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">{friendlyProviderName(verifiedProviders[0].id)}</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if ollamaEnabled}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true">🤖</span>
      <div class="summary-body">
        <div class="summary-key">AI</div>
        <div class="summary-val">Runs on this computer</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditmodels}>Change</button>
    </div>
  {:else if hostProviderLabel}
    <div class="summary-row">
      <span class="summary-icon" aria-hidden="true">🤖</span>
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
      <span class="summary-icon" aria-hidden="true">🎙</span>
      <div class="summary-body">
        <div class="summary-key">Voice</div>
        <div class="summary-val">On — built-in voice</div>
      </div>
      <button type="button" class="btn-change" onclick={oneditextras}>Change</button>
    </div>
  {/if}

  <!-- Channels (only those enabled) -->
  {#each activeChannels as ch (ch.id)}
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
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-danger);
  }

  /* ── Password block (tinted surface, rounded, no border) ──────── */
  .password-block {
    background: var(--color-bg-secondary);
    border-radius: var(--radius-lg);
    padding: 18px 20px;
    margin-bottom: 8px;
  }

  .password-label {
    font-size: var(--text-xs, 0.75rem);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-tertiary);
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
    font-size: var(--text-lg, 1rem);
    font-weight: 600;
    color: var(--color-text);
    letter-spacing: 0.04em;
    background: none;
    border: none;
    padding: 0;
    width: 100%;
  }

  .password-value--dots {
    font-family: inherit;
    letter-spacing: 0.18em;
    font-size: var(--text-base, 0.875rem);
    color: var(--color-text-secondary);
  }

  .password-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .rerun-note {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-tertiary);
    font-style: italic;
  }

  /* ── Icon buttons (reveal/copy) ────────────────────────────────── */
  .btn-icon {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-md, 8px);
    border: 1px solid var(--color-border-hover);
    background: var(--color-surface);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: border-color 150ms, color 150ms, background 150ms;
    flex-shrink: 0;
  }

  .btn-icon:hover {
    border-color: var(--color-text-secondary);
    color: var(--color-text);
    background: var(--color-bg-secondary);
  }

  .btn-icon--copied {
    border-color: var(--color-success-border);
    color: var(--color-success-text);
    background: var(--color-success-bg);
  }

  .password-note {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-tertiary);
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
    font-size: var(--text-xs, 0.75rem);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-tertiary);
    margin-bottom: 6px;
  }

  .summary-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 4px;
    border-top: 1px solid var(--color-border);
  }

  .summary-row:last-child {
    border-bottom: 1px solid var(--color-border);
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
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text-tertiary);
    font-weight: 500;
  }

  .summary-val {
    font-size: var(--text-base, 0.875rem);
    font-weight: 500;
    color: var(--color-text);
    margin-top: 1px;
  }

  .btn-change {
    background: none;
    border: none;
    font-size: var(--text-sm, 0.8125rem);
    font-weight: 600;
    color: var(--color-text-tertiary);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 4px 0;
    flex-shrink: 0;
    cursor: pointer;
    transition: color 150ms;
  }

  .btn-change:hover {
    color: var(--color-text-secondary);
  }

  /* ── Save configuration quiet link ─────────────────────────────── */
  .review-save-row {
    margin: 16px 0 4px;
  }

  .btn-save {
    background: none;
    border: none;
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text-tertiary);
    text-decoration: underline;
    text-underline-offset: 2px;
    padding: 4px 0;
    cursor: pointer;
    transition: color 150ms;
  }

  .btn-save:hover {
    color: var(--color-text-secondary);
  }
</style>
