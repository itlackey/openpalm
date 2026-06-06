<script lang="ts">
  import type { TabId } from '../../TabBar.svelte';
  import type { AkmHealth } from '$lib/api.js';

  interface Props {
    akm: AkmHealth | null;
    badge: { label: string; cls: string };
    checkTotal: number;
    onNavigate: (tab: TabId) => void;
  }

  let { akm, badge, checkTotal, onNavigate }: Props = $props();
</script>

<button class="akm-card" onclick={() => onNavigate('akm')} aria-label="AKM health — open Knowledge settings">
  <div class="akm-head">
    <span class="akm-title">AKM runtime health</span>
    <span class="badge {badge.cls}">{badge.label}</span>
  </div>
  {#if akm && akm.available}
    <div class="akm-metrics">
      <div class="akm-metric">
        <span class="akm-num">{akm.index?.entryCount?.toLocaleString() ?? '—'}</span>
        <span class="akm-cap">Indexed assets</span>
      </div>
      <div class="akm-metric">
        <span class="akm-num">{akm.checks.pass}<span class="akm-num-sub">/{checkTotal}</span></span>
        <span class="akm-cap">Health checks passing</span>
      </div>
      <div class="akm-metric">
        <span class="akm-num">{akm.index?.hasEmbeddings ? 'On' : 'Off'}</span>
        <span class="akm-cap">Semantic search</span>
      </div>
      {#if akm.metrics && typeof akm.metrics.taskFailRate === 'number'}
        <div class="akm-metric">
          <span class="akm-num">{Math.round(akm.metrics.taskFailRate * 100)}%</span>
          <span class="akm-cap">Task failure rate</span>
        </div>
      {/if}
    </div>
  {:else}
    <p class="akm-unavailable">
      Metrics unavailable — the akm CLI isn't reachable from the admin host.
    </p>
  {/if}
</button>

<style>
  /* ── AKM health card ── */
  .akm-card {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--font-sans);
    padding: var(--space-5);
    margin-bottom: var(--space-8);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .akm-card:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }
  .akm-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .akm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .akm-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .akm-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-4);
  }
  .akm-metric {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .akm-num {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-text);
    line-height: 1.1;
  }
  .akm-num-sub {
    font-size: var(--text-base);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
  }
  .akm-cap {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
  .akm-unavailable {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    max-width: 68ch;
  }
</style>
