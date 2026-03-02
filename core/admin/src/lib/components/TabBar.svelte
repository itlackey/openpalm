<script lang="ts">
  type TabId = 'overview' | 'containers' | 'artifacts' | 'automations' | 'connections';

  interface Props {
    active: TabId;
    onSelect: (tab: TabId) => void;
  }

  let { active, onSelect }: Props = $props();

  function handleTabKeydown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const tabs = Array.from(target.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(target);
    if (index === -1) return;
    let next: number;
    if (e.key === 'ArrowRight') {
      next = (index + 1) % tabs.length;
    } else {
      next = (index - 1 + tabs.length) % tabs.length;
    }
    tabs[next]?.focus();
  }
</script>

<div class="tabs" role="tablist">
  <button
    class="tab"
    role="tab"
    aria-selected={active === 'overview'}
    class:tab-active={active === 'overview'}
    onclick={() => onSelect('overview')}
    onkeydown={handleTabKeydown}
  >
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
    </svg>
    Overview
  </button>
  <button
    class="tab"
    role="tab"
    aria-selected={active === 'automations'}
    class:tab-active={active === 'automations'}
    onclick={() => onSelect('automations')}
    onkeydown={handleTabKeydown}
  >
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
    Automations
  </button>
  <button
    class="tab"
    role="tab"
    aria-selected={active === 'containers'}
    class:tab-active={active === 'containers'}
    onclick={() => onSelect('containers')}
    onkeydown={handleTabKeydown}
  >
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
    Containers
  </button>
  <button
    class="tab"
    role="tab"
    aria-selected={active === 'artifacts'}
    class:tab-active={active === 'artifacts'}
    onclick={() => onSelect('artifacts')}
    onkeydown={handleTabKeydown}
  >
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
    Artifacts
  </button>
  <button
    class="tab"
    role="tab"
    aria-selected={active === 'connections'}
    class:tab-active={active === 'connections'}
    onclick={() => onSelect('connections')}
    onkeydown={handleTabKeydown}
  >
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
    Connections
  </button>
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-6);
    position: sticky;
    top: var(--nav-height);
    z-index: 40;
    background: var(--color-bg-secondary);
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-text-secondary);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
    margin-bottom: -1px;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
    border-radius: var(--radius-sm);
  }

  .tab-active {
    color: var(--color-text);
    border-bottom-color: var(--color-primary);
  }

  @media (max-width: 768px) {
    .tab {
      padding: var(--space-2) var(--space-3);
    }

    .tab-active {
      color: var(--color-text);
      border-bottom-color: var(--color-primary);
      font-weight: var(--font-semibold);
    }
  }

  @media (max-width: 480px) {
    .tabs {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
