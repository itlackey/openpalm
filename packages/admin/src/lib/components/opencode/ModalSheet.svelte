<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    wide?: boolean;
    title: string;
    backLabel?: string;
    onClose: () => void;
    onBack?: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { open, wide = false, title, backLabel, onClose, onBack, children, footer }: Props = $props();

  let sheetEl: HTMLElement | undefined = $state();
  let triggerEl: Element | null = null;

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  $effect(() => {
    if (open) {
      // Capture trigger element before moving focus (Critical fix #2)
      triggerEl = document.activeElement;
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        const first = sheetEl?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        first?.focus();
      });
    } else {
      document.body.style.overflow = '';
      // Return focus to trigger on close (Critical fix #2)
      if (triggerEl instanceof HTMLElement) {
        triggerEl.focus();
      }
      triggerEl = null;
    }
    return () => {
      document.body.style.overflow = '';
    };
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    // Focus trap: cycle Tab within sheet (Critical fix #1)
    if (e.key === 'Tab') {
      const focusable = sheetEl?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sheet-overlay" onkeydown={handleKeydown} onclick={handleOverlayClick}>
    <div
      class="sheet"
      class:sheet--wide={wide}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-dialog-title"
      bind:this={sheetEl}
    >
      <header class="sheet-header">
        {#if backLabel && onBack}
          <button class="sheet-header-back" type="button" aria-label="Back to {backLabel}" onclick={onBack}>
            ← {backLabel}
          </button>
        {/if}
        <h2 class="sheet-title" id="sheet-dialog-title">{title}</h2>
        <button class="sheet-close" type="button" onclick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div class="sheet-body">
        {@render children()}
      </div>
      {#if footer}
        <footer class="sheet-footer">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
