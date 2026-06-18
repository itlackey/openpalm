<script lang="ts">
  interface Props {
    title: string;
    meta?: string;
    selected?: boolean;
    hidden?: boolean;
    badgeText?: string;
    badgeTone?: 'top' | 'auto';
    value?: string;
    onSelect: () => void;
  }

  let {
    title,
    meta = '',
    selected = false,
    hidden = false,
    badgeText,
    badgeTone = 'top',
    value,
    onSelect,
  }: Props = $props();
</script>

<div
  class:selected
  class:hidden
  class="radio-row"
  role="radio"
  aria-checked={selected}
  tabindex="0"
  data-model-select={value}
  onclick={onSelect}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') onSelect();
  }}
>
  <div class="radio-row-dot"><div class="radio-row-dot-inner"></div></div>
  <div class="radio-row-body">
    <div class="radio-row-title">{title}</div>
    {#if meta}
      <div class="radio-row-meta">{meta}</div>
    {/if}
  </div>
  {#if badgeText}
    <span class:top={badgeTone === 'top'} class:auto={badgeTone === 'auto'} class="radio-row-badge">{badgeText}</span>
  {/if}
</div>

<style>
  .radio-row {
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
    min-height: 44px;
    padding: var(--s-sp-3) var(--s-sp-4);
    border-radius: 2px;
    cursor: pointer;
    transition: background var(--s-t-quick) var(--s-ease);
    margin-bottom: 2px;
    border: var(--s-hair) solid transparent;
  }

  .radio-row:hover {
    background: var(--s-paper-deep);
  }

  .radio-row:focus-visible {
    outline: 2px solid var(--s-ink-2);
    outline-offset: 2px;
  }

  .radio-row.selected {
    background: color-mix(in srgb, var(--s-seal) 6%, var(--s-paper));
    border-color: color-mix(in srgb, var(--s-seal) 20%, transparent);
  }

  .radio-row.hidden {
    display: none !important;
  }

  .radio-row-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--s-line);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    transition: border-color var(--s-t-quick) var(--s-ease);
  }

  .radio-row.selected .radio-row-dot {
    border-color: var(--s-seal);
  }

  .radio-row-dot-inner {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
    transition: background var(--s-t-quick) var(--s-ease);
  }

  .radio-row.selected .radio-row-dot-inner {
    background: var(--s-seal);
  }

  .radio-row-body {
    flex: 1;
    min-width: 0;
  }

  .radio-row-title {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
  }

  .radio-row.selected .radio-row-title {
    color: var(--s-ink);
  }

  .radio-row-meta {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    margin-top: 1px;
  }

  .radio-row-badge {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    padding: var(--s-sp-1) var(--s-sp-2);
    border-radius: 2px;
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    margin-left: auto;
    flex-shrink: 0;
  }

  .radio-row-badge.top {
    background: color-mix(in srgb, var(--s-seal) 10%, var(--s-paper));
    color: var(--s-ink-2);
  }

  .radio-row-badge.auto {
    background: color-mix(in srgb, var(--s-moss) 10%, var(--s-paper));
    color: var(--s-moss);
  }
</style>
