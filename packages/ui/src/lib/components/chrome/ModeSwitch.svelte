<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  // Single "Advanced" toggle for the chat surface: off on /chat, on (pressed)
  // on /advanced. Clicking flips between the two. Lives in the global navbar.
  const pathname = $derived(page.url?.pathname ?? '');
  const onAdvanced = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));

  function toggle(): void {
    void goto(onAdvanced ? '/chat' : '/advanced');
  }
</script>

<button
  type="button"
  class="advanced-toggle"
  class:active={onAdvanced}
  aria-pressed={onAdvanced}
  onclick={toggle}
  title="Advanced mode (embedded OpenCode)"
  aria-label="Advanced mode"
>
  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="m7 9 3 3-3 3" /><line x1="13" y1="15" x2="17" y2="15" />
  </svg>
  
</button>

<style>
  .advanced-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 30px;
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--color-text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
  }
  .advanced-toggle:hover {
    color: var(--color-text);
    background: var(--color-surface-hover);
  }
  .advanced-toggle:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  /* Pressed = advanced mode is active. */
  .advanced-toggle.active {
    color: var(--color-text);
    font-weight: var(--font-semibold);
    background: var(--color-surface);
    border-color: var(--color-border);
  }
  .advanced-toggle svg {
    flex-shrink: 0;
  }

  /* Icon-only on narrow screens; the accessible name stays via aria-label/title. */
  @media (max-width: 640px) {
    .advanced-toggle span {
      display: none;
    }
    .advanced-toggle {
      padding: 0 var(--space-1);
    }
  }
</style>
