<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 20, class: className = '' }: Props = $props();
</script>

<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  class="s-icon {className}"
>
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 22c-3.3 0-5.5-2-5.5-4.5 0-3 2.5-5 3.5-7 .5 1.5 1.5 2 2 3 .5-2.5 1-5.5 1.5-8 1.5 2.5 2 5.5 1.5 8.5.5-1.5 1-3 .5-4.5 1 2 1.5 4 0 5.5 0 2.5-1.5 7-3.5 7z"/>
</svg>
