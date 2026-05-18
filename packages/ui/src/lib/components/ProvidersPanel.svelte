<script lang="ts">
	import { onMount } from 'svelte';
	import { buildHeaders } from '$lib/api.js';
	import type { ProviderActionResult, ProviderFilter, ProviderPageState, ProviderView } from '$lib/types/providers.js';
	import ProviderCard from './providers/ProviderCard.svelte';
	import ProviderEditor from './providers/ProviderEditor.svelte';
	import ProviderFilters from './providers/ProviderFilters.svelte';
	import CustomProviderForm from './providers/CustomProviderForm.svelte';

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
		loading = true;
		try {
			const res = await fetch('/admin/providers', { headers: buildHeaders() });
			if (res.ok) {
				pageState = (await res.json()) as ProviderPageState;
				// First-run fallback: if nothing's connected yet, show "All"
				// so the operator can pick a starting provider. Only flips
				// once — won't fight the user's later filter choices.
				if (!hasInitializedFilter) {
					if (pageState.providers.filter((p) => p.connected).length === 0 && pageState.providers.length > 0) {
						filter = 'all';
					}
					hasInitializedFilter = true;
				}
			}
		} catch {
			// will show offline state
		} finally {
			loading = false;
		}
	}

	let hasInitializedFilter = false;

	onMount(() => { void load(); });

	let search = $state('');
	// Default to "connected" — surfacing only the providers that are
	// actually wired up keeps the initial view tractable (OpenCode ships
	// 130+ catalog entries). The filter pills + search box are right
	// there for browsing the rest. On a fresh install with nothing
	// connected, `load()` flips this to "all" so the operator can pick a
	// starting provider.
	let filter = $state<ProviderFilter>('connected');
	let selectedProviderId = $state('');
	let lastActionResult = $state<ProviderActionResult | undefined>(undefined);

	const counts = $derived({
		all: pageState.providers.length,
		connected: pageState.providers.filter((p) => p.connected).length,
		configured: pageState.providers.filter((p) => p.configured).length,
		oauth: pageState.providers.filter((p) => p.supportsOauth).length,
		disabled: pageState.providers.filter((p) => p.disabled).length
	});

	const filteredProviders = $derived.by(() => {
		const query = search.trim().toLowerCase();

		return pageState.providers.filter((provider) => {
			const matchesQuery =
				query.length === 0 ||
				provider.name.toLowerCase().includes(query) ||
				provider.id.toLowerCase().includes(query) ||
				provider.env.some((e) => e.toLowerCase().includes(query)) ||
				provider.models.some((m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query));

			if (!matchesQuery) return false;

			if (filter === 'connected') return provider.connected;
			if (filter === 'configured') return provider.configured;
			if (filter === 'oauth') return provider.supportsOauth;
			if (filter === 'disabled') return provider.disabled;

			return true;
		});
	});

	const preferredProviderId = $derived(lastActionResult?.selectedProviderId ?? selectedProviderId ?? pageState.providers[0]?.id ?? '');

	const activeProvider: ProviderView | undefined = $derived(
		filteredProviders.find((p) => p.id === preferredProviderId) ?? filteredProviders[0]
	);

	function handleAction(result: ProviderActionResult) {
		lastActionResult = result;
		if (result.selectedProviderId) selectedProviderId = result.selectedProviderId;
		void load();
	}

	// ── Local provider detection (Ollama / LM Studio / Docker Model Runner)
	type LocalProbe = { provider: string; url: string; available: boolean };
	const LOCAL_LABELS: Record<string, string> = {
		ollama: 'Local Ollama',
		lmstudio: 'Local LM Studio',
		'model-runner': 'Docker Model Runner',
	};
	let localProbes = $state<LocalProbe[]>([]);
	let localRegistering = $state<string | null>(null);
	let localMessage = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);

	async function probeLocal(): Promise<void> {
		try {
			const res = await fetch('/admin/providers/local', { headers: buildHeaders() });
			if (!res.ok) return;
			const data = (await res.json()) as { providers: LocalProbe[] };
			localProbes = data.providers;
		} catch { /* offline — keep empty */ }
	}

	async function registerLocal(provider: string): Promise<void> {
		localRegistering = provider;
		localMessage = null;
		try {
			const res = await fetch('/admin/providers/local', {
				method: 'POST',
				headers: { ...buildHeaders(), 'content-type': 'application/json' },
				body: JSON.stringify({ provider }),
			});
			const result = (await res.json()) as ProviderActionResult;
			if (result.ok) {
				localMessage = { kind: 'ok', text: result.message ?? 'Registered.' };
				await load();
				if (result.selectedProviderId) selectedProviderId = result.selectedProviderId;
			} else {
				localMessage = { kind: 'err', text: result.message ?? 'Registration failed.' };
			}
		} catch (err) {
			localMessage = { kind: 'err', text: err instanceof Error ? err.message : 'Request failed.' };
		} finally {
			localRegistering = null;
		}
	}

	const availableLocal = $derived(localProbes.filter((p) => p.available));
	const registeredLocalIds = $derived(new Set(pageState.providers.filter((p) => p.connected).map((p) => p.id)));

	onMount(() => { void probeLocal(); });
</script>

<div class="providers-panel">
	{#if !pageState.available}
		<section class="offline-state">
			<h3 class="section-heading">OpenCode server unavailable</h3>
			<p class="section-desc">
				The OpenCode server is not reachable. Start it and refresh, or check the container logs.
			</p>
			{#if pageState.error}
				<p class="error-detail">{pageState.error}</p>
			{/if}
		</section>
	{:else}
		{#if availableLocal.length > 0}
			<section class="local-detected">
				<div class="local-detected-header">
					<h4 class="section-heading">Detected on this host</h4>
					<button type="button" class="btn-link" onclick={() => void probeLocal()}>Refresh</button>
				</div>
				<div class="local-detected-list">
					{#each availableLocal as probe (probe.provider)}
						<div class="local-detected-row">
							<div class="local-detected-info">
								<strong>{LOCAL_LABELS[probe.provider] ?? probe.provider}</strong>
								<code>{probe.url}</code>
							</div>
							{#if registeredLocalIds.has(probe.provider)}
								<span class="local-detected-tag">registered</span>
							{:else}
								<button
									type="button"
									class="btn btn-outline btn-sm"
									disabled={localRegistering === probe.provider}
									onclick={() => void registerLocal(probe.provider)}
								>
									{#if localRegistering === probe.provider}<span class="spinner"></span>{/if}
									Register
								</button>
							{/if}
						</div>
					{/each}
				</div>
				{#if localMessage}
					<p class="local-detected-message" class:local-detected-message--err={localMessage.kind === 'err'}>{localMessage.text}</p>
				{/if}
			</section>
		{/if}

		<section class="workspace-grid">
			<div class="catalog-column">
				<ProviderFilters bind:search bind:filter {counts} />

				<div class="catalog-header">
					<span class="catalog-label">{pageState.providerCountLabel}</span>
					{#if pageState.currentModel}
						<span class="catalog-label">Main model: <code>{pageState.currentModel}</code></span>
					{/if}
				</div>

				<div class="card-list">
					{#if loading}
						<p class="section-empty"><span class="spinner"></span> Loading providers...</p>
					{:else}
						{#each filteredProviders as provider (provider.id)}
							<ProviderCard
								{provider}
								selected={activeProvider?.id === provider.id}
								onselect={() => { selectedProviderId = provider.id; lastActionResult = undefined; }}
							/>
						{:else}
							<div class="empty-search">
								<h4 class="section-heading">No provider matches this view.</h4>
								<p class="section-desc">Try a broader search or switch the filter to see more providers.</p>
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<div class="editor-column">
				{#if activeProvider}
					{#key activeProvider.id}
						<ProviderEditor
							provider={activeProvider}
							currentModel={pageState.currentModel}
							currentSmallModel={pageState.currentSmallModel}
							allowlistActive={pageState.allowlistActive}
							onaction={handleAction}
						/>
					{/key}
				{/if}
			</div>
		</section>
	{/if}

	<CustomProviderForm onaction={handleAction} />
</div>

<style>
	.providers-panel {
		display: grid;
		gap: var(--space-3);
	}

	.offline-state {
		padding: var(--space-5);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.section-heading {
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
		color: var(--color-text);
		margin-bottom: var(--space-2);
	}

	.section-desc {
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
	}

	.section-empty {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
		padding: var(--space-3);
	}

	.error-detail {
		margin-top: var(--space-2);
		font-size: var(--text-xs);
		color: var(--color-danger);
	}

	.local-detected {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3) var(--space-4);
		margin-bottom: var(--space-4);
	}

	.local-detected-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-2);
	}

	.local-detected-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.local-detected-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.local-detected-info {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-sm);
	}

	.local-detected-info code {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
	}

	.local-detected-tag {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: var(--color-success-bg);
		color: var(--color-success);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.local-detected-message {
		margin-top: var(--space-2);
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.local-detected-message--err {
		color: var(--color-danger);
	}

	.btn-link {
		background: none;
		border: none;
		color: var(--color-primary);
		font-size: var(--text-xs);
		cursor: pointer;
		text-decoration: underline;
	}

	.btn-link:hover {
		color: var(--color-primary-hover);
	}

	.workspace-grid {
		display: grid;
		grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
		gap: var(--space-3);
		align-items: start;
	}

	.catalog-column {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		position: sticky;
		top: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		max-height: calc(100vh - var(--nav-height, 56px) - var(--space-8));
	}

	.editor-column {
		min-width: 0;
	}

	.catalog-header {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.catalog-label {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.catalog-label code {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		padding: 1px var(--space-1);
		border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary);
	}

	.card-list {
		display: grid;
		gap: var(--space-2);
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 2px;
	}

	.empty-search {
		padding: var(--space-4);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		border: 1px dashed var(--color-border);
	}

	@media (max-width: 900px) {
		.workspace-grid {
			grid-template-columns: 1fr;
		}

		.catalog-column {
			position: static;
			max-height: none;
		}
	}
</style>
