<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmKnowledgeStats, type AkmKnowledgeStats } from '$lib/api.js';
	import { formatDate } from '$lib/format-date.js';
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
		gap: var(--s-sp-4);
		min-width: 0;
		max-width: 100%;
		box-sizing: border-box;
	}

	.stats-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--s-sp-4);
		flex-wrap: wrap;
		min-width: 0;
		max-width: 100%;
	}

	.stats-header > div { min-width: 0; }
	.stats-header :global(.btn) { min-height: 2.75rem; }

	.stats-header h3 {
		margin: 0 0 var(--s-sp-2);
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		font-weight: 400;
		color: var(--s-ink);
	}

	.stats-loading,
	.stats-unavailable {
		display: flex;
		align-items: center;
		gap: var(--s-sp-3);
		padding: var(--s-sp-4);
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark);
		color: var(--s-ink-3);
	}

	.stats-status {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-2);
	}

	.stats-badge {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		padding: 1px var(--s-sp-2);
		border-radius: 2px;
		border: var(--s-hair) solid var(--s-moss);
		color: var(--s-moss);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
	}

	.stats-badge-warn {
		border-color: var(--s-seal);
		color: var(--s-seal);
	}

	.stats-badge-unknown {
		border-color: var(--s-line);
		color: var(--s-ink-3);
	}

	.stats-advisories {
		margin: 0;
		padding-left: 1.25rem;
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		color: var(--s-ink-3);
	}

	.stats-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
		gap: var(--s-sp-4);
		min-width: 0;
		max-width: 100%;
	}

	.stats-card,
	.stats-grid {
		padding: var(--s-sp-4);
		border: var(--s-hair) solid var(--s-line-soft);
		border-radius: 2px;
		background: color-mix(in srgb, var(--s-ink) 2%, var(--s-paper));
	}

	.stats-card {
		display: flex;
		flex-direction: column;
		gap: var(--s-sp-1);
	}

	.stats-value {
		font-family: var(--s-font-display);
		font-size: var(--s-type-voice);
		font-weight: 400;
		color: var(--s-ink);
		line-height: 1.1;
	}

	.stats-label {
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		letter-spacing: var(--s-track-label);
		text-transform: uppercase;
		color: var(--s-ink-3);
	}

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
		gap: var(--s-sp-3) var(--s-sp-4);
		min-width: 0;
		max-width: 100%;
	}

	.stats-row {
		display: flex;
		justify-content: space-between;
		gap: var(--s-sp-3);
		border-bottom: var(--s-hair) solid var(--s-line-soft);
		padding-bottom: var(--s-sp-2);
		font-family: var(--s-font-mono);
		font-size: var(--s-type-mark-sm);
		color: var(--s-ink-3);
		min-width: 0;
	}

	.stats-row span,
	.stats-row strong { min-width: 0; overflow-wrap: anywhere; }

	.stats-row strong {
		font-family: var(--s-font-display);
		font-size: var(--s-type-deed);
		font-weight: 400;
		color: var(--s-ink);
		text-align: right;
	}

	.stats-row--wide {
		grid-column: 1 / -1;
		align-items: start;
	}

	@media (max-width: 640px) {
		.stats-row { flex-direction: column; }
		.stats-row strong { text-align: left; }
	}
</style>
