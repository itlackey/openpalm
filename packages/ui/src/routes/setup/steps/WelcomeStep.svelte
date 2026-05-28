<script lang="ts">
  interface Props {
    errorMessage: string;
    detectionReady: boolean;
    hasVerifiedProviders: boolean;
    autoModeImporting: boolean;
    enableVoice: boolean;
    includeOllama: boolean;
    onnext: () => void;
    onusedefaults: () => void;
    onenablevoicechange: (v: boolean) => void;
    onollamachange: (v: boolean) => void;
  }
  let {
    errorMessage,
    detectionReady,
    hasVerifiedProviders,
    autoModeImporting,
    enableVoice,
    includeOllama,
    onnext,
    onusedefaults,
    onenablevoicechange,
    onollamachange,
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

  <div class="welcome-options">
    <label class="option-row" id="voice-toggle-label">
      <span class="toggle-switch">
        <input type="checkbox" checked={enableVoice} onchange={(e) => onenablevoicechange((e.target as HTMLInputElement).checked)} />
        <span class="toggle-track"></span>
      </span>
      <span class="option-text">
        <span class="option-label">Enable Voice</span>
        <span class="option-desc">One-time local voice download</span>
      </span>
    </label>

    <label class="option-row" id="ollama-toggle-label">
      <span class="toggle-switch">
        <input type="checkbox" checked={includeOllama} onchange={(e) => onollamachange((e.target as HTMLInputElement).checked)} />
        <span class="toggle-track"></span>
      </span>
      <span class="option-text">
        <span class="option-label">Include Ollama</span>
        <span class="option-desc">Run local models inside the stack</span>
      </span>
    </label>
  </div>

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
  .welcome-options {
    width: 100%;
    max-width: 360px;
    margin: 24px auto 0;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e2e8f0);
    border-radius: 10px;
    overflow: hidden;
  }
  .option-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s ease;
  }
  .option-row:hover {
    background: var(--color-surface-hover, #f8fafc);
  }
  .option-row + .option-row {
    border-top: 1px solid var(--color-border, #e2e8f0);
  }
  .option-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .option-label {
    font-size: var(--text-sm, 0.875rem);
    font-weight: 500;
    color: var(--color-text, #1e293b);
  }
  .option-desc {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary, #64748b);
  }
  .toggle-switch {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  .toggle-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-track {
    display: block;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: #cbd5e1;
    transition: background 0.2s ease;
    position: relative;
  }
  .toggle-track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    transition: transform 0.2s ease;
  }
  .toggle-switch input:checked + .toggle-track {
    background: var(--color-primary, #4f6ef7);
  }
  .toggle-switch input:checked + .toggle-track::after {
    transform: translateX(16px);
  }
  .welcome-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 24px;
    align-items: center;
    width: 100%;
  }
  .welcome-actions .btn {
    width: 100%;
    max-width: 360px;
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
</style>
