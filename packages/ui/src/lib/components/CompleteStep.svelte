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
	let serviceStatus = $state<Record<string, { ok: boolean; time?: string }>>({});

	async function pollUntilReady() {
		for (let i = 0; i < 120; i++) {
			const r = await api('/setup/health-check');
			if (r.ok) {
				const services = r.data?.services || {};
				serviceStatus = Object.fromEntries(
					Object.entries(services).map(([name, s]) => [
						name,
						{ ok: !!(s as any)?.ok, time: (s as any)?.time }
					])
				);
				const allOk = Object.values(services).every((s) => (s as any)?.ok);
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
	{#if !ready && !timedOut && Object.keys(serviceStatus).length > 0}
		<ul style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px">
			{#each Object.entries(serviceStatus) as [name, s]}
				<li style="color: {s.ok ? 'var(--green, green)' : 'var(--muted, #888)'}">
					{name} — {s.ok ? 'ready' : 'starting...'}
				</li>
			{/each}
		</ul>
	{/if}
	{#if ready}
		<button onclick={oncontinue}>Continue to Admin</button>
	{:else if timedOut}
		<div style="margin:0.5rem 0">
			<p>Some services took too long to start:</p>
			<ul style="margin:0.4rem 0; padding-left:1.2rem">
				{#each Object.entries(serviceStatus) as [name, s]}
					<li style="color: {s.ok ? 'var(--green, green)' : 'var(--red, red)'}">
						{name} — {s.ok ? 'ready' : 'not ready'}
					</li>
				{/each}
			</ul>
			<p class="muted" style="font-size:13px">
				Check your API key is correct, then run <code>openpalm logs</code> for details.
			</p>
		</div>
		<button class="btn-secondary" onclick={oncontinue}>Continue to Admin</button>
	{/if}
</div>
