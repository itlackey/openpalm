<script lang="ts">
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
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <pre class="output-code">{operationResult}</pre>
  </section>
{/if}

<style>
  /* ── Output ── */
  .output-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: var(--space-6);
  }
  .output-section--success { border-color: var(--color-success-border); }
  .output-section--error { border-color: var(--color-danger); }
  .output-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    background: var(--color-bg-secondary);
    border-bottom: 1px solid var(--color-border);
  }
  .output-header h3 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .output-code {
    margin: 0;
    padding: var(--space-4) var(--space-5);
    max-height: 320px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: #e4e8f0;
    background: #1e2330;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
