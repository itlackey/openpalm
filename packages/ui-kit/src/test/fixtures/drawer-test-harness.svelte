<script lang="ts">
  import Drawer from '../../lib/components/common/Drawer.svelte';

  let firstOpen = $state(false);
  let secondOpen = $state(false);
</script>

<button type="button" onclick={() => (firstOpen = true)}>Open first drawer</button>
<button type="button" onclick={() => (secondOpen = true)}>Open second drawer</button>

<Drawer id="first-drawer" open={firstOpen} title="First drawer" onClose={() => (firstOpen = false)}>
  <a href="#first-action">First action</a>
  <button type="button">Last action</button>
</Drawer>

<Drawer id="second-drawer" open={secondOpen} title="Second drawer" onClose={() => (secondOpen = false)}>
  <button type="button">Second action</button>
</Drawer>
