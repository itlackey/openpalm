<script lang="ts">
  import type { TabId } from '../../TabBar.svelte';

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
    <span class="shortcut-name">Channels &amp; add-ons</span>
    <span class="shortcut-desc">Discord, Slack, API &amp; more</span>
  </button>
  <button class="shortcut" onclick={() => onNavigate('secrets')}>
    <span class="shortcut-name">Secrets</span>
    <span class="shortcut-desc">Stack &amp; channel credentials</span>
  </button>
  <a class="shortcut" href="/setup?rerun=1">
    <span class="shortcut-name">Re-run setup</span>
    <span class="shortcut-desc">Walk through the setup wizard again</span>
  </a>
</div>

<style>
  .shortcut-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .shortcut {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    text-decoration: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }
  .shortcut:hover {
    border-color: var(--color-border-hover);
    background: var(--color-surface-hover);
  }
  .shortcut:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .shortcut-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-text);
  }
  .shortcut-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
