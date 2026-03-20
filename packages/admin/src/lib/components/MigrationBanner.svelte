<script lang="ts">
  interface Props {
    visible?: boolean;
  }

  let { visible = false }: Props = $props();

  let dismissed = $state(false);

  let show = $derived(visible && !dismissed);
</script>

{#if show}
  <div class="migration-banner" role="alert">
    <div class="banner-content">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div class="banner-text">
        <strong>Legacy installation detected</strong>
        <span>Run <code>openpalm migrate</code> to move to the new <code>~/.openpalm/</code> layout.</span>
      </div>
    </div>
    <button
      class="banner-dismiss"
      onclick={() => { dismissed = true; }}
      aria-label="Dismiss migration notice"
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
{/if}

<style>
  .migration-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-caution-bg);
    border: 1px solid var(--color-caution);
    border-radius: var(--radius-md);
  }

  .banner-content {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    color: var(--color-caution);
    min-width: 0;
  }

  .banner-content svg {
    flex-shrink: 0;
    margin-top: 1px;
  }

  .banner-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .banner-text strong {
    font-weight: var(--font-semibold);
  }

  .banner-text span {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .banner-text code {
    font-family: var(--font-mono);
    font-size: inherit;
    padding: 1px 4px;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 3px;
  }

  .banner-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .banner-dismiss:hover {
    background: rgba(0, 0, 0, 0.06);
    color: var(--color-text);
  }

  @media (max-width: 480px) {
    .migration-banner {
      flex-direction: column;
      align-items: flex-start;
    }

    .banner-dismiss {
      align-self: flex-end;
    }
  }
</style>
