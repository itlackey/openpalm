<script lang="ts">
  import "../app.css";
  import UpdateBanner from '$lib/components/UpdateBanner.svelte';
  import Toast from '$lib/components/Toast.svelte';

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

<UpdateBanner />
{@render children?.()}
<Toast />
