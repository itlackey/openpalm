<script lang="ts">
  import type { TabId } from '../../TabBar.svelte';

  interface Props {
    status: 'ok' | 'warning' | 'unknown';
    title: string;
    detail: string;
    healthLoading: boolean;
    applyLoading: boolean;
    anyDangerousLoading: boolean;
    tokenStored: boolean;
    onCheckHealth: () => void;
    onApplyChanges: () => void;
    onNavigate: (tab: TabId) => void;
  }

  let {
    status,
    title,
    detail,
    healthLoading,
    applyLoading,
    anyDangerousLoading,
    tokenStored,
    onCheckHealth,
    onApplyChanges,
    onNavigate,
  }: Props = $props();
</script>

<!-- Status hero: the one thing an operator needs on landing — is it healthy,
     and if not, what's wrong and how do I fix it. -->
<section class="hero hero--{status}" role="status" aria-live="polite">
  <span class="hero-icon" aria-hidden="true">
    {#if status === 'warning'}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    {:else if status === 'ok'}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    {:else}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    {/if}
  </span>
  <div class="hero-text">
    <h2 class="hero-title">{title}</h2>
    <p class="hero-detail">{detail}</p>
  </div>
  <div class="hero-actions">
    <button class="btn btn-secondary" onclick={onCheckHealth} disabled={healthLoading}>
      {healthLoading ? 'Checking…' : 'Re-check'}
    </button>
    {#if status === 'warning'}
      <!-- Neutral, not brand-orange: this is a navigation shortcut within a
           status card, not a primary create/apply action (rubric D5). -->
      <button class="btn btn-secondary" onclick={() => onNavigate('containers')}>View containers</button>
    {/if}
    <button class="btn btn-secondary" onclick={onApplyChanges} disabled={anyDangerousLoading || !tokenStored}>
      {applyLoading ? 'Applying…' : 'Apply config & restart'}
    </button>
  </div>
</section>

<style>
  /* ── Status hero ── */
  .hero {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-5);
    border-radius: var(--radius-lg);
    border: 1px solid transparent;
    margin-bottom: var(--space-6);
  }
  .hero--ok {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
  }
  .hero--warning {
    background: var(--color-warning-bg);
    border-color: var(--color-warning);
  }
  .hero--unknown {
    background: var(--color-bg-secondary);
    border-color: var(--color-border);
  }
  .hero-icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .hero--ok .hero-icon {
    color: var(--color-badge-success-fg);
  }
  .hero--warning .hero-icon {
    color: var(--color-badge-warning-fg);
  }
  .hero--unknown .hero-icon {
    color: var(--color-text-secondary);
  }
  .hero-text {
    flex: 1 1 240px;
    min-width: 0;
  }
  .hero-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .hero-detail {
    margin-top: 2px;
    font-size: var(--text-sm);
    /* Accessible on the tinted hero backgrounds (secondary is only ~3.9:1 on the
       amber warning tint). */
    color: var(--color-badge-neutral-fg);
    max-width: 68ch;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    max-width: 100%;
  }
  .hero-actions :global(.btn) {
    flex-shrink: 0;
  }
  @media (max-width: 560px) {
    /* Give the action group the full row and let the buttons share it so none
       runs off-screen at phone widths. */
    .hero-actions {
      width: 100%;
    }
    .hero-actions :global(.btn) {
      flex: 1 1 auto;
    }
  }
</style>
