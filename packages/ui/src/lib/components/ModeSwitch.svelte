<script lang="ts">
  import { page } from '$app/state';

  // Chat ↔ Advanced mode toggle. Page-contextual (chat surface only), so it
  // lives in the chat content rather than the global navbar — that keeps the
  // global assistant/session/voice controls in the navbar from being crowded
  // off at narrow widths.
  const pathname = $derived(page.url?.pathname ?? '');
  const onChat = $derived(pathname === '/chat' || pathname.startsWith('/chat/'));
  const onAdvanced = $derived(pathname === '/advanced' || pathname.startsWith('/advanced/'));
</script>

<nav class="mode-switch" aria-label="Chat mode">
  <a href="/chat" class="mode-tab" class:active={onChat} aria-current={onChat ? 'page' : undefined}>
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
    <span>Chat</span>
  </a>
  <a href="/advanced" class="mode-tab" class:active={onAdvanced} aria-current={onAdvanced ? 'page' : undefined}>
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="m7 9 3 3-3 3" /><line x1="13" y1="15" x2="17" y2="15" />
    </svg>
    <span>Advanced</span>
  </a>
</nav>

<style>
  .mode-switch {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 3px;
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }
  .mode-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 34px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--color-badge-neutral-fg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
    white-space: nowrap;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .mode-tab:hover {
    color: var(--color-text);
  }
  .mode-tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .mode-tab.active {
    background: var(--color-surface);
    color: var(--color-text);
    font-weight: var(--font-semibold);
    box-shadow: var(--shadow-sm);
  }
  .mode-tab svg {
    flex-shrink: 0;
  }
</style>
