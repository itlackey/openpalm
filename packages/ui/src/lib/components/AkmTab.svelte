<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmConfig, saveAkmConfig } from '$lib/api.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	// ── Status ──────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	// ── Profile types ────────────────────────────────────────────────────────────
	interface LlmProfile {
		name: string;
		endpoint: string;
		model: string;
		provider: string;
		apiKey: string;
		temperature: string;
		maxTokens: string;
		timeoutMs: string;
		concurrency: string;
		contextLength: string;
		judgeModel: string;
		supportsJsonSchema: boolean;
		memory_inference: boolean;
		memory_consolidation: boolean;
		feedback_distillation: boolean;
		graph_extraction: boolean;
		curate_rerank: boolean;
		lesson_quality_gate: boolean;
		proposal_quality_gate: boolean;
		metadata_enhance: boolean;
		memory_contradiction_detection: boolean;
	}

	interface AgentProfile {
		name: string;
		platform: 'opencode' | 'claude' | 'opencode-sdk';
		bin: string;
		args: string;
		workspace: string;
		model: string;
	}

	// ── LLM Profiles ─────────────────────────────────────────────────────────────
	let llmProfiles = $state<LlmProfile[]>([]);
	let defaultLlmProfile = $state('');
	let expandedLlmIdx = $state<number | null>(null);

	// ── Agent Profiles ────────────────────────────────────────────────────────────
	let agentProfiles = $state<AgentProfile[]>([]);
	let defaultAgentProfile = $state('');
	let expandedAgentIdx = $state<number | null>(null);

	// ── LLM Connection (v1 compat) ────────────────────────────────────────────────
	let llmEndpoint = $state('');
	let llmModel = $state('');
	let llmProvider = $state('');
	let llmApiKey = $state('');
	let llmTemperature = $state('');
	let llmMaxTokens = $state('');
	let llmTimeoutMs = $state('');
	let llmConcurrency = $state('');
	let llmContextLength = $state('');
	let llmJudgeModel = $state('');
	let llmSupportsJsonSchema = $state(false);

	// ── LLM Feature Flags ─────────────────────────────────────────────────────────
	let featMemoryInference = $state(true);
	let featMemoryConsolidation = $state(true);
	let featFeedbackDistillation = $state(true);
	let featGraphExtraction = $state(true);
	let featCurateRerank = $state(false);
	let featLessonQualityGate = $state(false);
	let featProposalQualityGate = $state(false);
	let featMetadataEnhance = $state(false);
	let featMemoryContradiction = $state(false);

	// ── Embedding Connection ──────────────────────────────────────────────────────
	let embEndpoint = $state('');
	let embModel = $state('');
	let embProvider = $state('');
	let embApiKey = $state('');
	let embDimension = $state(1536);
	let embLocalModel = $state('');
	let embBatchSize = $state('');
	let embChunkSize = $state('');
	let embContextLength = $state('');
	let embOllamaNumCtx = $state('');

	// ── Behavior ──────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let archiveRetentionDays = $state(90);
	let stashInheritance = $state<'merge' | 'replace'>('merge');
	let stashDir = $state('');
	let defaultWriteTarget = $state('');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let outputDetail = $state<'brief' | 'normal' | 'full'>('brief');

	// ── Improve Defaults ──────────────────────────────────────────────────────────
	let improveLimit = $state(25);
	let improvePreset = $state<'fast' | 'thorough' | 'mixed' | 'custom'>('custom');
	let improveHalfLifeDays = $state(30);
	let improveFeedbackBoost = $state(1.5);
	let improveReflectCooldown = $state('');

	// ── Search ────────────────────────────────────────────────────────────────────
	let searchMinScore = $state(0.2);
	let graphDirectBoostPerEntity = $state(0.25);
	let graphDirectBoostCap = $state(0.75);
	let graphHopBoostPerEntity = $state(0.1);
	let graphHopBoostCap = $state(0.3);
	let graphMaxHops = $state(1);
	let graphConfidenceMode = $state<'off' | 'blend' | 'multiply'>('blend');
	let graphConfidenceWeight = $state(0.2);

	// ── Feedback ──────────────────────────────────────────────────────────────────
	let feedbackRequireReason = $state(true);
	let feedbackAllowedModes = $state('incorrect, outdated, dangerous, incomplete, redundant');

	// ── Helpers ───────────────────────────────────────────────────────────────────
	function optNum(s: string): number | undefined {
		const n = parseFloat(s);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}
	function optInt(s: string): number | undefined {
		const n = parseInt(s, 10);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}

	function newLlmProfile(): LlmProfile {
		return {
			name: '', endpoint: '', model: '', provider: '', apiKey: '',
			temperature: '', maxTokens: '', timeoutMs: '', concurrency: '',
			contextLength: '', judgeModel: '', supportsJsonSchema: false,
			memory_inference: true, memory_consolidation: true, feedback_distillation: false,
			graph_extraction: true, curate_rerank: false, lesson_quality_gate: false,
			proposal_quality_gate: false, metadata_enhance: false, memory_contradiction_detection: false,
		};
	}

	function newAgentProfile(): AgentProfile {
		return { name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}

	function profileFromRaw(raw: Record<string, unknown>): Omit<LlmProfile, 'name'> {
		const f = (raw.features as Record<string, unknown>) ?? {};
		return {
			endpoint: (raw.endpoint as string) ?? '',
			model: (raw.model as string) ?? '',
			provider: (raw.provider as string) ?? '',
			apiKey: (raw.apiKey as string) ?? '',
			temperature: raw.temperature != null ? String(raw.temperature) : '',
			maxTokens: raw.maxTokens != null ? String(raw.maxTokens) : '',
			timeoutMs: raw.timeoutMs != null ? String(raw.timeoutMs) : '',
			concurrency: raw.concurrency != null ? String(raw.concurrency) : '',
			contextLength: raw.contextLength != null ? String(raw.contextLength) : '',
			judgeModel: (raw.judgeModel as string) ?? '',
			supportsJsonSchema: (raw.supportsJsonSchema as boolean) ?? false,
			memory_inference: (f.memory_inference as boolean) ?? true,
			memory_consolidation: (f.memory_consolidation as boolean) ?? true,
			feedback_distillation: (f.feedback_distillation as boolean) ?? false,
			graph_extraction: (f.graph_extraction as boolean) ?? true,
			curate_rerank: (f.curate_rerank as boolean) ?? false,
			lesson_quality_gate: (f.lesson_quality_gate as boolean) ?? false,
			proposal_quality_gate: (f.proposal_quality_gate as boolean) ?? false,
			metadata_enhance: (f.metadata_enhance as boolean) ?? false,
			memory_contradiction_detection: (f.memory_contradiction_detection as boolean) ?? false,
		};
	}

	function buildLlmProfilePayload(p: LlmProfile): Record<string, unknown> {
		const out: Record<string, unknown> = { endpoint: p.endpoint, model: p.model };
		if (p.provider) out.provider = p.provider;
		if (p.apiKey) out.apiKey = p.apiKey;
		const t = optNum(p.temperature); if (t !== undefined) out.temperature = t;
		const mt = optInt(p.maxTokens); if (mt !== undefined) out.maxTokens = mt;
		const to = optInt(p.timeoutMs); if (to !== undefined) out.timeoutMs = to;
		const co = optInt(p.concurrency); if (co !== undefined) out.concurrency = co;
		const cl = optInt(p.contextLength); if (cl !== undefined) out.contextLength = cl;
		if (p.judgeModel) out.judgeModel = p.judgeModel;
		if (p.supportsJsonSchema) out.supportsJsonSchema = true;
		out.features = {
			memory_inference: p.memory_inference,
			memory_consolidation: p.memory_consolidation,
			feedback_distillation: p.feedback_distillation,
			graph_extraction: p.graph_extraction,
			curate_rerank: p.curate_rerank,
			lesson_quality_gate: p.lesson_quality_gate,
			proposal_quality_gate: p.proposal_quality_gate,
			metadata_enhance: p.metadata_enhance,
			memory_contradiction_detection: p.memory_contradiction_detection,
		};
		return out;
	}

	// ── Load ──────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const { config } = await fetchAkmConfig();
			const rawProfiles = config.profiles as Record<string, unknown> | undefined;

			// LLM Profiles
			const rawLlm = rawProfiles?.llm as Record<string, unknown> | undefined;
			llmProfiles = rawLlm
				? Object.entries(rawLlm).map(([name, p]) => ({ name, ...profileFromRaw(p as Record<string, unknown>) }))
				: [];

			// Agent Profiles
			const rawAgent = rawProfiles?.agent as Record<string, unknown> | undefined;
			agentProfiles = rawAgent
				? Object.entries(rawAgent).map(([name, p]) => {
					const raw = p as Record<string, unknown>;
					return {
						name,
						platform: (raw.platform as 'opencode' | 'claude' | 'opencode-sdk') ?? 'opencode',
						bin: (raw.bin as string) ?? '',
						args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '',
						workspace: (raw.workspace as string) ?? '',
						model: (raw.model as string) ?? '',
					};
				})
				: [];

			// Defaults
			const rawDefaults = config.defaults as Record<string, unknown> | undefined;
			defaultLlmProfile = (rawDefaults?.llm as string) ?? '';
			defaultAgentProfile = (rawDefaults?.agent as string) ?? '';
			const rawImproveDef = rawDefaults?.improve as Record<string, unknown> | undefined;
			improveLimit = typeof rawImproveDef?.limit === 'number' ? rawImproveDef.limit : 25;
			improvePreset = (rawImproveDef?.preset as 'fast' | 'thorough' | 'mixed' | 'custom') ?? 'custom';

			// v1 LLM
			const llm = config.llm as Record<string, unknown> | undefined;
			llmEndpoint = (llm?.endpoint as string) ?? '';
			llmModel = (llm?.model as string) ?? '';
			llmProvider = (llm?.provider as string) ?? '';
			llmApiKey = (llm?.apiKey as string) ?? '';
			llmTemperature = llm?.temperature != null ? String(llm.temperature) : '';
			llmMaxTokens = llm?.maxTokens != null ? String(llm.maxTokens) : '';
			llmTimeoutMs = llm?.timeoutMs != null ? String(llm.timeoutMs) : '';
			llmConcurrency = llm?.concurrency != null ? String(llm.concurrency) : '';
			llmContextLength = llm?.contextLength != null ? String(llm.contextLength) : '';
			llmJudgeModel = (llm?.judgeModel as string) ?? '';
			llmSupportsJsonSchema = (llm?.supportsJsonSchema as boolean) ?? false;

			const features = llm?.features as Record<string, unknown> | undefined;
			featMemoryInference = (features?.memory_inference as boolean) ?? true;
			featMemoryConsolidation = (features?.memory_consolidation as boolean) ?? true;
			featFeedbackDistillation = (features?.feedback_distillation as boolean) ?? true;
			featGraphExtraction = (features?.graph_extraction as boolean) ?? true;
			featCurateRerank = (features?.curate_rerank as boolean) ?? false;
			featLessonQualityGate = (features?.lesson_quality_gate as boolean) ?? false;
			featProposalQualityGate = (features?.proposal_quality_gate as boolean) ?? false;
			featMetadataEnhance = (features?.metadata_enhance as boolean) ?? false;
			featMemoryContradiction = (features?.memory_contradiction_detection as boolean) ?? false;

			// Embedding
			const emb = config.embedding as Record<string, unknown> | undefined;
			embEndpoint = (emb?.endpoint as string) ?? '';
			embModel = (emb?.model as string) ?? '';
			embProvider = (emb?.provider as string) ?? '';
			embApiKey = (emb?.apiKey as string) ?? '';
			embDimension = typeof emb?.dimension === 'number' ? emb.dimension : 1536;
			embLocalModel = (emb?.localModel as string) ?? '';
			embBatchSize = emb?.batchSize != null ? String(emb.batchSize) : '';
			embChunkSize = emb?.chunkSize != null ? String(emb.chunkSize) : '';
			embContextLength = emb?.contextLength != null ? String(emb.contextLength) : '';
			const ollamaOpts = emb?.ollamaOptions as Record<string, unknown> | undefined;
			embOllamaNumCtx = ollamaOpts?.num_ctx != null ? String(ollamaOpts.num_ctx) : '';

			// Behavior
			semanticSearchMode = (config.semanticSearchMode as 'auto' | 'off') ?? 'auto';
			archiveRetentionDays = typeof config.archiveRetentionDays === 'number' ? config.archiveRetentionDays : 90;
			stashInheritance = (config.stashInheritance as 'merge' | 'replace') ?? 'merge';
			stashDir = (config.stashDir as string) ?? '';
			defaultWriteTarget = (config.defaultWriteTarget as string) ?? '';
			const output = config.output as Record<string, unknown> | undefined;
			outputFormat = (output?.format as 'json' | 'yaml' | 'text') ?? 'json';
			outputDetail = (output?.detail as 'brief' | 'normal' | 'full') ?? 'brief';

			// Improve
			const rawImproveTop = config.improve as Record<string, unknown> | undefined;
			const decay = rawImproveTop?.utilityDecay as Record<string, unknown> | undefined;
			improveHalfLifeDays = typeof decay?.halfLifeDays === 'number' ? decay.halfLifeDays : 30;
			improveFeedbackBoost = typeof decay?.feedbackStabilityBoost === 'number' ? decay.feedbackStabilityBoost : 1.5;
			const cooldown = rawImproveTop?.reflectCooldownByType;
			improveReflectCooldown = cooldown ? JSON.stringify(cooldown, null, 2) : '';

			// Search
			const search = config.search as Record<string, unknown> | undefined;
			searchMinScore = typeof search?.minScore === 'number' ? search.minScore : 0.2;
			const gb = search?.graphBoost as Record<string, unknown> | undefined;
			if (gb) {
				graphDirectBoostPerEntity = typeof gb.directBoostPerEntity === 'number' ? gb.directBoostPerEntity : 0.25;
				graphDirectBoostCap = typeof gb.directBoostCap === 'number' ? gb.directBoostCap : 0.75;
				graphHopBoostPerEntity = typeof gb.hopBoostPerEntity === 'number' ? gb.hopBoostPerEntity : 0.1;
				graphHopBoostCap = typeof gb.hopBoostCap === 'number' ? gb.hopBoostCap : 0.3;
				graphMaxHops = typeof gb.maxHops === 'number' ? gb.maxHops : 1;
				graphConfidenceMode = (gb.confidenceMode as 'off' | 'blend' | 'multiply') ?? 'blend';
				graphConfidenceWeight = typeof gb.confidenceWeight === 'number' ? gb.confidenceWeight : 0.2;
			}

			// Feedback
			const feedback = config.feedback as Record<string, unknown> | undefined;
			feedbackRequireReason = (feedback?.requireReason as boolean) ?? true;
			const modes = feedback?.allowedFailureModes;
			if (Array.isArray(modes)) feedbackAllowedModes = (modes as string[]).join(', ');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load AKM config.';
		} finally {
			loading = false;
		}
	}

	// ── Save ──────────────────────────────────────────────────────────────────────
	async function save(): Promise<void> {
		saving = true;
		error = '';
		saved = false;
		try {
			const profilesLlm: Record<string, unknown> = {};
			for (const p of llmProfiles) {
				if (p.name.trim()) profilesLlm[p.name.trim()] = buildLlmProfilePayload(p);
			}

			const profilesAgent: Record<string, unknown> = {};
			for (const p of agentProfiles) {
				if (!p.name.trim()) continue;
				const entry: Record<string, unknown> = { platform: p.platform };
				if (p.bin) entry.bin = p.bin;
				if (p.args) entry.args = p.args.split(/\s+/).filter(Boolean);
				if (p.workspace) entry.workspace = p.workspace;
				if (p.model) entry.model = p.model;
				profilesAgent[p.name.trim()] = entry;
			}

			const llmPayload: Record<string, unknown> = {
				endpoint: llmEndpoint,
				model: llmModel,
				features: {
					memory_inference: featMemoryInference,
					memory_consolidation: featMemoryConsolidation,
					feedback_distillation: featFeedbackDistillation,
					graph_extraction: featGraphExtraction,
					curate_rerank: featCurateRerank,
					lesson_quality_gate: featLessonQualityGate,
					proposal_quality_gate: featProposalQualityGate,
					metadata_enhance: featMetadataEnhance,
					memory_contradiction_detection: featMemoryContradiction,
				},
			};
			if (llmProvider) llmPayload.provider = llmProvider;
			if (llmApiKey) llmPayload.apiKey = llmApiKey;
			const t = optNum(llmTemperature); if (t !== undefined) llmPayload.temperature = t;
			const mt = optInt(llmMaxTokens); if (mt !== undefined) llmPayload.maxTokens = mt;
			const to = optInt(llmTimeoutMs); if (to !== undefined) llmPayload.timeoutMs = to;
			const co = optInt(llmConcurrency); if (co !== undefined) llmPayload.concurrency = co;
			const cl = optInt(llmContextLength); if (cl !== undefined) llmPayload.contextLength = cl;
			if (llmJudgeModel) llmPayload.judgeModel = llmJudgeModel;
			if (llmSupportsJsonSchema) llmPayload.supportsJsonSchema = true;

			const embPayload: Record<string, unknown> = { endpoint: embEndpoint, model: embModel, dimension: embDimension };
			if (embProvider) embPayload.provider = embProvider;
			if (embApiKey) embPayload.apiKey = embApiKey;
			if (embLocalModel) embPayload.localModel = embLocalModel;
			const bs = optInt(embBatchSize); if (bs !== undefined) embPayload.batchSize = bs;
			const cs = optInt(embChunkSize); if (cs !== undefined) embPayload.chunkSize = cs;
			const ecl = optInt(embContextLength); if (ecl !== undefined) embPayload.contextLength = ecl;
			const numCtx = optInt(embOllamaNumCtx); if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

			let reflectCooldown: Record<string, number> | undefined;
			if (improveReflectCooldown.trim()) {
				try { reflectCooldown = JSON.parse(improveReflectCooldown) as Record<string, number>; }
				catch { throw new Error('Reflect cooldown must be valid JSON (e.g. {"memory":2,"lesson":7})'); }
			}

			const defaultsPayload: Record<string, unknown> = { improve: { limit: improveLimit, preset: improvePreset } };
			if (defaultLlmProfile) defaultsPayload.llm = defaultLlmProfile;
			if (defaultAgentProfile) defaultsPayload.agent = defaultAgentProfile;

			await saveAkmConfig({
				profiles: { llm: profilesLlm, agent: profilesAgent },
				defaults: defaultsPayload,
				llm: llmPayload,
				embedding: embPayload,
				semanticSearchMode,
				archiveRetentionDays,
				stashInheritance,
				stashDir: stashDir.trim(),
				defaultWriteTarget: defaultWriteTarget.trim(),
				output: { format: outputFormat, detail: outputDetail },
				improve: {
					...(reflectCooldown !== undefined ? { reflectCooldownByType: reflectCooldown } : {}),
					utilityDecay: { halfLifeDays: improveHalfLifeDays, feedbackStabilityBoost: improveFeedbackBoost },
				},
				search: {
					minScore: searchMinScore,
					graphBoost: {
						directBoostPerEntity: graphDirectBoostPerEntity,
						directBoostCap: graphDirectBoostCap,
						hopBoostPerEntity: graphHopBoostPerEntity,
						hopBoostCap: graphHopBoostCap,
						maxHops: graphMaxHops,
						confidenceMode: graphConfidenceMode,
						confidenceWeight: graphConfidenceWeight,
					},
				},
				feedback: {
					requireReason: feedbackRequireReason,
					allowedFailureModes: feedbackAllowedModes.split(',').map((s: string) => s.trim()).filter(Boolean),
				},
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
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored}>
				{#if saving}<span class="spinner"></span>{/if}
				{saved ? 'Saved' : 'Save'}
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">

		<!-- ── LLM Profiles ─────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Profiles</h3>
			<div class="section-note">
				Named profiles for <code>profiles.llm</code>. Reference by name in features/agent configs.
			</div>

			{#if llmProfiles.length === 0}
				<p class="empty-note">No profiles defined. Using the default LLM connection below.</p>
			{/if}

			{#each llmProfiles as p, i (i)}
				<div class="profile-card">
					<div class="profile-card-header">
						<input class="control-input profile-name-input" type="text" placeholder="profile name" bind:value={p.name} disabled={loading || saving} />
						<button class="btn btn-sm" onclick={() => { expandedLlmIdx = expandedLlmIdx === i ? null : i; }} disabled={loading || saving}>
							{expandedLlmIdx === i ? 'Collapse' : 'Edit'}
						</button>
						<button class="btn btn-sm btn-danger" onclick={() => { llmProfiles = llmProfiles.filter((_, j) => j !== i); if (expandedLlmIdx === i) expandedLlmIdx = null; }} disabled={loading || saving}>
							Remove
						</button>
					</div>

					{#if expandedLlmIdx === i}
						<div class="profile-card-body">
							<div class="controls controls--grid">
								<div class="control-group control-group--wide">
									<label class="control-label">Endpoint</label>
									<input class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={p.endpoint} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Model</label>
									<input class="control-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" bind:value={p.model} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Provider (label)</label>
									<input class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={p.provider} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">API Key</label>
									<input class="control-input" type="text" spellcheck="false" placeholder={'${AKM_LLM_API_KEY}'} bind:value={p.apiKey} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Temperature (0–2)</label>
									<input class="control-input control-input--narrow" type="number" min="0" max="2" step="0.1" bind:value={p.temperature} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Max tokens</label>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={p.maxTokens} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Timeout (ms)</label>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={p.timeoutMs} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Concurrency</label>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={p.concurrency} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Context length</label>
									<input class="control-input control-input--narrow" type="number" min="1" bind:value={p.contextLength} disabled={loading || saving} />
								</div>
								<div class="control-group">
									<label class="control-label">Judge model</label>
									<input class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={p.judgeModel} disabled={loading || saving} />
								</div>
							</div>
							<label class="toggle-row">
								<input type="checkbox" bind:checked={p.supportsJsonSchema} disabled={loading || saving} />
								<span class="toggle-label">Supports JSON schema</span>
								<span class="toggle-hint">Use response_format: json_schema for structured output</span>
							</label>
							<div class="feature-grid">
								<label class="toggle-row"><input type="checkbox" bind:checked={p.memory_inference} disabled={loading || saving} /><span class="toggle-label">memory_inference</span><span class="toggle-hint">Infer new memories from sessions</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.memory_consolidation} disabled={loading || saving} /><span class="toggle-label">memory_consolidation</span><span class="toggle-hint">Merge and deduplicate memories</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.feedback_distillation} disabled={loading || saving} /><span class="toggle-label">feedback_distillation</span><span class="toggle-hint">Distill lessons from feedback</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.graph_extraction} disabled={loading || saving} /><span class="toggle-label">graph_extraction</span><span class="toggle-hint">Extract knowledge graph from assets</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.curate_rerank} disabled={loading || saving} /><span class="toggle-label">curate_rerank</span><span class="toggle-hint">LLM rerank for akm curate</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.lesson_quality_gate} disabled={loading || saving} /><span class="toggle-label">lesson_quality_gate</span><span class="toggle-hint">Quality gate for lessons</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.proposal_quality_gate} disabled={loading || saving} /><span class="toggle-label">proposal_quality_gate</span><span class="toggle-hint">Quality gate for proposals</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.metadata_enhance} disabled={loading || saving} /><span class="toggle-label">metadata_enhance</span><span class="toggle-hint">Enhance asset metadata during indexing</span></label>
								<label class="toggle-row"><input type="checkbox" bind:checked={p.memory_contradiction_detection} disabled={loading || saving} /><span class="toggle-label">memory_contradiction_detection</span><span class="toggle-hint">Detect contradictions between memories</span></label>
							</div>
						</div>
					{/if}
				</div>
			{/each}

			<button class="btn btn-secondary btn-sm" onclick={() => { llmProfiles = [...llmProfiles, newLlmProfile()]; expandedLlmIdx = llmProfiles.length - 1; }} disabled={loading || saving}>
				+ Add LLM Profile
			</button>

			{#if llmProfiles.length > 0}
				<div class="control-group" style="margin-top: var(--space-3)">
					<label class="control-label" for="defaultLlmProfile">Default LLM profile</label>
					<select id="defaultLlmProfile" class="control-input" bind:value={defaultLlmProfile} disabled={loading || saving}>
						<option value="">— none (use top-level llm connection) —</option>
						{#each llmProfiles as p}
							{#if p.name}<option value={p.name}>{p.name}</option>{/if}
						{/each}
					</select>
				</div>
			{/if}
		</section>

		<!-- ── Agent Profiles ───────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Agent Profiles</h3>
			<div class="section-note">Named profiles for <code>profiles.agent</code>. Used by features that run via opencode or claude CLI.</div>

			{#if agentProfiles.length === 0}
				<p class="empty-note">No agent profiles defined.</p>
			{/if}

			{#each agentProfiles as p, i (i)}
				<div class="profile-card">
					<div class="profile-card-header">
						<input class="control-input profile-name-input" type="text" placeholder="profile name" bind:value={p.name} disabled={loading || saving} />
						<span class="badge">{p.platform}</span>
						<button class="btn btn-sm" onclick={() => { expandedAgentIdx = expandedAgentIdx === i ? null : i; }} disabled={loading || saving}>
							{expandedAgentIdx === i ? 'Collapse' : 'Edit'}
						</button>
						<button class="btn btn-sm btn-danger" onclick={() => { agentProfiles = agentProfiles.filter((_, j) => j !== i); if (expandedAgentIdx === i) expandedAgentIdx = null; }} disabled={loading || saving}>
							Remove
						</button>
					</div>

					{#if expandedAgentIdx === i}
						<div class="profile-card-body">
							<div class="controls controls--grid">
								<div class="control-group">
									<label class="control-label">Platform</label>
									<select class="control-input" bind:value={p.platform} disabled={loading || saving}>
										<option value="opencode">opencode</option>
										<option value="claude">claude</option>
										<option value="opencode-sdk">opencode-sdk</option>
									</select>
								</div>
								{#if p.platform !== 'opencode-sdk'}
									<div class="control-group">
										<label class="control-label">Binary</label>
										<input class="control-input" type="text" spellcheck="false" placeholder="opencode" bind:value={p.bin} disabled={loading || saving} />
									</div>
									<div class="control-group control-group--wide">
										<label class="control-label">Extra args (space-separated)</label>
										<input class="control-input" type="text" spellcheck="false" placeholder="run --model gpt-4o" bind:value={p.args} disabled={loading || saving} />
									</div>
								{:else}
									<div class="control-group">
										<label class="control-label">Model</label>
										<input class="control-input" type="text" spellcheck="false" placeholder="anthropic/claude-sonnet-4-5" bind:value={p.model} disabled={loading || saving} />
									</div>
									<div class="control-group">
										<label class="control-label">Workspace</label>
										<input class="control-input" type="text" spellcheck="false" placeholder={'${PWD}'} bind:value={p.workspace} disabled={loading || saving} />
									</div>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}

			<button class="btn btn-secondary btn-sm" onclick={() => { agentProfiles = [...agentProfiles, newAgentProfile()]; expandedAgentIdx = agentProfiles.length - 1; }} disabled={loading || saving}>
				+ Add Agent Profile
			</button>

			{#if agentProfiles.length > 0}
				<div class="control-group" style="margin-top: var(--space-3)">
					<label class="control-label" for="defaultAgentProfile">Default agent profile</label>
					<select id="defaultAgentProfile" class="control-input" bind:value={defaultAgentProfile} disabled={loading || saving}>
						<option value="">— none —</option>
						{#each agentProfiles as p}
							{#if p.name}<option value={p.name}>{p.name}</option>{/if}
						{/each}
					</select>
				</div>
			{/if}
		</section>

		<!-- ── LLM Connection (v1 compat) ───────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Connection</h3>
			<div class="section-note">Top-level <code>llm</code> connection — v1 compat, used by the assistant container and as the default when no profile is set.</div>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="llmEndpoint">Endpoint</label>
					<input id="llmEndpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={llmEndpoint} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmModel">Model</label>
					<input id="llmModel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={llmModel} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmProvider">Provider (label)</label>
					<input id="llmProvider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={llmProvider} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmApiKey">API Key</label>
					<input id="llmApiKey" class="control-input" type="text" spellcheck="false" placeholder={'${AKM_LLM_API_KEY}'} bind:value={llmApiKey} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmTemperature">Temperature (0–2)</label>
					<input id="llmTemperature" class="control-input control-input--narrow" type="number" min="0" max="2" step="0.1" bind:value={llmTemperature} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmMaxTokens">Max tokens</label>
					<input id="llmMaxTokens" class="control-input control-input--narrow" type="number" min="1" bind:value={llmMaxTokens} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmTimeoutMs">Timeout (ms)</label>
					<input id="llmTimeoutMs" class="control-input control-input--narrow" type="number" min="1" bind:value={llmTimeoutMs} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmConcurrency">Concurrency</label>
					<input id="llmConcurrency" class="control-input control-input--narrow" type="number" min="1" bind:value={llmConcurrency} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmContextLength">Context length</label>
					<input id="llmContextLength" class="control-input control-input--narrow" type="number" min="1" bind:value={llmContextLength} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="llmJudgeModel">Judge model</label>
					<input id="llmJudgeModel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={llmJudgeModel} disabled={loading || saving} />
				</div>
			</div>
			<label class="toggle-row">
				<input type="checkbox" bind:checked={llmSupportsJsonSchema} disabled={loading || saving} />
				<span class="toggle-label">Supports JSON schema</span>
				<span class="toggle-hint">Use response_format: json_schema for structured output</span>
			</label>
		</section>

		<!-- ── LLM Feature Flags ─────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Feature Flags</h3>
			<div class="section-note">Controls which pipeline passes are active via the top-level LLM connection.</div>
			<div class="feature-grid">
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featMemoryInference} disabled={loading || saving} />
					<span class="toggle-label">Memory inference</span>
					<span class="toggle-hint">Infer new memories from assistant sessions</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featMemoryConsolidation} disabled={loading || saving} />
					<span class="toggle-label">Memory consolidation</span>
					<span class="toggle-hint">Merge and deduplicate overlapping memories</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featFeedbackDistillation} disabled={loading || saving} />
					<span class="toggle-label">Feedback distillation</span>
					<span class="toggle-hint">Distill durable lessons from feedback during improve runs</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featGraphExtraction} disabled={loading || saving} />
					<span class="toggle-label">Graph extraction</span>
					<span class="toggle-hint">Extract knowledge graph from assets during indexing</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featCurateRerank} disabled={loading || saving} />
					<span class="toggle-label">Curate rerank</span>
					<span class="toggle-hint">LLM-rerank results during akm curate</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featLessonQualityGate} disabled={loading || saving} />
					<span class="toggle-label">Lesson quality gate</span>
					<span class="toggle-hint">Quality gate for proposed lessons before they go live</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featProposalQualityGate} disabled={loading || saving} />
					<span class="toggle-label">Proposal quality gate</span>
					<span class="toggle-hint">Quality gate for stash improvement proposals</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featMetadataEnhance} disabled={loading || saving} />
					<span class="toggle-label">Metadata enhance</span>
					<span class="toggle-hint">Enhance asset metadata during indexing</span>
				</label>
				<label class="toggle-row">
					<input type="checkbox" bind:checked={featMemoryContradiction} disabled={loading || saving} />
					<span class="toggle-label">Memory contradiction detection</span>
					<span class="toggle-hint">Detect contradictions between memories</span>
				</label>
			</div>
		</section>

		<!-- ── Embedding Connection ──────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Embedding Connection</h3>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="embEndpoint">Endpoint</label>
					<input id="embEndpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/embeddings" bind:value={embEndpoint} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embModel">Model</label>
					<input id="embModel" class="control-input" type="text" spellcheck="false" placeholder="text-embedding-3-small" bind:value={embModel} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embProvider">Provider (label)</label>
					<input id="embProvider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={embProvider} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embApiKey">API Key</label>
					<input id="embApiKey" class="control-input" type="text" spellcheck="false" placeholder={'${AKM_EMBED_API_KEY}'} bind:value={embApiKey} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embDimension">Dimensions</label>
					<input id="embDimension" class="control-input control-input--narrow" type="number" min="1" bind:value={embDimension} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embLocalModel">Local model</label>
					<input id="embLocalModel" class="control-input" type="text" spellcheck="false" placeholder="Xenova/bge-small-en-v1.5" bind:value={embLocalModel} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embBatchSize">Batch size</label>
					<input id="embBatchSize" class="control-input control-input--narrow" type="number" min="1" bind:value={embBatchSize} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embChunkSize">Chunk size (chars)</label>
					<input id="embChunkSize" class="control-input control-input--narrow" type="number" min="1" bind:value={embChunkSize} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embContextLength">Context length</label>
					<input id="embContextLength" class="control-input control-input--narrow" type="number" min="1" bind:value={embContextLength} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="embOllamaNumCtx">Ollama num_ctx</label>
					<input id="embOllamaNumCtx" class="control-input control-input--narrow" type="number" min="1" bind:value={embOllamaNumCtx} disabled={loading || saving} />
				</div>
			</div>
		</section>

		<!-- ── Behavior ──────────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Behavior</h3>
			<div class="controls controls--grid">
				<div class="control-group">
					<label class="control-label" for="semanticSearch">Semantic search</label>
					<select id="semanticSearch" class="control-input" bind:value={semanticSearchMode} disabled={loading || saving}>
						<option value="auto">Auto (vector index when available)</option>
						<option value="off">Off (keyword only)</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="stashInheritance">Stash inheritance</label>
					<select id="stashInheritance" class="control-input" bind:value={stashInheritance} disabled={loading || saving}>
						<option value="merge">Merge (project appends to global)</option>
						<option value="replace">Replace (project replaces global)</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="archiveRetention">Archive retention (days)</label>
					<input id="archiveRetention" class="control-input control-input--narrow" type="number" min="0" max="365" bind:value={archiveRetentionDays} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="outputFormat">Output format</label>
					<select id="outputFormat" class="control-input" bind:value={outputFormat} disabled={loading || saving}>
						<option value="json">JSON</option>
						<option value="yaml">YAML</option>
						<option value="text">Text</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="outputDetail">Output detail</label>
					<select id="outputDetail" class="control-input" bind:value={outputDetail} disabled={loading || saving}>
						<option value="brief">Brief</option>
						<option value="normal">Normal</option>
						<option value="full">Full</option>
					</select>
				</div>
				<div class="control-group control-group--wide">
					<label class="control-label" for="stashDir">Stash directory</label>
					<input id="stashDir" class="control-input" type="text" spellcheck="false" placeholder="~/.akm (default)" bind:value={stashDir} disabled={loading || saving} />
				</div>
				<div class="control-group control-group--wide">
					<label class="control-label" for="defaultWriteTarget">Default write target</label>
					<input id="defaultWriteTarget" class="control-input" type="text" spellcheck="false" placeholder="source name for akm remember / akm import" bind:value={defaultWriteTarget} disabled={loading || saving} />
				</div>
			</div>
		</section>

		<!-- ── Improve Defaults ──────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Improve</h3>
			<div class="controls controls--grid">
				<div class="control-group">
					<label class="control-label" for="improvePreset">Preset</label>
					<select id="improvePreset" class="control-input" bind:value={improvePreset} disabled={loading || saving}>
						<option value="fast">Fast</option>
						<option value="thorough">Thorough</option>
						<option value="mixed">Mixed</option>
						<option value="custom">Custom</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="improveLimit">Asset limit per run</label>
					<input id="improveLimit" class="control-input control-input--narrow" type="number" min="1" max="100" bind:value={improveLimit} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="improveHalfLife">Utility decay half-life (days)</label>
					<input id="improveHalfLife" class="control-input control-input--narrow" type="number" min="0.1" step="0.5" bind:value={improveHalfLifeDays} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="improveFeedbackBoost">Feedback stability boost</label>
					<input id="improveFeedbackBoost" class="control-input control-input--narrow" type="number" min="1" step="0.1" bind:value={improveFeedbackBoost} disabled={loading || saving} />
				</div>
				<div class="control-group control-group--wide">
					<label class="control-label" for="reflectCooldown">Reflect cooldown by type (JSON)</label>
					<textarea id="reflectCooldown" class="control-input control-textarea" spellcheck="false" placeholder={'{"memory": 2, "lesson": 7, "knowledge": 30}'} bind:value={improveReflectCooldown} disabled={loading || saving}></textarea>
				</div>
			</div>
		</section>

		<!-- ── Search Tuning ────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Search Tuning</h3>
			<div class="controls controls--grid">
				<div class="control-group">
					<label class="control-label" for="minScore">Min score (0–1)</label>
					<input id="minScore" class="control-input control-input--narrow" type="number" min="0" max="1" step="0.01" bind:value={searchMinScore} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="directBoostPerEntity">Direct boost / entity</label>
					<input id="directBoostPerEntity" class="control-input control-input--narrow" type="number" step="0.05" bind:value={graphDirectBoostPerEntity} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="directBoostCap">Direct boost cap</label>
					<input id="directBoostCap" class="control-input control-input--narrow" type="number" step="0.05" bind:value={graphDirectBoostCap} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="hopBoostPerEntity">Hop boost / entity</label>
					<input id="hopBoostPerEntity" class="control-input control-input--narrow" type="number" step="0.05" bind:value={graphHopBoostPerEntity} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="hopBoostCap">Hop boost cap</label>
					<input id="hopBoostCap" class="control-input control-input--narrow" type="number" step="0.05" bind:value={graphHopBoostCap} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="maxHops">Max hops (1–3)</label>
					<input id="maxHops" class="control-input control-input--narrow" type="number" min="1" max="3" bind:value={graphMaxHops} disabled={loading || saving} />
				</div>
				<div class="control-group">
					<label class="control-label" for="confidenceMode">Confidence mode</label>
					<select id="confidenceMode" class="control-input" bind:value={graphConfidenceMode} disabled={loading || saving}>
						<option value="off">Off</option>
						<option value="blend">Blend</option>
						<option value="multiply">Multiply</option>
					</select>
				</div>
				<div class="control-group">
					<label class="control-label" for="confidenceWeight">Confidence weight (0–1)</label>
					<input id="confidenceWeight" class="control-input control-input--narrow" type="number" min="0" max="1" step="0.05" bind:value={graphConfidenceWeight} disabled={loading || saving} />
				</div>
			</div>
		</section>

		<!-- ── Feedback ──────────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Feedback</h3>
			<div class="controls controls--grid">
				<div class="control-group control-group--wide">
					<label class="control-label" for="allowedModes">Allowed failure modes (comma-separated)</label>
					<input id="allowedModes" class="control-input" type="text" spellcheck="false" placeholder="incorrect, outdated, dangerous, incomplete, redundant" bind:value={feedbackAllowedModes} disabled={loading || saving} />
				</div>
			</div>
			<label class="toggle-row">
				<input type="checkbox" bind:checked={feedbackRequireReason} disabled={loading || saving} />
				<span class="toggle-label">Require reason for negative feedback</span>
				<span class="toggle-hint">When enabled, akm feedback --negative without --reason throws an error</span>
			</label>
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
	.panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.panel-header-actions { display: flex; gap: var(--space-2); }

	.panel-body { display: flex; flex-direction: column; gap: var(--space-8); }

	.config-section { display: flex; flex-direction: column; gap: var(--space-4); }

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

	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; margin: 0; }

	.controls { display: flex; flex-direction: column; gap: var(--space-4); }
	.controls--grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: var(--space-4);
	}
	.control-group { display: flex; flex-direction: column; gap: var(--space-1); }
	.control-group--wide { grid-column: 1 / -1; }
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
	.control-input--narrow { max-width: 8rem; }
	.control-textarea { min-height: 5rem; font-family: var(--font-mono); resize: vertical; }
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	.feature-grid { display: flex; flex-direction: column; gap: var(--space-2); }

	.toggle-row { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; font-size: var(--text-sm); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-hint { color: var(--color-text-secondary); font-size: var(--text-xs); }

	.profile-card {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.profile-card-header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--color-bg-secondary);
	}
	.profile-name-input { flex: 1; min-width: 8rem; }
	.profile-card-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); border-top: 1px solid var(--color-border); }

	.badge {
		font-size: var(--text-xs);
		padding: 2px var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary, var(--color-bg-secondary));
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		white-space: nowrap;
	}

	.btn-danger { color: var(--color-error, #dc2626); }
	.btn-danger:hover { background: var(--color-error-bg, rgba(220, 38, 38, 0.08)); }

	.error-banner {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
		color: var(--color-error, #dc2626);
		margin-bottom: var(--space-4);
	}

	.spinner {
		display: inline-block; width: 0.75rem; height: 0.75rem;
		border: 2px solid transparent; border-top-color: currentColor;
		border-radius: 50%; animation: spin 0.6s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
