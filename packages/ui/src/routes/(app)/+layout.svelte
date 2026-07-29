<script lang="ts">
  import type { Snippet } from 'svelte';
  import UpdateBanner from '$lib/components/common/UpdateBanner.svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<div class="app-frame">
  <UpdateBanner />
  <div class="app-frame-content">
    {@render children?.()}
  </div>
</div>

<style>
  .app-frame {
    display: flex;
    width: 100%;
    height: 100dvh;
    min-height: 0;
    flex-direction: column;
  }

  .app-frame-content {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    overflow: auto;
  }
</style>
