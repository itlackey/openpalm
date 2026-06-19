<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 20, class: className = '' }: Props = $props();
</script>

<!-- Full filled circle = light / day -->
<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  class={className}
>
  <circle cx="12" cy="12" r="6.4" fill="currentColor" />
</svg>
