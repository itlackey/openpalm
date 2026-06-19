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
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="s-icon {className}"
>
  <path d="M4 7h16" opacity="0.9" />
  <path d="M4 12h11" opacity="0.65" />
  <path d="M4 17h7.5" opacity="0.5" />
</svg>
