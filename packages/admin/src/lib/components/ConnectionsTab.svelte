<script lang="ts">
	import { onMount } from 'svelte';
	import { getAdminToken } from '$lib/auth.js';
	import { buildHeaders } from '$lib/api.js';
	import type { ProviderPageState } from '$lib/types/providers.js';
	import ProvidersPanel from './ProvidersPanel.svelte';

	let pageState = $state<ProviderPageState>({
		available: false,
		providers: [],
		defaultModels: {},
		allowlistActive: false,
		providerCountLabel: 'Loading...',
		stats: { total: 0, connected: 0, configured: 0, disabled: 0 }
	});
	let loading = $state(true);

	async function load(): Promise<void> {
		const token = getAdminToken();
		if (!token) { loading = false; return; }
		loading = true;
		try {
			const res = await fetch('/admin/providers', { headers: buildHeaders(token) });
			if (res.ok) pageState = (await res.json()) as ProviderPageState;
		} catch {
			// will show offline state
		} finally {
			loading = false;
		}
	}

	onMount(() => { void load(); });
</script>

<ProvidersPanel {pageState} {loading} onRefresh={() => void load()} />
