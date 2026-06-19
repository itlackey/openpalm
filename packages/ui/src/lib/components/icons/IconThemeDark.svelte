<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 20, class: className = '' }: Props = $props();
</script>

<!-- Left half filled = dark / night (flipped day-night icon) -->
<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  class={className}
>
  <circle cx="12" cy="12" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M12 5.6a6.4 6.4 0 0 0 0 12.8z" fill="currentColor" />
</svg>
