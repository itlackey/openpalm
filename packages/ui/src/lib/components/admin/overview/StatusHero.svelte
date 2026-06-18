<script lang="ts">
  import type { TabId } from '$lib/components/chrome/TabBar.svelte';

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
    gap: var(--s-sp-4);
    flex-wrap: wrap;
    padding: var(--s-sp-5);
    border-radius: 2px;
    border: var(--s-hair) solid var(--s-line);
    margin-bottom: var(--s-sp-6);
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
  }
  .hero--ok {
    border-color: var(--s-moss);
  }
  .hero--warning {
    border-color: var(--s-seal);
  }
  .hero--unknown {
    border-color: var(--s-line);
  }
  .hero-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 54px;
    height: 54px;
    border-radius: 50%;
    border: var(--s-hair) solid var(--s-line);
  }
  .hero--ok .hero-icon {
    color: var(--s-moss);
  }
  .hero--warning .hero-icon {
    color: var(--s-seal);
  }
  .hero--unknown .hero-icon {
    color: var(--s-ink-3);
  }
  .hero-text {
    flex: 1 1 240px;
    min-width: 0;
  }
  .hero-title {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    font-weight: 400;
    color: var(--s-ink);
  }
  .hero-detail {
    margin-top: 2px;
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    max-width: 68ch;
  }
  .hero-actions {
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
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
