/**
 * Shared modal focus-trap primitives (WCAG 2.4.3 / APG dialog pattern).
 *
 * Promoted from packages/ui's `$lib/actions/focus-trap.js` into ui-kit itself
 * (review 2026-07-10 §G3): Drawer.svelte previously imported the primitives
 * via `$lib/actions/focus-trap.js`, an app-provided contract resolved by
 * whichever app's Vite/SvelteKit pipeline compiles the raw ui-kit source
 * against ITS OWN `src/lib`. packages/ui ships that file; packages/client
 * does not, so the kit's only accessible-dialog primitive (Drawer) was
 * structurally unusable from the client — this also blocked the B14
 * small-screen sessions drawer. This module is the real, kit-internal
 * implementation; Drawer.svelte (and any future kit dialog) imports it by
 * relative path, and it is additionally re-exported to consuming apps via the
 * `./actions/*` package.json subpath for direct use (e.g. a client-owned
 * dialog that isn't built on Drawer).
 *
 * Use `createFocusTrap` as a Svelte attachment on the dialog panel and
 * `handleTrapKeydown` as its `onkeydown` handler.
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
   * that stay mounted and toggle via a boolean (a persistent veil/drawer).
   * Defaults to true — the mount/unmount dialog case (Drawer).
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
  return (node: HTMLElement): (() => void) | undefined => {
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
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
