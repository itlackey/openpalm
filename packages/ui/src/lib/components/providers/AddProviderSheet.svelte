<!--
  AddProviderSheet — search-and-select sheet for picking a provider to add.
  Caller passes the full unconnected list; this component filters/searches
  and emits `onselect(provider)` when a provider is picked, or `oncustom()`
  when the "Custom provider" row is picked.
-->
<script lang="ts">
	import type { ProviderView } from '$lib/types/providers.js';

	let {
		providers,
		onselect,
		oncustom,
		onclose
	}: {
		providers: ProviderView[];
		onselect: (p: ProviderView) => void;
		oncustom: () => void;
		onclose: () => void;
	} = $props();

	let query = $state('');

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return providers;
		return providers.filter(
			(p) =>
				p.name.toLowerCase().includes(q) ||
				p.id.toLowerCase().includes(q)
		);
	});
</script>

<div class="sheet-overlay" onclick={onclose} role="presentation"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="add-provider-title">
	<header class="sheet-header">
		<h2 class="sheet-title" id="add-provider-title">Add provider</h2>
		<button type="button" class="sheet-close" onclick={onclose} aria-label="Close">×</button>
	</header>

	<div class="sheet-search">
		<!-- svelte-ignore a11y_autofocus -->
		<input
			type="search"
			class="form-input"
			placeholder="Search providers…"
			bind:value={query}
			autocomplete="off"
			autofocus
		/>
	</div>

	<div class="sheet-body sheet-body--list">
		{#if filtered.length === 0 && query}
			<div class="empty">No providers match "{query}".</div>
		{:else}
			{#each filtered as p (p.id)}
				<button type="button" class="provider-pick" onclick={() => onselect(p)}>
					<span class="provider-name">{p.name}</span>
					{#if p.modelCount > 0}
						<span class="provider-meta">{p.modelCount} models</span>
					{/if}
				</button>
			{/each}

			<button type="button" class="provider-pick provider-pick--custom" onclick={oncustom}>
				<span class="provider-name">Custom provider</span>
				<span class="provider-meta">OpenAI-compatible</span>
			</button>
		{/if}
	</div>
</div>

<style>
	.sheet-search {
		padding: var(--space-3) var(--space-5);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	.sheet-body--list {
		padding: 0;
	}

	.provider-pick {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: var(--space-3) var(--space-5);
		background: none;
		border: none;
		border-bottom: 1px solid var(--color-bg-tertiary);
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}

	.provider-pick:hover {
		background: var(--color-surface-hover);
	}

	.provider-pick--custom {
		border-top: 1px solid var(--color-border);
		color: var(--color-primary);
	}

	.provider-name {
		flex: 1;
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		color: var(--color-text);
	}

	.provider-pick--custom .provider-name {
		color: var(--color-primary);
	}

	.provider-meta {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.empty {
		padding: var(--space-6) var(--space-5);
		text-align: center;
		color: var(--color-text-tertiary);
		font-size: var(--text-sm);
	}
</style>
