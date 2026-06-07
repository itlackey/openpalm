<script lang="ts">
  import type { Snippet } from 'svelte';

  // The standard app button. Every icon button in the chrome (navbar gear/chat,
  // new-chat, theme, voice, drawer triggers) renders through this so they share
  // one size, border, radius, hover, and focus treatment. Supports an optional
  // visible text label and an optional "selected" (on) look used by ToggleButton.
  interface Props {
    /** Icon contents (an inline <svg> or spinner). */
    icon: Snippet;
    /** Optional visible label; when present the button grows from a square to a pill. */
    label?: string;
    title?: string;
    ariaLabel?: string;
    disabled?: boolean;
    /** Render as an anchor instead of a button when a destination is given. */
    href?: string;
    onclick?: (e: MouseEvent) => void;
    type?: 'button' | 'submit';
    /** "On"/active look (used by ToggleButton and active states). */
    selected?: boolean;
    /** Colour of the selected state. */
    tone?: 'primary' | 'danger';
    /** Mirrors the toggle state for assistive tech (set by ToggleButton). */
    ariaPressed?: boolean;
  }

  let {
    icon,
    label,
    title,
    ariaLabel,
    disabled = false,
    href,
    onclick,
    type = 'button',
    selected = false,
    tone = 'primary',
    ariaPressed,
  }: Props = $props();
</script>

{#if href}
  <a
    class="icon-btn"
    class:has-label={label}
    class:selected
    class:tone-danger={tone === 'danger'}
    {href}
    title={title ?? ariaLabel ?? label}
    aria-label={ariaLabel ?? label}
    aria-disabled={disabled || undefined}
    {onclick}
  >
    {@render icon()}
    {#if label}<span class="icon-btn-label">{label}</span>{/if}
  </a>
{:else}
  <button
    class="icon-btn"
    class:has-label={label}
    class:selected
    class:tone-danger={tone === 'danger'}
    {type}
    {disabled}
    title={title ?? ariaLabel ?? label}
    aria-label={ariaLabel ?? label}
    aria-pressed={ariaPressed}
    {onclick}
  >
    {@render icon()}
    {#if label}<span class="icon-btn-label">{label}</span>{/if}
  </button>
{/if}

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 40px;
    height: 40px;
    padding: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    text-decoration: none;
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast),
      border-color var(--transition-fast);
  }

  /* With a visible label the button becomes an auto-width pill. */
  .icon-btn.has-label {
    width: auto;
    padding: 0 var(--space-3);
  }

  .icon-btn-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    white-space: nowrap;
  }

  .icon-btn :global(svg) {
    flex-shrink: 0;
  }

  .icon-btn:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--color-text);
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .icon-btn:disabled,
  .icon-btn[aria-disabled='true'] {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* Selected / "on" look — primary by default, danger when tone="danger".
     Mirrors the speaker (primary) and mic-recording (danger) treatments. */
  .icon-btn.selected {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
  }
  .icon-btn.selected:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
  .icon-btn.selected.tone-danger {
    color: var(--color-danger);
    border-color: var(--color-danger);
    background: var(--color-danger-bg);
  }
  .icon-btn.selected.tone-danger:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }
</style>
