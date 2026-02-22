<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface Props {
		oncontinue: () => void;
	}

	let { oncontinue }: Props = $props();

	let statusText = $state('Starting services...');
	let ready = $state(false);
	let timedOut = $state(false);

	async function pollUntilReady() {
		for (let i = 0; i < 120; i++) {
			const r = await api('/setup/health-check');
			if (r.ok) {
				const services = Object.values(r.data?.services || {}) as Array<{ ok?: boolean }>;
				const allOk = services.every((s) => s?.ok);
				if (allOk) {
					ready = true;
					statusText = 'Everything is ready!';
					return;
				}
			}
			statusText = `Starting services... (${i + 1})`;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		timedOut = true;
		statusText = 'Some services are still starting. You can continue anyway.';
	}

	onMount(() => {
		pollUntilReady();
	});
</script>

<p>Finalizing setup and starting your assistant...</p>

<div>
	<p class="muted">{statusText}</p>
	{#if ready}
		<button onclick={oncontinue}>Continue to Admin</button>
	{:else if timedOut}
		<button class="btn-secondary" onclick={oncontinue}>Continue to Admin</button>
	{/if}
</div>
