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
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M4 7a1.8 1.8 0 0 1 1.8-1.8h3.4l2.2 2.4h6.8A1.8 1.8 0 0 1 20 9.4V18a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18z"/>
</svg>
