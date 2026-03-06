<script lang="ts">
  import { version } from '$app/environment';

  interface Props {
    onLogout: () => void;
  }

  let { onLogout }: Props = $props();
</script>

<nav class="navbar" aria-label="Main navigation">
  <div class="navbar-inner">
    <div class="navbar-brand">
      <span class="brand-icon">
        <img src="/logo-128.png" alt="OpenPalm Logo">
      </span>
      <span class="brand-text">OpenPalm</span>
      <span class="version-badge">v{version}</span>
    </div>
    <div class="navbar-actions">
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
    img{
      max-width: 34px;
    }
  }

  .brand-text {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .navbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
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
    .version-badge {
      display: none;
    }

    .navbar-actions {
      flex-shrink: 0;
    }

    .brand-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
