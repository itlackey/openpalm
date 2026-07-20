<!--
  AddProviderSheet — search-and-select sheet for picking a provider to add.
  Caller passes the full unconnected list; this component filters/searches
  and emits `onselect(provider)` when a provider is picked, or `oncustom()`
  when the "Custom provider" row is picked.
-->
<script lang="ts">
	import type { ProviderView } from '$lib/types/providers.js';
	import Drawer from '@openpalm/ui-kit/components/common/Drawer.svelte';

	let {
		providers,
		onselect,
		oncustom,
		onclose,
		returnFocus
	}: {
		providers: ProviderView[];
		onselect: (p: ProviderView) => void;
		oncustom: () => void;
		onclose: () => void;
		returnFocus?: () => HTMLElement | null;
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

<Drawer open={true} title="Add provider" onClose={onclose} deferFocusRestore {returnFocus}>
	<label class="form-label add-search-label" for="add-provider-search">Search providers</label>
	<input
		id="add-provider-search"
		type="search"
		class="form-input add-search"
		placeholder="Search providers…"
		bind:value={query}
		autocomplete="off"
	/>
	<div class="pick-list">
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
</Drawer>

<style>
	.add-search-label {
		display: block;
		margin-bottom: var(--s-sp-1);
	}

	.add-search {
		width: 100%;
		margin-bottom: var(--s-sp-3);
	}
	/* Bleed the list to the drawer body edges (drawer body has space-5 padding). */
	.pick-list {
		margin: 0 calc(var(--s-sp-5) * -1) calc(var(--s-sp-5) * -1);
	}

	.provider-pick {
		display: flex;
		align-items: center;
		gap: var(--s-sp-3);
		width: 100%;
		padding: var(--s-sp-3) var(--s-sp-5);
		background: none;
		border: none;
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		cursor: pointer;
		text-align: left;
		font-family: inherit;
	}

	.provider-pick:hover {
		background: color-mix(in srgb, var(--s-ink) 4%, var(--s-paper));
	}

	.provider-pick--custom {
		border-top: var(--s-hair) solid var(--s-line);
	}

	.provider-name {
		flex: 1;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink);
	}

	.provider-pick--custom .provider-name {
		color: var(--s-seal);
	}

	.provider-meta {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}

	.empty {
		padding: var(--s-sp-6) var(--s-sp-5);
		text-align: center;
		color: var(--s-ink-3);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
	}
</style>
