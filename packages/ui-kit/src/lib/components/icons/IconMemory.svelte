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
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 7.5a5.5 5.5 0 0 0-9.5 0v10.5a5.5 5.5 0 0 1 9.5 0"/>
  <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M12 7.5a5.5 5.5 0 0 1 9.5 0v10.5a5.5 5.5 0 0 0-9.5 0"/>
</svg>
