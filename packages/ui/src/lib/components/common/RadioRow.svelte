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
    gap: 10px;
    min-height: 44px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.1s;
    margin-bottom: 2px;
    border: 1.5px solid transparent;
  }

  .radio-row:hover {
    background: var(--color-bg-secondary);
  }

  .radio-row:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .radio-row.selected {
    background: var(--color-primary-subtle);
    border-color: var(--color-primary-border);
  }

  .radio-row.hidden {
    display: none !important;
  }

  .radio-row-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .radio-row.selected .radio-row-dot {
    border-color: var(--color-primary-hover);
  }

  .radio-row-dot-inner {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
  }

  .radio-row.selected .radio-row-dot-inner {
    background: var(--color-primary-hover);
  }

  .radio-row-body {
    flex: 1;
    min-width: 0;
  }

  .radio-row-title {
    font-size: 13px;
    color: var(--color-text-secondary);
  }

  .radio-row.selected .radio-row-title {
    color: var(--color-text);
    font-weight: var(--font-medium);
  }

  .radio-row-meta {
    font-size: 12px;
    color: var(--color-text-secondary);
    margin-top: 1px;
  }

  .radio-row-badge {
    font-size: 12px;
    font-weight: var(--font-semibold);
    padding: 2px 6px;
    border-radius: 4px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-left: auto;
    flex-shrink: 0;
  }

  .radio-row-badge.top {
    background: var(--color-primary-subtle);
    color: var(--color-text);
  }

  .radio-row-badge.auto {
    background: var(--color-blue-soft, #eff6ff);
    color: var(--color-blue, #2563eb);
  }
</style>
