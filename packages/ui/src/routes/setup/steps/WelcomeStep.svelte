<script lang="ts">
  interface Props {
    errorMessage: string;
    detectionReady: boolean;
    hasVerifiedProviders: boolean;
    autoModeImporting: boolean;
    enableVoice: boolean;
    onnext: () => void;
    onusedefaults: () => void;
    onenablevoicechange: (v: boolean) => void;
  }
  let {
    errorMessage,
    detectionReady,
    hasVerifiedProviders,
    autoModeImporting,
    enableVoice,
    onnext,
    onusedefaults,
    onenablevoicechange,
  }: Props = $props();
</script>

<div class="welcome-hero" id="welcome-hero">
  <div class="welcome-icon">👋</div>
  <h2>Welcome to OpenPalm</h2>
  <p class="welcome-subtitle">Your self-hosted AI assistant. Pick your providers, choose models, and you're up and running.</p>
  <div class="welcome-pills">
    <span class="pill">Cloud or local</span>
    <span class="pill">Smart defaults</span>
    <span class="pill">Privacy first</span>
  </div>
  <div class="token-callout" id="token-callout">
    We'll generate a secure UI login password for you. It's also stored in <code>~/.openpalm/config/stack/stack.env</code> as <code>OP_UI_LOGIN_PASSWORD</code>.
  </div>
  <label class="voice-toggle" id="voice-toggle-label">
    <input type="checkbox" checked={enableVoice} onchange={(e) => onenablevoicechange((e.target as HTMLInputElement).checked)} />
    <span class="voice-toggle-text">Enable Voice <span class="voice-toggle-hint">(local CPU, ~2.4 GB download)</span></span>
  </label>
  {#if errorMessage}
    <div class="field-error" id="step0-error" role="alert">{errorMessage}</div>
  {/if}
  <div class="welcome-actions">
    <button class="btn btn-primary-lg" id="btn-use-defaults" onclick={onusedefaults}
      disabled={!detectionReady || autoModeImporting}>
      {#if autoModeImporting}
        <span class="spinner"></span> Importing providers…
      {:else if !detectionReady}
        <span class="spinner"></span> Detecting your system… (a few seconds)
      {:else}
        Use recommended defaults
      {/if}
    </button>
    <button class="btn btn-secondary" id="btn-step0-next" onclick={onnext}>
      Continue
    </button>
  </div>
</div>

<style>
  .token-callout {
    margin: 16px 0 8px;
    padding: 10px 14px;
    background: var(--color-surface, #f8fafc);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 8px;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-secondary, #64748b);
    text-align: left;
    line-height: 1.5;
  }
  .token-callout code {
    font-family: monospace;
    background: var(--color-bg, #fff);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--color-border, #e2e8f0);
    font-size: 0.85em;
  }
  .welcome-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 20px;
    align-items: center;
    width: 100%;
  }
  .welcome-actions .btn {
    width: 100%;
    max-width: 320px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .voice-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 0 4px;
    cursor: pointer;
    user-select: none;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text, #1e293b);
  }
  .voice-toggle input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--color-primary, #4f6ef7);
    cursor: pointer;
    flex-shrink: 0;
  }
  .voice-toggle-hint {
    color: var(--color-text-secondary, #64748b);
    font-size: 0.85em;
  }
</style>
