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
    gap: var(--s-sp-2);
    width: 40px;
    height: 40px;
    padding: var(--s-sp-2);
    background: none;
    border: 0;
    border-radius: 50%;
    color: var(--s-ink-3);
    text-decoration: none;
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--s-t-quick) var(--s-ease);
  }

  /* With a visible label the button becomes an auto-width pill. */
  .icon-btn.has-label {
    width: auto;
    border-radius: 2px;
    padding: 0 var(--s-sp-3);
  }

  .icon-btn-label {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
  }

  .icon-btn :global(svg) {
    flex-shrink: 0;
  }

  .icon-btn:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--s-ink);
    background: none;
  }

  .icon-btn:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }

  .icon-btn:disabled,
  .icon-btn[aria-disabled='true'] {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Selected / "on" look — primary (seal) by default, danger when tone="danger". */
  .icon-btn.selected {
    color: var(--s-seal);
  }
  .icon-btn.selected:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--s-seal);
  }
  .icon-btn.selected.tone-danger {
    color: var(--s-seal);
  }
  .icon-btn.selected.tone-danger:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--s-seal);
  }
</style>
