<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { onMount } from 'svelte';

	onMount(() => {
		goto(`${base}/extensions`);
	});
</script>

<div class="container">
	<p class="muted">Redirecting...</p>
</div>
