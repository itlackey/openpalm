<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    onClick: () => void;
    /** Primary metric value (rendered when no icon snippet is supplied). */
    value?: string | number | null;
    /** Secondary "/total" fragment shown next to the value. */
    sub?: string | null;
    /** Whether enough data has loaded to show value/sub (else shows an em dash). */
    loaded?: boolean;
    /** Decorative icon, mutually exclusive with value. */
    icon?: Snippet;
  }

  let { label, onClick, value = null, sub = null, loaded = true, icon }: Props = $props();
</script>

<button class="tile" onclick={onClick}>
  {#if icon}
    <span class="tile-metric tile-metric--icon" aria-hidden="true">
      {@render icon()}
    </span>
  {:else}
    <span class="tile-metric">
      {#if loaded}{value}{#if sub}<span class="tile-metric-sub">{sub}</span>{/if}{:else}—{/if}
    </span>
  {/if}
  <span class="tile-label">{label}</span>
</button>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .tile:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }
  .tile:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .tile-metric {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    line-height: 1.1;
  }
  .tile-metric-sub {
    font-size: var(--text-lg);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }
  .tile-metric--icon {
    color: var(--color-text-secondary);
  }
  .tile-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
</style>
