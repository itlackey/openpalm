<script lang="ts">
	import type { ProviderView } from '$lib/types/providers.js';

	let {
		provider,
		selected = false,
		onselect
	}: {
		provider: ProviderView;
		selected?: boolean;
		onselect?: () => void;
	} = $props();
</script>

<button class="provider-card" class:provider-card--selected={selected} class:provider-card--connected={provider.connected} type="button" onclick={onselect}>
	<div class="card-title-row">
		<div>
			<span class="card-name">{provider.name}</span>
			<span class="card-id">{provider.id}</span>
		</div>
		<span class="status-pill" class:status-pill--muted={provider.disabled}>
			{provider.disabled ? 'Disabled' : 'Ready'}
		</span>
	</div>

	<div class="card-badge-row">
		{#if provider.connected}
			<span class="badge badge--strong">Connected</span>
		{/if}
		{#if provider.configured}
			<span class="badge">Configured</span>
		{/if}
		{#if provider.supportsOauth}
			<span class="badge">OAuth</span>
		{/if}
		{#if provider.activeMainModel}
			<span class="badge">Main model</span>
		{/if}
		{#if provider.activeSmallModel}
			<span class="badge">Small model</span>
		{/if}
	</div>

	<div class="card-meta-row">
		<span>{provider.modelCount} models</span>
		<span>{provider.source}</span>
	</div>

	{#if provider.env.length > 0}
		<span class="card-env">{provider.env.slice(0, 2).join('  ·  ')}</span>
	{/if}
</button>

<style>
	.provider-card {
		width: 100%;
		text-align: left;
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition: border-color var(--transition-fast), background var(--transition-fast);
	}

	.provider-card--connected {
		border-left: 3px solid var(--color-success);
	}

	.provider-card:hover,
	.provider-card--selected {
		border-color: var(--color-primary);
		background: var(--color-primary-subtle);
	}

	.card-title-row,
	.card-meta-row,
	.card-badge-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.card-name {
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.card-id {
		display: block;
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		margin-top: 2px;
	}

	.card-badge-row {
		justify-content: flex-start;
	}

	.badge,
	.status-pill {
		display: inline-flex;
		align-items: center;
		padding: 2px var(--space-2);
		border-radius: var(--radius-full);
		font-size: 11px;
		font-weight: var(--font-medium);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.badge--strong {
		background: var(--color-success-bg);
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.status-pill--muted {
		color: var(--color-text-tertiary);
	}

	.card-meta-row,
	.card-env {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.card-env {
		line-height: 1.45;
	}
</style>
