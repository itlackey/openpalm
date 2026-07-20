<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import IconClose from '../icons/IconClose.svelte';
  // G3 (review 2026-07-10): kit-internal relative import — the module used to
  // be reached via an app-provided $lib alias contract; see
  // ../../actions/focus-trap.ts for why that made Drawer unusable from the client.
  import { createFocusTrap, handleTrapKeydown } from '../../actions/focus-trap.js';

  // Reusable slide-in drawer. The app-wide replacement for inline
  // expand-in-place forms: edit flows open here instead of pushing page content
  // down and forcing the user to scroll.
  interface Props {
    /** Stable relationship target for a trigger's aria-controls. */
    id?: string;
    open: boolean;
    title: string;
    onClose: () => void;
    /** Called after the panel's closing transition has fully completed. */
    onClosed?: () => void;
    /** Defer focus restoration until a parent can release background inertness. */
    deferFocusRestore?: boolean;
    /** Resolve the focus-return target when a drawer is part of a chained flow. */
    returnFocus?: () => HTMLElement | null;
    children: Snippet;
    footer?: Snippet;
    /** Optional content rendered at the start of the header (e.g. a back button). */
    headerStart?: Snippet;
    /** Drawer width (CSS length). */
    width?: string;
    /** Edge from which the drawer enters. */
    side?: 'left' | 'right';
  }
  const generatedId = $props.id();
  let {
    id = generatedId,
    open,
    title,
    onClose,
    onClosed,
    deferFocusRestore = false,
    returnFocus,
    children,
    footer,
    headerStart,
    width = '32rem',
    side = 'right',
  }: Props = $props();
  const titleId = $derived(`${id}-title`);

  // Focus management for the modal dialog (WCAG 2.4.3 / APG dialog pattern) via
  // the shared focus-trap primitives: on mount move focus into the body (so the
  // user doesn't land on Close), on unmount restore it; Escape closes and Tab is
  // trapped within the panel.
  function manageFocus(node: HTMLElement): (() => void) | undefined {
    return createFocusTrap({
      initialFocus: '.drawer-body',
      deferRestore: deferFocusRestore,
      returnFocus,
    })(node);
  }

  function transitionDuration(): number {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : 220;
  }
</script>

{#if open}
  <!-- Decorative click-to-close backdrop; keyboard close is via Escape (trapped
       in the panel) and the header close button. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="drawer-scrim"
    onclick={onClose}
    transition:fade={{ duration: transitionDuration() }}
  ></div>

  <div
    {id}
    class="drawer"
    class:drawer-left={side === 'left'}
    style="--drawer-width: {width}"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    onkeydown={(e) => handleTrapKeydown(e, onClose)}
    transition:fly={{ x: side === 'left' ? -48 : 48, duration: transitionDuration() }}
    onoutroend={onClosed}
    {@attach manageFocus}
  >
    <header class="drawer-header">
      {#if headerStart}{@render headerStart()}{/if}
      <h2 class="drawer-title" id={titleId}>{title}</h2>
      <button
        class="drawer-close"
        type="button"
        onclick={onClose}
        aria-label="Close {title} panel"
        title="Close {title}"
      >
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
    will-change: transform;
  }
  .drawer-left {
    right: auto;
    left: 0;
    border-right: var(--s-hair) solid var(--s-line);
    border-left: 0;
  }
  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    min-height: 64px;
    padding: var(--s-sp-2) var(--s-sp-5);
    border-bottom: var(--s-hair) solid var(--s-line-soft);
    flex-shrink: 0;
  }
  .drawer-title {
    flex: 1;
    min-width: 0;
    font-family: var(--s-font-header);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--s-ink);
  }
  .drawer-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
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

  @media (max-width: 480px) {
    .drawer-body {
      padding: var(--s-sp-4);
    }
  }
</style>
