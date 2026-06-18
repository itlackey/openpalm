<script lang="ts">
  import type { TabId } from '$lib/components/chrome/TabBar.svelte';
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
    font-family: var(--s-font-display);
    padding: var(--s-sp-5);
    margin-bottom: var(--s-sp-8);
    background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    cursor: pointer;
    appearance: none;
    transition: border-color 0.12s ease;
  }
  .akm-card:hover {
    border-color: var(--s-line);
  }
  .akm-card:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }
  .akm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-sp-3);
    margin-bottom: var(--s-sp-4);
  }
  .akm-title {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .akm-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--s-sp-4);
  }
  .akm-metric {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .akm-num {
    font-family: var(--s-font-display);
    font-size: var(--s-type-voice);
    font-weight: 400;
    color: var(--s-ink);
    line-height: 1.1;
  }
  .akm-num-sub {
    font-family: var(--s-font-display);
    font-size: var(--s-type-whisper);
    font-weight: 400;
    color: var(--s-ink-2);
  }
  .akm-cap {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink-3);
  }
  .akm-unavailable {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink-2);
    max-width: 68ch;
  }
</style>
