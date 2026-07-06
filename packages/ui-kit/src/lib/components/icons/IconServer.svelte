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
  <rect fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" x="4" y="4.5" width="16" height="6.5" rx="1.8"/>
  <rect fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" x="4" y="13" width="16" height="6.5" rx="1.8"/>
  <circle fill="currentColor" stroke="none" cx="7.5" cy="7.8" r="1.2"/>
  <circle fill="currentColor" stroke="none" cx="7.5" cy="16.3" r="1.2"/>
</svg>
