<script lang="ts">
  /**
   * LocalModelsStatus — shows the local model runtime state for Screen 1.
   *
   * Takes NO props: reads the setup-state store directly (detected host runtimes,
   * GPU info, in-stack Ollama selection) and calls its recommendation re-check,
   * mirroring Screen1ModelsStep / ReviewStep.
   */

  import { setupState } from '$lib/setup/setup-state.svelte.js';
  import { friendlyProviderName } from '$lib/client/constants.js';

  const s = setupState;

  const hostProviders = $derived(s.detectedHostProviders);
  const gpuVramMb = $derived(s.detectedGpuVramMb);
  const gpuVendor = $derived(s.detectedGpuVendor);
  const gpuName = $derived(s.detectedGpuName);
  const ollamaEnabled = $derived(s.ollamaEnabled);
  const selectedOllamaProfile = $derived(s.selectedOllamaProfile);
  // force:true — a plain call would early-return once the wizard already
  // applied a recommendation (which it always has by the time this row is
  // visible), so the button would silently do nothing. The whole point of
  // Re-check is to re-probe NOW, after the user installed/started Ollama
  // outside the wizard.
  const onrecheck = (): void => void s.fetchAndApplyRecommendation(true);

  const isAppleSilicon = $derived(gpuVendor === 'apple');
  const hasRunningRuntime = $derived(hostProviders.length > 0);
  const gpuGb = $derived(Math.round(gpuVramMb / 1024));
  // The profile id is a full id like 'addon.ollama.cuda' — match by suffix, not equality.
  const profileLabel = $derived(
    selectedOllamaProfile.endsWith('cuda') ? 'CUDA' :
    selectedOllamaProfile.endsWith('rocm') ? 'ROCm' : 'CPU'
  );

  // G-series: friendlyProviderName (constants.js, backed by the PROVIDERS
  // catalog) already resolves these three ids — this used to keep its own
  // copy of the same three labels (a third copy, alongside
  // SystemCheckStep.svelte's — now also on the shared helper).
  const runtimeLabel = friendlyProviderName;
</script>

<div class="local-models-status">
  {#if hasRunningRuntime}
    <!-- Runtime already running on host -->
    <div class="status-row status-row--running" role="status">
      <span class="status-icon" aria-hidden="true">●</span>
      <span class="status-text">
        Using {hostProviders.map(p => runtimeLabel(p.provider)).join(', ')} already running on your machine.
      </span>
    </div>

  {:else if isAppleSilicon}
    <!-- Apple Silicon — need Ollama for Mac installed first -->
    <div class="status-callout status-callout--apple" role="note">
      <div class="callout-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div class="callout-body">
        <p class="callout-title">Apple Silicon detected</p>
        <p class="callout-desc">
          For best performance, install
          <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama for macOS</a>
          and leave it running before continuing. Once Ollama is running, click Re-check to continue.
        </p>
        <button
          class="btn-recheck"
          type="button"
          onclick={onrecheck}
          id="btn-local-recheck"
        >
          Re-check
        </button>
      </div>
    </div>

  {:else if ollamaEnabled && gpuVramMb >= 8192}
    <!-- Will install Ollama in-stack (GPU detected) -->
    <div class="status-row status-row--will-install" role="status">
      <span class="status-icon" aria-hidden="true">◎</span>
      <span class="status-text">
        Will install Ollama in the stack
        {#if gpuName}(GPU: {gpuName}, {gpuGb} GB, profile: {profileLabel}){/if}.
        First pull downloads ~4–8 GB.
      </span>
    </div>

  {:else if ollamaEnabled}
    <!-- Will install Ollama in-stack (no GPU) -->
    <div class="status-row status-row--will-install" role="status">
      <span class="status-icon" aria-hidden="true">◎</span>
      <span class="status-text">
        Will install Ollama in the stack (CPU mode). First pull downloads ~4–8 GB.
      </span>
    </div>
  {/if}
</div>

<style>
  .local-models-status {
    margin: 8px 0 0;
  }

  .status-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 2px;
    font-size: var(--s-type-deed);
  }

  .status-row--running {
    background: color-mix(in srgb, var(--s-moss) 12%, transparent);
    border: var(--s-hair) solid var(--s-moss);
    color: var(--s-ink);
  }

  .status-row--will-install {
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line);
    color: var(--s-ink);
  }

  .status-icon {
    flex-shrink: 0;
    margin-top: 1px;
    color: inherit;
  }

  .status-row--running .status-icon { color: var(--s-moss); }
  .status-row--will-install .status-icon { color: var(--s-ink-2); }

  .status-text {
    flex: 1;
    min-width: 0;
  }

  /* Apple Silicon callout */
  .status-callout {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 2px;
  }

  .status-callout--apple {
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-seal);
    color: var(--s-ink);
  }

  .callout-icon {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--s-seal);
  }

  .callout-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .callout-title {
    font-size: var(--s-type-deed);
    font-weight: 400;
    color: var(--s-ink);
    margin: 0;
  }

  .callout-desc {
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    margin: 0;
    line-height: 1.5;
  }

  .callout-desc a {
    color: var(--s-seal);
    text-underline-offset: 2px;
  }

  .btn-recheck {
    margin-top: 8px;
    padding: 6px 14px;
    background: none;
    border: var(--s-hair) solid var(--s-seal);
    border-radius: 2px;
    font-size: var(--s-type-deed);
    color: var(--s-seal);
    cursor: pointer;
    font-weight: 400;
    align-self: flex-start;
    /* WCAG 2.5.8: min 24×24 touch target */
    min-height: 36px;
  }

  .btn-recheck:hover {
    background: color-mix(in srgb, var(--s-seal) 8%, transparent);
    border-color: var(--s-seal);
    color: var(--s-ink);
  }
</style>
