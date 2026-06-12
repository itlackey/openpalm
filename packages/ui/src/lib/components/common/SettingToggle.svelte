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
    background: var(--color-bg);
    border: 1.5px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 10px 14px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .setting-toggle:hover {
    border-color: var(--color-border-hover);
    box-shadow: var(--shadow-sm);
  }

  .setting-toggle.on {
    border-color: var(--color-primary-hover);
    background: var(--color-primary-subtle);
  }

  .setting-toggle.locked {
    cursor: default;
    opacity: 0.85;
  }

  .setting-toggle.locked:hover,
  .setting-toggle.addon-disabled:hover {
    box-shadow: none;
  }

  .setting-toggle.addon-disabled {
    opacity: 0.6;
  }

  .setting-toggle.wide {
    grid-column: 1 / -1;
  }

  .setting-toggle-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .setting-toggle-header:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .setting-toggle-icon {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
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
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .setting-toggle-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin-top: 1px;
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
    background: var(--wizard-toggle-off, #8b9198);
    position: relative;
    transition: background 0.2s;
  }

  .setting-toggle-track.on {
    background: var(--color-primary-hover);
  }

  .setting-toggle-track.locked {
    background: var(--color-success);
  }

  .setting-toggle-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 0.2s;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }

  .setting-toggle-track.on .setting-toggle-thumb,
  .setting-toggle-track.locked .setting-toggle-thumb {
    transform: translateX(16px);
  }

  .setting-toggle-panel {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
    animation: setting-toggle-fade-in 0.2s ease;
  }

  @keyframes setting-toggle-fade-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
