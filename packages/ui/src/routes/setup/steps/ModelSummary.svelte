<script lang="ts">
  /**
   * ModelSummary — inline "Chat model: X via Y" display with a pencil-icon
   * edit button that opens a Drawer containing the model picker.
   *
   * For "both" modelMode, shows local as PRIMARY:
   *   "Primary: <local model>. Cloud models available for complex tasks."
   *
   * Props:
   *   modelMode          — 'cloud' | 'local' | 'both'
   *   llmModel           — selected chat model id (or empty string)
   *   llmProvider        — provider name for the selected chat model
   *   children           — drawer body content (model picker passed from parent)
   */

  import type { Snippet } from 'svelte';
  import Drawer from '$lib/components/common/Drawer.svelte';

  type ModelMode = 'cloud' | 'local' | 'both';

  interface Props {
    /** Which model mode was chosen on Screen 1. */
    modelMode: ModelMode;
    /** The currently selected chat model id. Empty string = not yet selected. */
    llmModel?: string;
    /** Human-readable provider name for the selected chat model. */
    llmProvider?: string;
    /** Drawer body — the model picker component rendered by the parent. */
    children?: Snippet;
  }

  let {
    modelMode,
    llmModel = '',
    llmProvider = '',
    children,
  }: Props = $props();

  let drawerOpen = $state(false);

  const summaryText = $derived.by(() => {
    if (!llmModel) return '';
    const via = llmProvider ? ` via ${llmProvider}` : '';
    if (modelMode === 'both') {
      return `Primary: ${llmModel}${via}. Cloud models available for complex tasks.`;
    }
    return `Chat model: ${llmModel}${via}`;
  });
</script>

{#if llmModel}
  <div class="model-summary" role="status" aria-live="polite">
    <span class="model-summary-text">{summaryText}</span>
    {#if children}
      <button
        type="button"
        class="btn-edit-model"
        onclick={() => { drawerOpen = true; }}
        aria-label="Edit chat model selection"
        id="btn-edit-model"
      >
        <!-- Pencil / edit icon — 44×44 touch target enforced via min-width/height -->
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    {/if}
  </div>
{/if}

{#if children}
  {@const drawerBody = children}
  <Drawer open={drawerOpen} title="Choose chat model" onClose={() => { drawerOpen = false; }}>
    {#snippet children()}
      {@render drawerBody()}
    {/snippet}
  </Drawer>
{/if}

<style>
  .model-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--s-paper);
    border: var(--s-hair) solid var(--s-line);
    border-radius: 2px;
    margin-top: 10px;
  }

  .model-summary-text {
    flex: 1;
    min-width: 0;
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    font-weight: 400;
  }

  .btn-edit-model {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* WCAG 2.5.8 / Nielsen D7: 44×44 px minimum touch target */
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 2px;
    color: var(--s-ink-2);
    cursor: pointer;
    flex-shrink: 0;
  }

  .btn-edit-model:hover {
    background: var(--s-paper);
    color: var(--s-ink);
  }

  .btn-edit-model:focus-visible {
    outline: 2px solid var(--s-seal);
    outline-offset: 2px;
  }
</style>
