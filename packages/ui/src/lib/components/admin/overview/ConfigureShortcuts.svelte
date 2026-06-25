<script lang="ts">
  import type { TabId } from '$lib/components/chrome/TabBar.svelte';

  interface Props {
    onNavigate: (tab: TabId) => void;
  }

  let { onNavigate }: Props = $props();
</script>

<!-- Configure shortcuts: the common setup destinations, one click away. -->
<div class="shortcut-grid">
  <button class="shortcut" onclick={() => onNavigate('connections')}>
    <span class="shortcut-name">AI Providers</span>
    <span class="shortcut-desc">Models &amp; provider credentials</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('akm')}>
    <span class="shortcut-name">Knowledge</span>
    <span class="shortcut-desc">Assistant memory &amp; behavior</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('voice')}>
    <span class="shortcut-name">Voice</span>
    <span class="shortcut-desc">Speech-to-text &amp; text-to-speech</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('addons')}>
    <span class="shortcut-name">Portals &amp; add-ons</span>
    <span class="shortcut-desc">Discord, Slack, API &amp; more</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('secrets')}>
    <span class="shortcut-name">Secrets</span>
    <span class="shortcut-desc">Stack &amp; portal credentials</span>
  </button>
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- internal setup path with a query string, not a static route id -->
  <a class="shortcut" href="/setup?rerun=1">
    <span class="shortcut-name">Re-run setup</span>
    <span class="shortcut-desc">Walk through the setup wizard again</span>
  </a>
</div>

<style>
  .shortcut-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--s-sp-3);
  }
  .shortcut {
    display: flex;
    flex-direction: column;
    gap: var(--s-sp-1);
    padding: var(--s-sp-4) var(--s-sp-4);
    appearance: none;
    background: none;
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
    text-decoration: none;
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    letter-spacing: var(--s-track-label);
    text-transform: uppercase;
    color: var(--s-ink-3);
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .shortcut:hover {
    border-color: var(--s-line);
    color: var(--s-ink-2);
  }
  .shortcut:focus-visible {
    outline: var(--s-hair) solid var(--s-seal);
    outline-offset: 2px;
  }
  .shortcut-name {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark);
    text-transform: uppercase;
    letter-spacing: var(--s-track-label);
    color: var(--s-ink);
  }
  .shortcut-desc {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    text-transform: none;
    letter-spacing: normal;
    color: var(--s-ink-2);
  }
</style>
