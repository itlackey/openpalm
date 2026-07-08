<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconClose from '../icons/IconClose.svelte';
  import { createFocusTrap, handleTrapKeydown } from '$lib/actions/focus-trap.js';

  // Reusable slide-in drawer (right edge). The app-wide replacement for inline
  // expand-in-place forms: edit flows open here instead of pushing page content
  // down and forcing the user to scroll.
  interface Props {
    open: boolean;
    title: string;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
    /** Optional content rendered at the start of the header (e.g. a back button). */
    headerStart?: Snippet;
    /** Drawer width (CSS length). */
    width?: string;
  }
  let { open, title, onClose, children, footer, headerStart, width = '32rem' }: Props = $props();

  // Focus management for the modal dialog (WCAG 2.4.3 / APG dialog pattern) via
  // the shared focus-trap primitives: on mount move focus into the body (so the
  // user doesn't land on Close), on unmount restore it; Escape closes and Tab is
  // trapped within the panel.
  const manageFocus = createFocusTrap({ initialFocus: '.drawer-body' });
</script>

{#if open}
  <!-- Decorative click-to-close backdrop; keyboard close is via Escape (trapped
       in the panel) and the header close button. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="drawer-scrim" onclick={onClose}></div>

  <div
    class="drawer"
    style="--drawer-width: {width}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={(e) => handleTrapKeydown(e, onClose)}
    {@attach manageFocus}
  >
    <header class="drawer-header">
      {#if headerStart}{@render headerStart()}{/if}
      <h3 class="drawer-title">{title}</h3>
      <button class="drawer-close" onclick={onClose} aria-label="Close">
        <IconClose size={18} />
      </button>
    </header>

    <div class="drawer-body">
      {@render children()}
    </div>

    {#if footer}
      <footer class="drawer-footer">{@render footer()}</footer>
    {/if}
  </div>
{/if}

<style>
  .drawer-scrim {
    position: fixed;
    inset: 0;
    background: rgba(38, 41, 43, 0.35);
    z-index: 200;
    border: none;
    padding: 0;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(var(--drawer-width, 32rem), 100vw);
    display: flex;
    flex-direction: column;
    background: var(--s-paper);
    border-left: var(--s-hair) solid var(--s-line);
    z-index: 201;
    animation: drawer-in var(--s-t-quick) var(--s-ease);
  }
  @keyframes drawer-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer { animation: none; }
  }
  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    padding: var(--s-sp-4) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    flex-shrink: 0;
  }
  .drawer-title {
    flex: 1;
    min-width: 0;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .drawer-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 50%;
    color: var(--s-ink-3);
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--s-t-quick) var(--s-ease);
  }
  .drawer-close:hover {
    color: var(--s-ink);
  }
  .drawer-close:focus-visible {
    outline: 2px solid var(--s-ink-2);
    outline-offset: 2px;
  }
  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--s-sp-5);
  }
  .drawer-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: var(--s-sp-2);
    padding: var(--s-sp-4) var(--s-sp-5);
    border-top: var(--s-hair) solid var(--s-line-soft);
  }
</style>
