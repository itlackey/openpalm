<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

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

<p>Checking core service health...</p>

{#if loading}
	<div class="muted">Loading...</div>
{:else}
	<div>
		{#each Object.entries(services) as [name, info]}
			<div style="margin:0.3rem 0">
				<span class="dot {info.ok ? 'dot-ok' : 'dot-err'}"></span>
				<span class="sr-only">{info.ok ? 'Healthy' : 'Error'}</span>
				<strong>{friendlyName(name)}</strong>
				&mdash; {info.ok ? 'Healthy' : info.error || 'Unreachable'}
			</div>
		{/each}
	</div>
{/if}
