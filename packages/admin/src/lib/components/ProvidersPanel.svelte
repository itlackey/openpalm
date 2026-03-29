<script lang="ts">
	import type { ProviderActionResult, ProviderFilter, ProviderPageState, ProviderView } from '$lib/types/providers.js';
	import ProviderCard from './providers/ProviderCard.svelte';
	import ProviderEditor from './providers/ProviderEditor.svelte';
	import ProviderFilters from './providers/ProviderFilters.svelte';
	import CustomProviderForm from './providers/CustomProviderForm.svelte';

	interface Props {
		pageState: ProviderPageState;
		loading: boolean;
		onRefresh: () => void;
	}

	let { pageState, loading, onRefresh }: Props = $props();

	let search = $state('');
	let filter = $state<ProviderFilter>('all');
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
		onRefresh();
	}
</script>

<div class="providers-panel">
	<CustomProviderForm onaction={handleAction} />

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

	.workspace-grid {
		display: grid;
		grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
		gap: var(--space-3);
		align-items: start;
	}

	.catalog-column {
		display: grid;
		gap: var(--space-3);
		position: sticky;
		top: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
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
		max-height: calc(100vh - 20rem);
		overflow: auto;
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
		}

		.card-list {
			max-height: none;
		}
	}
</style>
