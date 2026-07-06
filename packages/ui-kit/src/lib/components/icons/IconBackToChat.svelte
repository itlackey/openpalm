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
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M21 15a2 2 0 0 1-2 2H7.6L3.6 20.6V5.6a2 2 0 0 1 2-2h13.4a2 2 0 0 1 2 2z"/>
</svg>
