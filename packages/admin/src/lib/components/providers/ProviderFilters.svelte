<script lang="ts">
	import type { ProviderFilter } from '$lib/types/providers.js';

	let {
		search = $bindable(''),
		filter = $bindable('all'),
		counts
	}: {
		search?: string;
		filter?: ProviderFilter;
		counts: Record<ProviderFilter, number>;
	} = $props();

	const filters: Array<{ value: ProviderFilter; label: string }> = [
		{ value: 'all', label: 'All' },
		{ value: 'connected', label: 'Connected' },
		{ value: 'configured', label: 'Configured' },
		{ value: 'oauth', label: 'OAuth' },
		{ value: 'disabled', label: 'Disabled' }
	];
</script>

<section class="filters">
	<label class="search-shell" aria-label="Search providers">
		<span class="search-label">Find a provider</span>
		<input class="form-input" bind:value={search} name="search" autocomplete="off" placeholder="Search by provider, model, or env var" type="search" />
	</label>

	<div class="chip-row" aria-label="Provider filters">
		{#each filters as option (option.value)}
			<button
				type="button"
				class="chip"
				class:chip--active={filter === option.value}
				onclick={() => { filter = option.value; }}
			>
				<span>{option.label}</span>
				<strong class="chip-count">{counts[option.value]}</strong>
			</button>
		{/each}
	</div>
</section>

<style>
	.filters {
		display: grid;
		gap: var(--space-3);
	}

	.search-shell {
		display: grid;
		gap: var(--space-1);
	}

	.search-label {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-tertiary);
		font-weight: var(--font-semibold);
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: inherit;
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
		transition: border-color var(--transition-fast), background var(--transition-fast);
	}

	.chip-count {
		font-size: var(--text-xs);
		padding: 1px var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-bg-tertiary);
	}

	.chip--active {
		background: var(--color-primary-subtle);
		border-color: var(--color-primary);
	}
</style>
