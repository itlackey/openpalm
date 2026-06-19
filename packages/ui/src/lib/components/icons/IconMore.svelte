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
  <circle fill="currentColor" stroke="none" cx="5.5" cy="12" r="1.4"/>
  <circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.4"/>
  <circle fill="currentColor" stroke="none" cx="18.5" cy="12" r="1.4"/>
</svg>
