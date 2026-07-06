<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 20, class: className = '' }: Props = $props();
</script>

<!-- Concentric arcs around a center dot — hands-free conversation mode. -->
<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="s-icon {className}"
>
  <circle cx="12" cy="12" r="1" fill="currentColor" />
  <path d="M8.5 8.5a5 5 0 0 0 0 7" />
  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  <path d="M5.6 5.6a9 9 0 0 0 0 12.8" />
  <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
</svg>
