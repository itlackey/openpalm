<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle: string;
    children: Snippet;
  }

  let { title, subtitle, children }: Props = $props();
</script>

<section class="wizard-card">
  <div class="wizard-header">
    <h1>{title}</h1>
    <p class="wizard-subtitle">{subtitle}</p>
  </div>
  <div class="wizard-body">
    {@render children()}
  </div>
</section>

<style>
  .wizard-card {
    width: 100%;
    max-width: 520px;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 20px;
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.04),
      0 4px 6px -1px rgba(0, 0, 0, 0.06),
      0 16px 40px -8px rgba(0, 0, 0, 0.1);
    padding: 0;
    position: relative;
    z-index: 1;
    min-height: 520px;
    display: flex;
    flex-direction: column;
    animation: card-enter 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes card-enter {
    from { opacity: 0; transform: translateY(16px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .wizard-card { animation: none; }
  }
  .wizard-header { padding: var(--space-8) var(--space-8) var(--space-5); border-bottom: 1px solid var(--color-border); text-align: center; margin-bottom: 0; }
  .wizard-header h1 { font-size: clamp(1.5rem, 4vw, 1.875rem); font-weight: 800; color: var(--color-text); letter-spacing: -0.03em; line-height: 1.1; }
  .wizard-subtitle { margin-top: var(--space-2); font-size: var(--text-sm); color: var(--color-text-secondary); }
  .wizard-body { padding: var(--space-6) var(--space-8) var(--space-8); flex: 1; display: flex; flex-direction: column; }
</style>
