<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 20, class: className = '' }: Props = $props();
</script>

<!-- Crescent moon = night / dark -->
<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="s-icon {className}"
>
  <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
</svg>
