/**
 * Shared modal focus-trap primitives (WCAG 2.4.3 / APG dialog pattern).
 *
 * Consolidates three byte-for-byte copies that previously lived in the chat
 * page (`+page.svelte`), the common `Drawer.svelte`, and the `ToolStrip.svelte`
 * tool-detail modal. Use `createFocusTrap` as a Svelte attachment on the dialog
 * panel and `handleTrapKeydown` as its `onkeydown` handler.
 */

/** Selector matching every natively focusable / tabbable element. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Collect the visible, tabbable descendants of `root`, in document order. */
export function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true'
  );
}

export interface FocusTrapOptions {
  /**
   * When false the trap is inert: no focus move, no cleanup. Used for panels
   * that stay mounted and toggle via a boolean (the chat veil / tool drawer).
   * Defaults to true — the mount/unmount dialog case (Drawer, ToolStrip modal).
   */
  active?: boolean;
  /**
   * CSS selector for a preferred container whose first focusable receives
   * initial focus (e.g. `.drawer-body`, so focus lands on content rather than
   * the header Close button).
   */
  initialFocus?: string;
  /**
   * Restore focus to the opener on the next animation frame instead of
   * synchronously. Required when the opener un-hides on close (a synchronous
   * focus on a still-hidden element silently no-ops to `<body>`).
   */
  deferRestore?: boolean;
}

/**
 * Build a Svelte attachment that, when it runs, remembers the currently focused
 * element and moves focus inside `node`; when it is cleaned up, it restores
 * focus to the remembered element so keyboard / SR users are never dropped to
 * `<body>`.
 */
export function createFocusTrap(options: FocusTrapOptions = {}) {
  return (node: HTMLElement): (() => void) | void => {
    if (options.active === false) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = options.initialFocus
      ? node.querySelector<HTMLElement>(options.initialFocus)
      : null;
    const target = (container && focusables(container)[0]) ?? focusables(node)[0] ?? node;
    target.focus();
    return () => {
      if (options.deferRestore) {
        requestAnimationFrame(() => previouslyFocused?.focus?.());
      } else {
        previouslyFocused?.focus?.();
      }
    };
  };
}

/**
 * Keydown handler for a trapped dialog panel: Escape invokes `close`; Tab is
 * wrapped within the panel's focusable set (Shift+Tab from the first control /
 * the panel itself lands on the last, and vice versa).
 */
export function handleTrapKeydown(
  event: KeyboardEvent & { currentTarget: HTMLElement },
  close: () => void
): void {
  if (event.key === 'Escape') {
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables(event.currentTarget);
  if (items.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
