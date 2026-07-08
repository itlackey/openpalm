<script lang="ts">
  import IconClose from '@openpalm/ui-kit/components/icons/IconClose.svelte';

  interface Props {
    operationResult: string;
    operationResultType: 'success' | 'error' | 'info';
    onDismissResult: () => void;
  }

  let { operationResult, operationResultType, onDismissResult }: Props = $props();
</script>

<!-- Operation output -->
{#if operationResult}
  <section class="output-section output-section--{operationResultType}">
    <div class="output-header">
      <h3>Operation output</h3>
      <button class="btn-ghost" aria-label="Dismiss" onclick={onDismissResult}>
        <IconClose size={14} />
      </button>
    </div>
    <pre class="output-code">{operationResult}</pre>
  </section>
{/if}

<style>
  /* ── Output ── */
  .output-section {
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: var(--s-sp-6);
  }
  .output-section--success { border-color: var(--s-moss); }
  .output-section--error   { border-color: var(--s-seal); }
  .output-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--s-sp-3) var(--s-sp-5);
    background: var(--s-paper-deep);
    border-bottom: var(--s-hair) solid var(--s-line);
  }
  .output-header h3 {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .output-code {
    margin: 0;
    padding: var(--s-sp-4) var(--s-sp-5);
    max-height: 320px;
    overflow: auto;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    line-height: 1.6;
    color: #e4e8f0;
    background: #1e2330;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
