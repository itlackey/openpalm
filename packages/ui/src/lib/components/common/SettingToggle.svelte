<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    icon?: string;
    checked?: boolean;
    locked?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    onToggle: () => void;
    titleSuffix?: Snippet;
    children?: Snippet;
  }

  let {
    title,
    description = '',
    icon,
    checked = false,
    locked = false,
    disabled = false,
    expanded = false,
    onToggle,
    titleSuffix,
    children,
  }: Props = $props();

  const interactive = $derived(!locked && !disabled);
</script>

<div class:on={checked} class:locked class:addon-disabled={disabled} class:wide={expanded} class="setting-toggle">
  <div
    class="setting-toggle-header"
    role="switch"
    aria-checked={checked}
    tabindex={interactive ? 0 : -1}
    aria-disabled={disabled ? 'true' : undefined}
    onclick={() => {
      if (interactive) onToggle();
    }}
    onkeydown={(event) => {
      if (interactive && (event.key === 'Enter' || event.key === ' ')) onToggle();
    }}
  >
    {#if icon}
      <div class="setting-toggle-icon">{icon}</div>
    {/if}
    <div class="setting-toggle-info">
      <div class="setting-toggle-name">
        {title}
        {#if titleSuffix}
          {@render titleSuffix()}
        {/if}
      </div>
      {#if description}
        <div class="setting-toggle-desc">{description}</div>
      {/if}
    </div>
    <div class="setting-toggle-switch">
      <div class:on={checked} class:locked class="setting-toggle-track" aria-hidden="true">
        <div class="setting-toggle-thumb"></div>
      </div>
    </div>
  </div>

  {#if expanded && children}
    <div class="setting-toggle-panel">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .setting-toggle {
    background: var(--s-paper);
    border: var(--s-hair) solid var(--s-line-soft);
    border-radius: 2px;
    padding: var(--s-sp-3) var(--s-sp-4);
    cursor: pointer;
    transition: border-color var(--s-t-quick) var(--s-ease), background var(--s-t-quick) var(--s-ease);
  }

  .setting-toggle:hover {
    border-color: var(--s-line);
  }

  .setting-toggle.on {
    border-color: color-mix(in srgb, var(--s-seal) 40%, transparent);
    background: color-mix(in srgb, var(--s-seal) 4%, var(--s-paper));
  }

  .setting-toggle.locked {
    cursor: default;
    opacity: 0.85;
  }

  .setting-toggle.locked:hover,
  .setting-toggle.addon-disabled:hover {
    border-color: var(--s-line-soft);
  }

  .setting-toggle.addon-disabled {
    opacity: 0.5;
  }

  .setting-toggle.wide {
    grid-column: 1 / -1;
  }

  .setting-toggle-header {
    display: flex;
    align-items: center;
    gap: var(--s-sp-3);
  }

  .setting-toggle-header:focus-visible {
    outline: 2px solid var(--s-ink-2);
    outline-offset: 2px;
  }

  .setting-toggle-icon {
    width: 32px;
    height: 32px;
    border-radius: 2px;
    background: var(--s-paper-deep);
    border: var(--s-hair) solid var(--s-line-soft);
    display: grid;
    place-items: center;
    font-size: 16px;
    flex-shrink: 0;
  }

  .setting-toggle-info {
    flex: 1;
    min-width: 0;
  }

  .setting-toggle-name {
    font-family: var(--s-font-display);
    font-size: var(--s-type-deed);
    color: var(--s-ink);
    display: flex;
    align-items: center;
    gap: var(--s-sp-2);
    flex-wrap: wrap;
  }

  .setting-toggle-desc {
    font-family: var(--s-font-mono);
    font-size: var(--s-type-mark-sm);
    color: var(--s-ink-3);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .setting-toggle-switch {
    flex-shrink: 0;
  }

  .setting-toggle-track {
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--s-line);
    position: relative;
    transition: background var(--s-t-quick) var(--s-ease);
  }

  .setting-toggle-track.on {
    background: var(--s-seal);
  }

  .setting-toggle-track.locked {
    background: var(--s-moss);
  }

  .setting-toggle-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--s-paper);
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform var(--s-t-quick) var(--s-ease);
  }

  .setting-toggle-track.on .setting-toggle-thumb,
  .setting-toggle-track.locked .setting-toggle-thumb {
    transform: translateX(16px);
  }

  .setting-toggle-panel {
    margin-top: var(--s-sp-3);
    padding-top: var(--s-sp-3);
    border-top: var(--s-hair) solid var(--s-line-soft);
    animation: setting-toggle-fade-in 0.2s var(--s-ease);
  }

  @keyframes setting-toggle-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
