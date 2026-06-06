<script lang="ts">
  import type { Snippet } from 'svelte';

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

  function onScrimKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

{#if open}
  <div
    class="drawer-scrim"
    role="button"
    tabindex="-1"
    aria-label="Close"
    onclick={onClose}
    onkeydown={onScrimKey}
  ></div>

  <div class="drawer" style="--drawer-width: {width}" role="dialog" aria-modal="true" aria-label={title}>
    <header class="drawer-header">
      {#if headerStart}{@render headerStart()}{/if}
      <h3 class="drawer-title">{title}</h3>
      <button class="drawer-close" onclick={onClose} aria-label="Close">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18" /><path d="m6 6 12 12" />
        </svg>
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
    background: rgba(0, 0, 0, 0.45);
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
    background: var(--color-bg);
    border-left: 1px solid var(--color-border);
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.18);
    z-index: 201;
    animation: drawer-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
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
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .drawer-title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--color-text);
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
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .drawer-close:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
  .drawer-close:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5);
  }
  .drawer-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--color-border);
  }
</style>
