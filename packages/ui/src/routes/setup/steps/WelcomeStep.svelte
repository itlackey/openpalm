<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  interface Props {
    errorMessage: string;
    detectionReady: boolean;
    autoModeImporting: boolean;
    onnext: () => void;
    onusedefaults: () => void;
  }
  let {
    errorMessage,
    detectionReady,
    autoModeImporting,
    onnext,
    onusedefaults,
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

  {#if errorMessage}
    <div class="field-error" id="step0-error" role="alert">{errorMessage}</div>
  {/if}

  <div class="welcome-actions">
    <button class="btn btn-primary-lg" id="btn-use-defaults" onclick={onusedefaults}
      disabled={!detectionReady || autoModeImporting}>
      {#if autoModeImporting}
        <Spinner /> Importing providers…
      {:else if !detectionReady}
        <Spinner /> Detecting your system…
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
</style>
