<script lang="ts">
  import { STEP_LABELS } from '$lib/wizard/constants.js';

  interface Props {
    currentStep: number;
    maxVisitedStep: number;
    onnavigate: (step: number) => void;
    canNavigateTo: (step: number) => boolean;
  }
  let { currentStep, maxVisitedStep, onnavigate, canNavigateTo }: Props = $props();
</script>

<nav class="prog-bar" aria-label="Wizard steps">
  <div class="prog-segments">
    {#each STEP_LABELS as _, i}
      <div class="prog-seg {i <= currentStep ? 'on' : ''}"></div>
    {/each}
  </div>
  <div class="prog-labels">
    {#each STEP_LABELS as label, i}
      <span
        class="prog-lbl {i <= currentStep ? 'on' : ''} {i === currentStep ? 'active' : ''}"
        role="button"
        tabindex={i <= maxVisitedStep && canNavigateTo(i) ? 0 : -1}
        onclick={() => { if (i <= maxVisitedStep && canNavigateTo(i)) onnavigate(i); }}
        onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && i <= maxVisitedStep && canNavigateTo(i)) onnavigate(i); }}
        aria-label="Go to step {label}"
      >{label}</span>
    {/each}
  </div>
</nav>
