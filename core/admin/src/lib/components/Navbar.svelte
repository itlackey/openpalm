<script lang="ts">
  interface Props {
    version: string;
    channelAccess: 'host' | 'lan' | 'custom';
    onLogout: () => void;
  }

  let { version, channelAccess, onLogout }: Props = $props();
</script>

<nav class="navbar" aria-label="Main navigation">
  <div class="navbar-inner">
    <div class="navbar-brand">
      <span class="brand-icon">
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </span>
      <span class="brand-text">OpenPalm</span>
      <span class="brand-badge">Console</span>
    </div>
    <div class="navbar-actions">
      <span class="version-badge">v{version}</span>
      <span class="access-badge" class:access-public={channelAccess !== 'lan'}>
        <span class="access-dot"></span>
        {channelAccess === 'lan' ? 'LAN Only' : channelAccess === 'host' ? 'Host Only' : 'Custom'}
      </span>
      <button class="btn btn-secondary btn-sm" type="button" onclick={onLogout}>Sign Out</button>
    </div>
  </div>
</nav>

<style>
  .navbar {
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(255, 255, 255, 0.85);
    border-bottom: 1px solid var(--color-border);
    backdrop-filter: blur(12px);
  }

  .navbar-inner {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 0 var(--space-6);
    height: var(--nav-height);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .navbar-brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .brand-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    background: var(--color-primary);
    color: var(--color-text-inverse);
    border-radius: var(--radius-md);
  }

  .brand-text {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .brand-badge {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-text-secondary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .access-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--color-success);
    background: var(--color-success-bg);
    border: 1px solid var(--color-success-border);
    padding: 4px 12px;
    border-radius: var(--radius-full);
    transition: all var(--transition-normal);
  }

  .access-badge.access-public {
    color: var(--color-warning);
    background: var(--color-warning-bg);
    border-color: rgba(253, 126, 20, 0.25);
  }

  .access-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  .version-badge {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    font-family: var(--font-mono);
    color: var(--color-text-tertiary);
    background: var(--color-bg-tertiary);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    letter-spacing: 0.02em;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 8px 16px;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    line-height: 1.4;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover);
    border-color: var(--color-border-hover);
  }

  .btn-sm {
    padding: 5px 12px;
    font-size: var(--text-xs);
  }

  @media (max-width: 768px) {
    .navbar-inner {
      padding: 0 var(--space-4);
    }
  }

  @media (max-width: 480px) {
    .brand-badge {
      display: none;
    }
  }
</style>
