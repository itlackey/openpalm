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
    /** Status for value and badge color: 'ok' (moss) or 'warn' (seal). */
    status?: 'ok' | 'warn' | undefined;
    /** Optional status badge text (e.g. "configured", "3 active"). */
    badge?: string;
  }

  let { label, onClick, value = null, sub = null, loaded = true, icon, status, badge }: Props = $props();
</script>

<button class="tile" onclick={onClick}>
  {#if icon}
    <span class="tile-metric tile-metric--icon" aria-hidden="true">
      {@render icon()}
    </span>
  {:else}
    <span class="tile-metric" class:tile-metric--ok={status === 'ok'} class:tile-metric--warn={status === 'warn'}>
      {#if loaded}{value}{#if sub}<span class="tile-metric-sub">{sub}</span>{/if}{:else}—{/if}
    </span>
  {/if}
  <span class="tile-label">{label}</span>
  {#if badge}
    <span class="s-tile-badge" class:s-tile-badge--ok={status === 'ok'} class:s-tile-badge--warn={status === 'warn'}>
      {badge}
    </span>
  {/if}
</button>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-4) var(--s-sp-5);
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
    font-family: var(--s-font-display);
    appearance: none;
    transition: border-color 0.12s ease;
  }
  .tile:hover {
    border-color: var(--s-line);
  }
  .tile:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }
  .tile-metric {
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    font-weight: 400;
    color: var(--s-ink);
    line-height: 1.1;
  }
  .tile-metric--ok {
    color: var(--s-moss);
  }
  .tile-metric--warn {
    color: var(--s-seal);
  }
  .tile-metric-sub {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    font-weight: 400;
    color: var(--s-ink-2);
  }
  .tile-metric--icon {
    color: var(--s-ink-3);
  }
  .tile-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .s-tile-badge {
    display: inline-flex;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    padding: 0.1em 0.6em;
    border-radius: 2px;
    border: var(--s-hair) solid currentColor;
    margin-top: auto;
    color: var(--s-ink-3);
  }
  .s-tile-badge--ok {
    color: var(--s-moss);
  }
  .s-tile-badge--warn {
    color: var(--s-seal);
  }
</style>
