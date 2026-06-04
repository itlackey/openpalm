<script lang="ts">
  import { onMount } from 'svelte';
  import "../app.css";
  import UpdateBanner from '$lib/components/UpdateBanner.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import { themeService } from '$lib/theme-state.svelte.js';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  onMount(() => {
    themeService.init();
  });
</script>

<UpdateBanner />
{@render children?.()}
<Toast />
