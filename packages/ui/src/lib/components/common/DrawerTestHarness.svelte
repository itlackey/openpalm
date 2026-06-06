<!-- Test-only harness: a trigger button + a Drawer with two focusable controls,
     so focus-trap / focus-restoration behavior can be exercised. -->
<script lang="ts">
  import Drawer from './Drawer.svelte';

  let open = $state(false);
</script>

<button data-testid="trigger" onclick={() => (open = true)}>Open</button>

<Drawer {open} title="Test drawer" onClose={() => (open = false)}>
  <input data-testid="first" type="text" placeholder="first" />
  <button data-testid="middle">Middle</button>
</Drawer>
