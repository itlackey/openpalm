<script lang="ts">
  interface Props {
    missing: string[];
  }

  let { missing }: Props = $props();
</script>

{#if missing.length > 0}
  <div class="connection-banner" role="alert" aria-live="polite">
    <span class="connection-banner-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
    <span class="connection-banner-text">
      Some connections are not configured.
    </span>
    <a href="/connections" class="connection-banner-link">
      Configure connections
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </a>
  </div>
{/if}

<style>
  .connection-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
    background: var(--color-warning-bg, rgba(253, 126, 20, 0.1));
    border: 1px solid var(--color-warning, #fd7e14);
    border-radius: var(--radius-md, 8px);
    font-size: var(--text-sm, 0.8125rem);
    color: var(--color-text, #111827);
    margin-bottom: var(--space-4, 1rem);
  }

  .connection-banner-icon {
    flex-shrink: 0;
    color: var(--color-warning, #fd7e14);
    display: flex;
    align-items: center;
  }

  .connection-banner-text {
    flex: 1;
    font-weight: var(--font-medium, 500);
  }

  .connection-banner-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    color: var(--color-primary, #ff9d00);
    text-decoration: none;
    font-weight: var(--font-semibold, 600);
    white-space: nowrap;
    transition: color var(--transition-fast, 120ms ease);
  }

  .connection-banner-link:hover {
    color: var(--color-primary-hover, #e68a00);
    text-decoration: underline;
  }
</style>
