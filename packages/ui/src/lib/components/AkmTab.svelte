<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmConfig, saveAkmConfig } from '$lib/api.js';

	interface Props {
		tokenStored: boolean;
	}

	let { tokenStored }: Props = $props();

	// ── State ───────────────────────────────────────────────────────────────────
	let config = $state<Record<string, unknown>>({});
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	// Editable fields — initialized once in load()
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let archiveRetentionDays = $state(90);
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let improveLimit = $state(25);
	let improvePreset = $state<'fast' | 'thorough' | 'mixed' | 'custom'>('custom');
	let searchMinScore = $state(0.2);

	// ── Derived read-only display ───────────────────────────────────────────────
	let llmInfo = $derived.by(() => {
		const llm = config.llm as Record<string, unknown> | undefined;
		if (!llm) return null;
		const provider = llm.provider as string | undefined;
		const model = llm.model as string | undefined;
		const endpoint = llm.endpoint as string | undefined;
		return { provider, model, endpoint };
	});

	let embeddingInfo = $derived.by(() => {
		const emb = config.embedding as Record<string, unknown> | undefined;
		if (!emb) return null;
		return {
			provider: emb.provider as string | undefined,
			model: emb.model as string | undefined,
			dimension: emb.dimension as number | undefined,
		};
	});

	// ── Load ────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const result = await fetchAkmConfig();
			config = result.config;

			// Init fields from loaded config — no $effect, init here only
			const raw = result.config;
			semanticSearchMode = (raw.semanticSearchMode as 'auto' | 'off') ?? 'auto';
			archiveRetentionDays = typeof raw.archiveRetentionDays === 'number' ? raw.archiveRetentionDays : 90;

			const outputRaw = raw.output as Record<string, unknown> | undefined;
			outputFormat = (outputRaw?.format as 'json' | 'yaml' | 'text') ?? 'json';

			const defaultsRaw = raw.defaults as Record<string, unknown> | undefined;
			const improveRaw = defaultsRaw?.improve as Record<string, unknown> | undefined;
			improveLimit = typeof improveRaw?.limit === 'number' ? improveRaw.limit : 25;
			improvePreset = (improveRaw?.preset as 'fast' | 'thorough' | 'mixed' | 'custom') ?? 'custom';

			const searchRaw = raw.search as Record<string, unknown> | undefined;
			searchMinScore = typeof searchRaw?.minScore === 'number' ? searchRaw.minScore : 0.2;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load AKM config.';
		} finally {
			loading = false;
		}
	}

	// ── Save ────────────────────────────────────────────────────────────────────
	async function save(): Promise<void> {
		saving = true;
		error = '';
		saved = false;
		try {
			await saveAkmConfig({
				semanticSearchMode,
				archiveRetentionDays,
				output: { format: outputFormat },
				defaults: { improve: { limit: improveLimit, preset: improvePreset } },
				search: { minScore: searchMinScore },
			});
			saved = true;
			setTimeout(() => { saved = false; }, 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save AKM config.';
		} finally {
			saving = false;
		}
	}

	onMount(() => { if (tokenStored) void load(); });
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>AKM Configuration</h2>
		<div class="panel-header-actions">
			<button
				class="btn btn-secondary btn-sm"
				onclick={() => void load()}
				disabled={loading || saving || !tokenStored}
			>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
			<button
				class="btn btn-primary btn-sm"
				onclick={() => void save()}
				disabled={loading || saving || !tokenStored}
			>
				{#if saving}<span class="spinner"></span>{/if}
				{saved ? 'Saved' : 'Save'}
			</button>
		</div>
	</div>

	{#if error}
		<div class="error-banner"><span>{error}</span></div>
	{/if}

	<div class="panel-body">
		<section class="config-section">
			<h3 class="section-title">Connection</h3>
			<p class="section-note">LLM and embedding connections are managed on the <strong>Capabilities</strong> tab.</p>
			{#if llmInfo}
				<div class="info-row">
					<span class="info-label">LLM</span>
					<span class="info-value">
						{llmInfo.provider}/{llmInfo.model}
						{#if llmInfo.endpoint}<span class="info-endpoint"> — {llmInfo.endpoint}</span>{/if}
					</span>
				</div>
			{/if}
			{#if embeddingInfo}
				<div class="info-row">
					<span class="info-label">Embedding</span>
					<span class="info-value">
						{embeddingInfo.provider}/{embeddingInfo.model}
						{#if embeddingInfo.dimension}<span class="info-dim"> (dim: {embeddingInfo.dimension})</span>{/if}
					</span>
				</div>
			{/if}
			{#if !llmInfo && !embeddingInfo && !loading}
				<p class="empty-note">No connection config generated yet. Save capabilities to generate the initial config.</p>
			{/if}
		</section>

		<section class="config-section">
			<h3 class="section-title">Behavior</h3>
			<div class="controls">
				<div class="control-group">
					<label class="control-label" for="semanticSearch">Semantic search</label>
					<select
						id="semanticSearch"
						class="control-input"
						bind:value={semanticSearchMode}
						disabled={loading || saving}
					>
						<option value="auto">Auto (use vector index when available)</option>
						<option value="off">Off (keyword only)</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="archiveRetention">Archive retention (days)</label>
					<input
						id="archiveRetention"
						class="control-input control-input--narrow"
						type="number"
						min="1"
						max="365"
						bind:value={archiveRetentionDays}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="outputFormat">Output format</label>
					<select
						id="outputFormat"
						class="control-input"
						bind:value={outputFormat}
						disabled={loading || saving}
					>
						<option value="json">JSON</option>
						<option value="yaml">YAML</option>
						<option value="text">Text</option>
					</select>
				</div>
			</div>
		</section>

		<section class="config-section">
			<h3 class="section-title">Improve defaults</h3>
			<div class="controls">
				<div class="control-group">
					<label class="control-label" for="improveLimit">Limit</label>
					<input
						id="improveLimit"
						class="control-input control-input--narrow"
						type="number"
						min="1"
						max="100"
						bind:value={improveLimit}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="improvePreset">Preset</label>
					<select
						id="improvePreset"
						class="control-input"
						bind:value={improvePreset}
						disabled={loading || saving}
					>
						<option value="fast">Fast</option>
						<option value="thorough">Thorough</option>
						<option value="mixed">Mixed</option>
						<option value="custom">Custom</option>
					</select>
				</div>
			</div>
		</section>

		<section class="config-section">
			<h3 class="section-title">Search tuning</h3>
			<div class="controls">
				<div class="control-group">
					<label class="control-label" for="minScore">Min score (0–1)</label>
					<input
						id="minScore"
						class="control-input control-input--narrow"
						type="number"
						min="0"
						max="1"
						step="0.01"
						bind:value={searchMinScore}
						disabled={loading || saving}
					/>
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-6);
	}

	.panel-header h2 {
		font-size: var(--text-lg);
		font-weight: var(--font-semibold);
		color: var(--color-text);
		margin: 0;
	}

	.panel-header-actions {
		display: flex;
		gap: var(--space-2);
	}

	.panel-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-8);
	}

	.config-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.section-title {
		font-size: var(--text-sm);
		font-weight: var(--font-semibold);
		color: var(--color-text);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--color-border);
	}

	.section-note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		margin: 0;
	}

	.empty-note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		font-style: italic;
		margin: 0;
	}

	.info-row {
		display: flex;
		gap: var(--space-3);
		align-items: baseline;
		font-size: var(--text-sm);
	}

	.info-label {
		font-weight: var(--font-medium);
		color: var(--color-text-secondary);
		min-width: 6rem;
		flex-shrink: 0;
	}

	.info-value {
		color: var(--color-text);
		font-family: var(--font-mono);
	}

	.info-endpoint {
		color: var(--color-text-secondary);
	}

	.info-dim {
		color: var(--color-text-secondary);
	}

	.controls {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.control-label {
		font-size: var(--text-xs);
		font-weight: var(--font-medium);
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.control-input {
		font-size: var(--text-sm);
		color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-2) var(--space-3);
		width: 100%;
		max-width: 32rem;
	}

	.control-input--narrow {
		max-width: 8rem;
	}

	.control-input:focus {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	.control-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error-banner {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		color: var(--color-error, #dc2626);
		margin-bottom: var(--space-4);
	}

	.spinner {
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
		border: 2px solid transparent;
		border-top-color: currentColor;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
