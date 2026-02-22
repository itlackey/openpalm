<script lang="ts">
	import { api } from '$lib/api';
	import { onMount } from 'svelte';

	interface ServiceHealth {
		ok: boolean;
		time?: string;
		error?: string;
	}

	let services = $state<Record<string, ServiceHealth>>({});
	let loading = $state(true);

	const SERVICE_NAMES: Record<string, string> = {
		gateway: 'Message Router',
		assistant: 'AI Assistant',
		openmemory: 'Memory',
		admin: 'Admin Panel'
	};

	function friendlyName(svc: string): string {
		return SERVICE_NAMES[svc] ?? svc;
	}

	async function loadHealth() {
		loading = true;
		const r = await api('/setup/health-check');
		if (r.ok && r.data?.services) {
			services = r.data.services;
		}
		loading = false;
	}

	onMount(() => {
		loadHealth();
	});
</script>

<div class="card">
	<h3>Health Status</h3>
	{#if loading}
		<div class="muted">Loading...</div>
	{:else}
		<div>
			{#each Object.entries(services) as [name, info]}
				<div style="display:inline-flex;align-items:center;gap:0.4rem;margin:0.3rem 0.8rem 0.3rem 0">
					<span class="dot {info.ok ? 'dot-ok' : 'dot-err'}"></span>
					<span class="sr-only">{info.ok ? 'Healthy' : 'Error'}</span>
					<strong style="font-size:14px">{friendlyName(name)}</strong>
				</div>
			{/each}
		</div>
	{/if}
</div>
