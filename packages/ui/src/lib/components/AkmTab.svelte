<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmConfig, saveAkmConfig } from '$lib/api.js';

	interface Props {
		tokenStored: boolean;
	}

	let { tokenStored }: Props = $props();

	// ── Status ──────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	// ── LLM Connection ──────────────────────────────────────────────────────────
	let llmEndpoint = $state('');
	let llmModel = $state('');
	let llmProvider = $state('');
	let llmApiKey = $state('');

	// ── Embedding Connection ────────────────────────────────────────────────────
	let embEndpoint = $state('');
	let embModel = $state('');
	let embProvider = $state('');
	let embDimension = $state(1536);

	// ── Features ────────────────────────────────────────────────────────────────
	let feedbackDistillation = $state(true);
	let memoryInference = $state(true);
	let memoryConsolidation = $state(true);

	// ── Behavior ────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let archiveRetentionDays = $state(90);
	let stashInheritance = $state<'merge' | 'replace'>('merge');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');

	// ── Improve ─────────────────────────────────────────────────────────────────
	let improveLimit = $state(25);
	let improvePreset = $state<'fast' | 'thorough' | 'mixed' | 'custom'>('custom');

	// ── Search ──────────────────────────────────────────────────────────────────
	let searchMinScore = $state(0.2);

	// ── Load ────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const { config } = await fetchAkmConfig();

			const llm = config.llm as Record<string, unknown> | undefined;
			llmEndpoint = (llm?.endpoint as string) ?? '';
			llmModel = (llm?.model as string) ?? '';
			llmProvider = (llm?.provider as string) ?? '';
			llmApiKey = (llm?.apiKey as string) ?? '';
			const features = llm?.features as Record<string, unknown> | undefined;
			feedbackDistillation = (features?.feedback_distillation as boolean) ?? true;
			memoryInference = (features?.memory_inference as boolean) ?? true;
			memoryConsolidation = (features?.memory_consolidation as boolean) ?? true;

			const emb = config.embedding as Record<string, unknown> | undefined;
			embEndpoint = (emb?.endpoint as string) ?? '';
			embModel = (emb?.model as string) ?? '';
			embProvider = (emb?.provider as string) ?? '';
			embDimension = typeof emb?.dimension === 'number' ? emb.dimension : 1536;

			semanticSearchMode = (config.semanticSearchMode as 'auto' | 'off') ?? 'auto';
			archiveRetentionDays = typeof config.archiveRetentionDays === 'number' ? config.archiveRetentionDays : 90;
			stashInheritance = (config.stashInheritance as 'merge' | 'replace') ?? 'merge';

			const output = config.output as Record<string, unknown> | undefined;
			outputFormat = (output?.format as 'json' | 'yaml' | 'text') ?? 'json';

			const defaults = config.defaults as Record<string, unknown> | undefined;
			const improve = defaults?.improve as Record<string, unknown> | undefined;
			improveLimit = typeof improve?.limit === 'number' ? improve.limit : 25;
			improvePreset = (improve?.preset as 'fast' | 'thorough' | 'mixed' | 'custom') ?? 'custom';

			const search = config.search as Record<string, unknown> | undefined;
			searchMinScore = typeof search?.minScore === 'number' ? search.minScore : 0.2;
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
			const llm: Record<string, unknown> = {
				endpoint: llmEndpoint,
				model: llmModel,
				features: {
					feedback_distillation: feedbackDistillation,
					memory_inference: memoryInference,
					memory_consolidation: memoryConsolidation,
				},
			};
			if (llmProvider) llm.provider = llmProvider;
			if (llmApiKey) llm.apiKey = llmApiKey;

			const embedding: Record<string, unknown> = {
				endpoint: embEndpoint,
				model: embModel,
				dimension: embDimension,
			};
			if (embProvider) embedding.provider = embProvider;

			await saveAkmConfig({
				llm,
				embedding,
				semanticSearchMode,
				archiveRetentionDays,
				stashInheritance,
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

		<!-- ── LLM Connection ─────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Connection</h3>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="llmEndpoint">Endpoint</label>
					<input
						id="llmEndpoint"
						class="control-input"
						type="url"
						spellcheck="false"
						placeholder="https://api.openai.com/v1/chat/completions"
						bind:value={llmEndpoint}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="llmModel">Model</label>
					<input
						id="llmModel"
						class="control-input"
						type="text"
						spellcheck="false"
						placeholder="gpt-4o"
						bind:value={llmModel}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="llmProvider">Provider (label)</label>
					<input
						id="llmProvider"
						class="control-input"
						type="text"
						spellcheck="false"
						placeholder="openai"
						bind:value={llmProvider}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="llmApiKey">API Key</label>
					<input
						id="llmApiKey"
						class="control-input"
						type="text"
						spellcheck="false"
						placeholder="$&#123;AKM_LLM_API_KEY&#125; or literal key"
						bind:value={llmApiKey}
						disabled={loading || saving}
					/>
				</div>
			</div>
		</section>

		<!-- ── Embedding Connection ───────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Embedding Connection</h3>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="embEndpoint">Endpoint</label>
					<input
						id="embEndpoint"
						class="control-input"
						type="url"
						spellcheck="false"
						placeholder="https://api.openai.com/v1/embeddings"
						bind:value={embEndpoint}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="embModel">Model</label>
					<input
						id="embModel"
						class="control-input"
						type="text"
						spellcheck="false"
						placeholder="text-embedding-3-small"
						bind:value={embModel}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="embProvider">Provider (label)</label>
					<input
						id="embProvider"
						class="control-input"
						type="text"
						spellcheck="false"
						placeholder="openai"
						bind:value={embProvider}
						disabled={loading || saving}
					/>
				</div>
				<div class="control-group">
					<label class="control-label" for="embDimension">Dimensions</label>
					<input
						id="embDimension"
						class="control-input control-input--narrow"
						type="number"
						min="1"
						bind:value={embDimension}
						disabled={loading || saving}
					/>
				</div>
			</div>
		</section>

		<!-- ── Features ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Features</h3>
			<div class="controls controls--toggles">
				<label class="toggle-row">
					<input type="checkbox" bind:checked={feedbackDistillation} disabled={loading || saving} />
					<span class="toggle-label">Feedback distillation</span>
					<span class="toggle-hint">Distill durable lessons from feedback during improve runs</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={memoryInference} disabled={loading || saving} />
					<span class="toggle-label">Memory inference</span>
					<span class="toggle-hint">Infer new memories from assistant sessions</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={memoryConsolidation} disabled={loading || saving} />
					<span class="toggle-label">Memory consolidation</span>
					<span class="toggle-hint">Merge and deduplicate overlapping memories</span>
				</label>
			</div>
		</section>

		<!-- ── Behavior ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Behavior</h3>
			<div class="controls controls--grid">
				<div class="control-group">
					<label class="control-label" for="semanticSearch">Semantic search</label>
					<select
						id="semanticSearch"
						class="control-input"
						bind:value={semanticSearchMode}
						disabled={loading || saving}
					>
						<option value="auto">Auto (vector index when available)</option>
						<option value="off">Off (keyword only)</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="stashInheritance">Stash inheritance</label>
					<select
						id="stashInheritance"
						class="control-input"
						bind:value={stashInheritance}
						disabled={loading || saving}
					>
						<option value="merge">Merge (project stash appends to global)</option>
						<option value="replace">Replace (project stash replaces global)</option>
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

		<!-- ── Improve ───────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Improve defaults</h3>
			<div class="controls controls--grid">
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
				<div class="control-group">
					<label class="control-label" for="improveLimit">Asset limit per run</label>
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
			</div>
		</section>

		<!-- ── Search ────────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Search tuning</h3>
			<div class="controls controls--grid">
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
		gap: var(--space-4);
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

	.controls {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.controls--grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: var(--space-4);
	}

	.control-group--wide {
		grid-column: 1 / -1;
	}

	.controls--toggles {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
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

	.toggle-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
	}

	.toggle-row input[type="checkbox"] {
		width: 1rem;
		height: 1rem;
		flex-shrink: 0;
	}

	.toggle-label {
		font-weight: var(--font-medium);
		color: var(--color-text);
	}

	.toggle-hint {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
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
