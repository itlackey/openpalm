<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmKnowledgeStats, type AkmKnowledgeStats } from '$lib/api.js';
	import Spinner from '$lib/components/common/Spinner.svelte';

	type Props = {
		disabled: boolean;
	};

	let { disabled }: Props = $props();

	let loading = $state(false);
	let loadError = $state('');
	let stats = $state<AkmKnowledgeStats | null>(null);

	async function load(): Promise<void> {
		loading = true;
		loadError = '';
		try {
			stats = await fetchAkmKnowledgeStats();
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load knowledge stats.';
		} finally {
			loading = false;
		}
	}

	function formatDate(value: string | null): string {
		if (!value) return '—';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
	}

	function formatFlag(value: boolean | null, onLabel = 'Yes', offLabel = 'No'): string {
		if (value === true) return onLabel;
		if (value === false) return offLabel;
		return '—';
	}

	function formatMetric(value: number | null): string {
		return value == null ? '—' : value.toLocaleString();
	}

	function healthLabel(status: 'pass' | 'warn' | 'unknown'): string {
		return status === 'pass' ? 'Healthy' : status === 'warn' ? 'Warnings' : 'Unknown';
	}

	onMount(() => {
		void load();
	});
</script>

<section class="stats-section">
	<div class="stats-header">
		<div>
			<h3>Knowledge &amp; Learning</h3>
			<p class="section-note">Read-only AKM health, memory counts, improve activity, and pending proposals from live CLI JSON output.</p>
		</div>
		<button class="btn btn-secondary btn-sm" type="button" onclick={() => void load()} {disabled}>
			{#if loading}<Spinner />{/if}
			Refresh stats
		</button>
	</div>

	{#if loadError}
		<div class="feedback feedback--error" role="alert">{loadError}</div>
	{:else if !stats || loading}
		<div class="stats-loading">
			<Spinner />
			<span>Loading knowledge stats…</span>
		</div>
	{:else if !stats.available}
		<div class="stats-unavailable">
			<p>{stats.reason ?? 'The akm CLI is not reachable from the admin host.'}</p>
		</div>
	{:else}
		<div class="stats-status">
			<span class={`stats-badge ${stats.health.status === 'warn' ? 'stats-badge-warn' : stats.health.status === 'unknown' ? 'stats-badge-unknown' : ''}`}>{healthLabel(stats.health.status)}</span>
			{#if stats.health.advisories.length > 0}
				<ul class="stats-advisories">
					{#each stats.health.advisories as advisory (advisory)}
						<li>{advisory}</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="stats-cards">
			<div class="stats-card">
				<span class="stats-value">{formatMetric(stats.index.entryCount)}</span>
				<span class="stats-label">Indexed assets</span>
			</div>
			<div class="stats-card">
				<span class="stats-value">{formatMetric(stats.proposals.pending)}</span>
				<span class="stats-label">Pending proposals</span>
			</div>
			<div class="stats-card">
				<span class="stats-value">{formatMetric(stats.improve.completed)}</span>
				<span class="stats-label">Improve runs completed</span>
			</div>
			<div class="stats-card">
				<span class="stats-value">{formatMetric(stats.improve.reflectCooldown)}</span>
				<span class="stats-label">Reflect cooldown skips</span>
			</div>
		</div>

		<div class="stats-grid">
			<div class="stats-row"><span>AKM version</span><strong>{stats.version ?? '—'}</strong></div>
			<div class="stats-row"><span>Last indexed</span><strong>{formatDate(stats.index.lastBuiltAt)}</strong></div>
			<div class="stats-row"><span>Embeddings indexed</span><strong>{formatFlag(stats.index.hasEmbeddings)}</strong></div>
			<div class="stats-row"><span>Vector search available</span><strong>{formatFlag(stats.index.vecAvailable)}</strong></div>
			<div class="stats-row"><span>Memories indexed</span><strong>{formatMetric(stats.assetCounts.memory)}</strong></div>
			<div class="stats-row"><span>Skills indexed</span><strong>{formatMetric(stats.assetCounts.skill)}</strong></div>
			<div class="stats-row"><span>Lessons indexed</span><strong>{formatMetric(stats.assetCounts.lesson)}</strong></div>
			<div class="stats-row"><span>Improve invoked</span><strong>{formatMetric(stats.improve.invoked)}</strong></div>
			<div class="stats-row"><span>Improve skipped</span><strong>{formatMetric(stats.improve.skipped)}</strong></div>
			<div class="stats-row"><span>Reflect OK</span><strong>{formatMetric(stats.improve.reflectOk)}</strong></div>
			<div class="stats-row"><span>Consolidation promoted</span><strong>{formatMetric(stats.improve.consolidation.promoted)}</strong></div>
			<div class="stats-row"><span>Consolidation merged</span><strong>{formatMetric(stats.improve.consolidation.merged)}</strong></div>
			<div class="stats-row"><span>Consolidation deleted</span><strong>{formatMetric(stats.improve.consolidation.deleted)}</strong></div>
		</div>

		<div class="stats-grid">
			<div class="stats-row stats-row--wide"><span>Pending proposals</span><strong>{stats.proposals.pending === 0 ? 'None pending.' : `${stats.proposals.pending} pending`}</strong></div>
			{#if stats.proposals.items.length > 0}
				{#each stats.proposals.items as proposal, index (proposal.ref ?? `${proposal.generator ?? 'proposal'}-${index}`)}
					<div class="stats-row stats-row--wide">
						<span>{proposal.ref ?? 'Unknown ref'}</span>
						<strong>{proposal.generator ?? 'unknown generator'} · {proposal.status ?? 'pending'} · {formatDate(proposal.createdAt)}</strong>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</section>

<style>
	.stats-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.stats-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.stats-header h3 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--font-semibold);
		color: var(--color-text);
	}

	.stats-loading,
	.stats-unavailable {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
	}

	.stats-status {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.stats-badge {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--color-success) 16%, transparent);
		color: var(--color-success);
		font-size: var(--text-xs);
		font-weight: var(--font-semibold);
	}

	.stats-badge-warn {
		background: color-mix(in srgb, var(--color-warning) 18%, transparent);
		color: var(--color-warning);
	}

	.stats-badge-unknown {
		background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent);
		color: var(--color-text-secondary);
	}

	.stats-advisories {
		margin: 0;
		padding-left: 1.25rem;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.stats-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: var(--space-4);
	}

	.stats-card,
	.stats-grid {
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-secondary);
	}

	.stats-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.stats-value {
		font-size: var(--text-xl);
		font-weight: var(--font-bold);
		color: var(--color-text);
		line-height: 1.1;
	}

	.stats-label {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: var(--space-3) var(--space-4);
	}

	.stats-row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.stats-row strong {
		color: var(--color-text);
		text-align: right;
	}

	.stats-row--wide {
		grid-column: 1 / -1;
		align-items: start;
	}

	@media (max-width: 640px) {
		.stats-row {
			flex-direction: column;
		}

		.stats-row strong {
			text-align: left;
		}
	}
</style>
