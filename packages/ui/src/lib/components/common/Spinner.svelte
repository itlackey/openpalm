<script lang="ts">
  // Single reusable spinner — replaces the ~22 per-component copies of
  // `<span class="spinner">` + `@keyframes spin`.
  interface Props {
    /** Diameter in px. */
    size?: number;
    /** When set, exposes the spinner to assistive tech as a status. */
    label?: string;
  }
  let { size = 14, label }: Props = $props();
</script>

<span
  class="spinner"
  style="--spinner-size: {size}px"
  role={label ? 'status' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
></span>

<style>
  .spinner {
    display: inline-block;
    width: var(--spinner-size, 14px);
    height: var(--spinner-size, 14px);
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: op-spin 0.6s linear infinite;
    flex-shrink: 0;
    vertical-align: -2px;
  }
  @keyframes op-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
