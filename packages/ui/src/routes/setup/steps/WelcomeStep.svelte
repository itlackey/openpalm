<script lang="ts">
  import Spinner from '$lib/components/common/Spinner.svelte';
  import type { SetupRecommendation } from '@openpalm/lib';
  interface Props {
    errorMessage: string;
    detectionReady: boolean;
    autoModeImporting: boolean;
    recommendation: SetupRecommendation | null;
    recommendationFetched: boolean;
    onnext: () => void;
    onusedefaults: () => void;
  }
  let {
    errorMessage,
    detectionReady,
    autoModeImporting,
    recommendation,
    recommendationFetched,
    onnext,
    onusedefaults,
  }: Props = $props();

  // Concise provider summary — never dumps the full provider list. Shows a
  // plain count for 3+ providers, and at most 1–2 names (with "+N more") for
  // small sets. `verb` = "Detected"/"Found", `state` = "connected"/"running…".
  function summarizeProviders(names: string[], verb: string, state: string): string {
    const n = names.length;
    if (n === 0) return `${verb} a ${state} provider`;
    if (n === 1) return `${verb} ${names[0]} ${state}`;
    if (n === 2) return `${verb} ${names[0]} and ${names[1]} ${state}`;
    if (n === 3) return `${verb} ${n} ${state} providers (${names[0]}, ${names[1]} +1 more)`;
    return `${verb} ${n} ${state} providers (${names[0]}, ${names[1]} +${n - 2} more)`;
  }

  // Concise, friendly detection + recommendation summary shown BEFORE the user
  // commits. Derives from the recommendation's action + detail fields. Falls
  // back to the recommendation's own `alert` text, then to generic copy so the
  // wizard never hard-fails when /api/setup/recommend is unavailable.
  const summary = $derived.by((): { headline: string; detail: string } | null => {
    const rec = recommendation;
    if (!rec) return null;
    switch (rec.action) {
      case 'enable-ollama':
        return {
          headline: `Detected ${rec.gpu.name} — recommended setup will run models locally with Ollama.`,
          detail: 'No external account or API key needed.',
        };
      case 'use-host-providers': {
        const names = rec.hostProviders.map((p) => p.provider);
        return {
          headline: `${summarizeProviders(names, 'Found', 'running on your computer')} — recommended setup will use ${names.length === 1 ? 'it' : 'them'}.`,
          detail: 'Takes you to Models to confirm the auto-selected model before continuing.',
        };
      }
      case 'use-cloud': {
        const names = rec.cloudProviders;
        return {
          headline: names.length
            ? `${summarizeProviders(names, 'Detected', 'connected')} — recommended setup will use ${names.length === 1 ? 'it' : 'them'}.`
            : 'Detected a connected provider — recommended setup will use it.',
          detail: 'Skips to Options with an auto-selected model — you can adjust models later.',
        };
      }
      case 'connect-manually':
        return {
          headline: 'No AI provider or capable GPU detected.',
          detail: "You'll connect a provider on the next step.",
        };
    }
  });

  // Label the primary button with the concrete action where it's meaningful.
  const useDefaultsLabel = $derived(
    recommendation?.action === 'connect-manually'
      ? 'Connect a provider'
      : 'Use recommended setup',
  );
</script>

<div class="welcome-hero" id="welcome-hero">
  <div class="welcome-icon">👋</div>
  <h2>Welcome to OpenPalm</h2>
  <p class="welcome-subtitle">Your self-hosted AI assistant. Pick your providers, choose models, and you're up and running.</p>

  <!-- Detection + recommendation summary: shown before the user commits. -->
  {#if !recommendationFetched && !recommendation}
    <div class="feedback feedback--info welcome-detection" data-testid="recommendation-alert">
      <Spinner /> <span>Checking your system…</span>
    </div>
  {:else if summary}
    <div class="feedback feedback--info welcome-detection" role="status" data-testid="recommendation-alert">
      <span class="welcome-detection-headline">{summary.headline}</span>
      <span class="welcome-detection-detail">{summary.detail}</span>
    </div>
  {/if}

  {#if errorMessage}
    <div class="feedback feedback--error" id="step0-error" role="alert"><span>{errorMessage}</span></div>
  {/if}

  <div class="welcome-actions">
    <button class="btn btn-primary btn-lg" id="btn-use-defaults" onclick={onusedefaults}
      disabled={!detectionReady || autoModeImporting}>
      {#if autoModeImporting}
        <Spinner /> Importing providers…
      {:else if !detectionReady}
        <Spinner /> Detecting your system…
      {:else}
        {useDefaultsLabel}
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
    /* Match .welcome-detection so the card and buttons form a single clean,
       centered column. */
    max-width: 420px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  /* Info variant — app.css ships --color-info / --color-info-bg with both
     light and dark values, so light/dark is preserved. No global
     .feedback--info exists; scope it here. */
  .feedback--info {
    background: var(--color-info-bg, rgba(51, 154, 240, 0.1));
    border: 1px solid var(--color-info, #339af0);
    color: var(--color-text);
  }
  .welcome-detection {
    margin-top: 20px;
    margin-bottom: 4px;
    width: 100%;
    /* Match .welcome-actions .btn so the card and buttons share one column. */
    max-width: 420px;
    /* Center the card within .welcome-hero like the buttons do — covers both
       the grid-parent (justify-self) and flex-parent (align-self) cases. The
       internal alignment stays left (align-items/text-align below). */
    justify-self: center;
    align-self: center;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    text-align: left;
  }
  .welcome-detection-headline {
    font-weight: 600;
  }
  .welcome-detection-detail {
    opacity: 0.85;
    font-size: 0.9em;
  }
</style>
