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
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M9.5 14.5a4 4 0 0 1 0-5.4l2-2a4 4 0 0 1 5.6 5.6l-1 1"/>
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M14.5 9.5a4 4 0 0 1 0 5.4l-2 2a4 4 0 0 1-5.6-5.6l1-1"/>
</svg>
