<script lang="ts">
	import { onMount } from 'svelte';
	import { fetchAkmConfig, saveAkmConfig } from '$lib/api.js';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	// ── Status ───────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let saved = $state(false);

	// ── Profile types ────────────────────────────────────────────────────────────
	interface LlmProfile {
		id: string;
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
	}

	interface AgentProfile {
		id: string;
		name: string;
		platform: 'opencode' | 'claude' | 'opencode-sdk';
		bin: string;
		args: string;
		workspace: string;
		model: string;
	}

	type FMode = '' | 'llm' | 'agent' | 'sdk';
	interface FEntry { enabled: boolean; mode: FMode; profile: string; timeoutMs: string; }

	// ── Default LLM Connection ───────────────────────────────────────────────────
	let defaultLlmEndpoint = $state('');
	let defaultLlmModel = $state('');
	let defaultLlmProvider = $state('');
	let defaultLlmApiKey = $state('');

	// ── LLM Profiles ─────────────────────────────────────────────────────────────
	let llmProfiles = $state<LlmProfile[]>([]);
	let defaultLlmProfile = $state('');
	let expandedLlmId = $state<string | null>(null);

	// ── Agent Profiles ────────────────────────────────────────────────────────────
	let agentProfiles = $state<AgentProfile[]>([]);
	let defaultAgentProfile = $state('');
	let expandedAgentId = $state<string | null>(null);

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

	// ── Features — Improve ───────────────────────────────────────────────────────
	let featImproveReflect = $state<FEntry>({ enabled: true, mode: '', profile: '', timeoutMs: '' });
	let featImproveDistill = $state<FEntry>({ enabled: true, mode: '', profile: '', timeoutMs: '' });
	let featImproveMemConsolidation = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });
	let featImproveFeedbackDistillation = $state<FEntry>({ enabled: true, mode: '', profile: '', timeoutMs: '' });
	let featImproveValidation = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });
	let featImprovePropose = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });

	// ── Features — Index ─────────────────────────────────────────────────────────
	let featIndexMemInference = $state<FEntry>({ enabled: true, mode: '', profile: '', timeoutMs: '' });
	let featIndexGraphExtraction = $state<FEntry>({ enabled: true, mode: '', profile: '', timeoutMs: '' });
	let featIndexMetadataEnhance = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });
	let featIndexStalenessDetection = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });

	// ── Features — Search ────────────────────────────────────────────────────────
	let featSearchCurateRerank = $state<FEntry>({ enabled: false, mode: '', profile: '', timeoutMs: '' });

	// ── Behavior ─────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let archiveRetentionDays = $state(90);
	let stashInheritance = $state<'merge' | 'replace'>('merge');
	let stashDir = $state('');
	let defaultWriteTarget = $state('');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let outputDetail = $state<'brief' | 'normal' | 'full'>('brief');

	// ── Improve defaults ─────────────────────────────────────────────────────────
	let improveLimit = $state(25);
	let improvePreset = $state<'fast' | 'thorough' | 'mixed' | 'custom'>('custom');
	let improveHalfLifeDays = $state(30);
	let improveFeedbackBoost = $state(1.5);

	// ── Reflect cooldowns (days per asset type; empty = use akm default) ─────────
	const COOLDOWN_TYPES = ['memory','lesson','workflow','skill','agent','command','knowledge','script','wiki','task'] as const;
	const COOLDOWN_DEFAULTS: Record<string, number> = { memory: 2, lesson: 7, workflow: 30, skill: 30, agent: 30, command: 30, knowledge: 30, script: 30, wiki: 30, task: 60 };
	let reflectCooldowns = $state<Record<string, string>>(Object.fromEntries(COOLDOWN_TYPES.map(t => [t, ''])));

	// ── Search ───────────────────────────────────────────────────────────────────
	let searchMinScore = $state(0.2);
	let graphDirectBoostPerEntity = $state(0.25);
	let graphDirectBoostCap = $state(0.75);
	let graphHopBoostPerEntity = $state(0.1);
	let graphHopBoostCap = $state(0.3);
	let graphMaxHops = $state(1);
	let graphConfidenceMode = $state<'off' | 'blend' | 'multiply'>('blend');
	let graphConfidenceWeight = $state(0.2);

	// ── Feedback ─────────────────────────────────────────────────────────────────
	let feedbackRequireReason = $state(true);
	let feedbackAllowedModes = $state('incorrect, outdated, dangerous, incomplete, redundant');

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmProfileNames = $derived(llmProfiles.map(p => p.name).filter(n => n));
	let agentProfileNames = $derived(agentProfiles.map(p => p.name).filter(n => n));

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function optNum(s: string | number): number | undefined {
		if (typeof s === 'number') return isNaN(s) ? undefined : s;
		const n = parseFloat(s);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}
	function optInt(s: string | number): number | undefined {
		if (typeof s === 'number') return isNaN(s) ? undefined : Math.trunc(s);
		const n = parseInt(s, 10);
		return s.trim() === '' || isNaN(n) ? undefined : n;
	}

	function newLlmProfile(): LlmProfile {
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', judgeModel: '', supportsJsonSchema: false };
	}
	function newAgentProfile(): AgentProfile {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}

	function readFEntry(raw: unknown, defaultEnabled: boolean): FEntry {
		if (typeof raw === 'boolean') return { enabled: raw, mode: '', profile: '', timeoutMs: '' };
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { enabled: defaultEnabled, mode: '', profile: '', timeoutMs: '' };
		const r = raw as Record<string, unknown>;
		return {
			enabled: typeof r.enabled === 'boolean' ? r.enabled : defaultEnabled,
			mode: (r.mode as FMode) ?? '',
			profile: (r.profile as string) ?? '',
			timeoutMs: r.timeoutMs != null ? String(r.timeoutMs) : '',
		};
	}

	function buildFEntry(e: FEntry): boolean | Record<string, unknown> {
		if (!e.mode && !e.profile && !e.timeoutMs) return e.enabled;
		const out: Record<string, unknown> = { enabled: e.enabled };
		if (e.mode) out.mode = e.mode;
		if (e.profile) out.profile = e.profile;
		if (e.timeoutMs !== '') out.timeoutMs = parseInt(e.timeoutMs, 10);
		return out;
	}

	function profileFromRaw(raw: Record<string, unknown>): Omit<LlmProfile, 'name' | 'id'> {
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
		return out;
	}

	// ── Load ─────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const { config } = await fetchAkmConfig();

			// Default LLM connection
			const rawDefaultLlm = config.llm as Record<string, unknown> | undefined;
			defaultLlmEndpoint = (rawDefaultLlm?.endpoint as string) ?? '';
			defaultLlmModel = (rawDefaultLlm?.model as string) ?? '';
			defaultLlmProvider = (rawDefaultLlm?.provider as string) ?? '';
			defaultLlmApiKey = (rawDefaultLlm?.apiKey as string) ?? '';

			const rawProfiles = config.profiles as Record<string, unknown> | undefined;

			const rawLlm = rawProfiles?.llm as Record<string, unknown> | undefined;
			llmProfiles = rawLlm
				? Object.entries(rawLlm).map(([name, p]) => ({ id: crypto.randomUUID(), name, ...profileFromRaw(p as Record<string, unknown>) }))
				: [];

			const rawAgent = rawProfiles?.agent as Record<string, unknown> | undefined;
			agentProfiles = rawAgent
				? Object.entries(rawAgent).map(([name, p]) => {
					const raw = p as Record<string, unknown>;
					return { id: crypto.randomUUID(), name, platform: (raw.platform as 'opencode' | 'claude' | 'opencode-sdk') ?? 'opencode', bin: (raw.bin as string) ?? '', args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '', workspace: (raw.workspace as string) ?? '', model: (raw.model as string) ?? '' };
				})
				: [];

			const rawDefaults = config.defaults as Record<string, unknown> | undefined;
			defaultLlmProfile = (rawDefaults?.llm as string) ?? '';
			defaultAgentProfile = (rawDefaults?.agent as string) ?? '';
			const rawImproveDef = rawDefaults?.improve as Record<string, unknown> | undefined;
			improveLimit = typeof rawImproveDef?.limit === 'number' ? rawImproveDef.limit : 25;
			improvePreset = (rawImproveDef?.preset as 'fast' | 'thorough' | 'mixed' | 'custom') ?? 'custom';

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

			// Features
			const rawFeatures = config.features as Record<string, unknown> | undefined;
			const rawFI = rawFeatures?.improve as Record<string, unknown> | undefined;
			featImproveReflect = readFEntry(rawFI?.reflect, true);
			featImproveDistill = readFEntry(rawFI?.distill, true);
			featImproveMemConsolidation = readFEntry(rawFI?.memory_consolidation, false);
			featImproveFeedbackDistillation = readFEntry(rawFI?.feedback_distillation, true);
			featImproveValidation = readFEntry(rawFI?.validation, false);
			featImprovePropose = readFEntry(rawFI?.propose, false);

			const rawFIdx = rawFeatures?.index as Record<string, unknown> | undefined;
			featIndexMemInference = readFEntry(rawFIdx?.memory_inference, true);
			featIndexGraphExtraction = readFEntry(rawFIdx?.graph_extraction, true);
			featIndexMetadataEnhance = readFEntry(rawFIdx?.metadata_enhance, false);
			featIndexStalenessDetection = readFEntry(rawFIdx?.staleness_detection, false);

			const rawFS = rawFeatures?.search as Record<string, unknown> | undefined;
			featSearchCurateRerank = readFEntry(rawFS?.curate_rerank, false);

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
			const rawCooldown = rawImproveTop?.reflectCooldownByType as Record<string, number> | undefined;
			for (const t of COOLDOWN_TYPES) {
				reflectCooldowns[t] = rawCooldown?.[t] != null ? String(rawCooldown[t]) : '';
			}

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

	// ── Save ─────────────────────────────────────────────────────────────────────
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

			const embPayload: Record<string, unknown> = { endpoint: embEndpoint, model: embModel, dimension: embDimension };
			if (embProvider) embPayload.provider = embProvider;
			if (embApiKey) embPayload.apiKey = embApiKey;
			if (embLocalModel) embPayload.localModel = embLocalModel;
			const bs = optInt(embBatchSize); if (bs !== undefined) embPayload.batchSize = bs;
			const cs = optInt(embChunkSize); if (cs !== undefined) embPayload.chunkSize = cs;
			const ecl = optInt(embContextLength); if (ecl !== undefined) embPayload.contextLength = ecl;
			const numCtx = optInt(embOllamaNumCtx); if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

			const defaultsPayload: Record<string, unknown> = { improve: { limit: improveLimit, preset: improvePreset } };
			if (defaultLlmProfile) defaultsPayload.llm = defaultLlmProfile;
			if (defaultAgentProfile) defaultsPayload.agent = defaultAgentProfile;

			const cooldownResult: Record<string, number> = {};
			for (const t of COOLDOWN_TYPES) {
				const v = optInt(reflectCooldowns[t]);
				if (v !== undefined) cooldownResult[t] = v;
			}

			const llmPayload: Record<string, unknown> = {};
			if (defaultLlmEndpoint) llmPayload.endpoint = defaultLlmEndpoint;
			if (defaultLlmModel) llmPayload.model = defaultLlmModel;
			if (defaultLlmProvider) llmPayload.provider = defaultLlmProvider;
			llmPayload.apiKey = defaultLlmApiKey; // allow clearing

			await saveAkmConfig({
				...(Object.keys(llmPayload).length > 0 ? { llm: llmPayload } : {}),
				profiles: { llm: profilesLlm, agent: profilesAgent },
				defaults: defaultsPayload,
				embedding: embPayload,
				features: {
					improve: {
						reflect: buildFEntry(featImproveReflect),
						distill: buildFEntry(featImproveDistill),
						memory_consolidation: buildFEntry(featImproveMemConsolidation),
						feedback_distillation: buildFEntry(featImproveFeedbackDistillation),
						validation: buildFEntry(featImproveValidation),
						propose: buildFEntry(featImprovePropose),
					},
					index: {
						memory_inference: buildFEntry(featIndexMemInference),
						graph_extraction: buildFEntry(featIndexGraphExtraction),
						metadata_enhance: buildFEntry(featIndexMetadataEnhance),
						staleness_detection: buildFEntry(featIndexStalenessDetection),
					},
					search: {
						curate_rerank: buildFEntry(featSearchCurateRerank),
					},
				},
				semanticSearchMode,
				archiveRetentionDays,
				stashInheritance,
				stashDir: stashDir.trim(),
				defaultWriteTarget: defaultWriteTarget.trim(),
				output: { format: outputFormat, detail: outputDetail },
				improve: {
					...(Object.keys(cooldownResult).length > 0 ? { reflectCooldownByType: cooldownResult } : {}),
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

	{#snippet featRow(feat: FEntry, name: string, hint: string)}
		<div class="feature-row">
			<input type="checkbox" bind:checked={feat.enabled} disabled={loading || saving} />
			<div><span class="feat-name">{name}</span><span class="feat-hint">{hint}</span></div>
			<select class="control-input" bind:value={feat.mode} disabled={loading || saving}>
				<option value="">default</option>
				<option value="llm">llm</option>
				<option value="agent">agent</option>
				<option value="sdk">sdk</option>
			</select>
			<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" placeholder="— default profile —" bind:value={feat.profile} disabled={loading || saving} />
			<input class="control-input control-input--narrow" type="number" min="1" placeholder="unlimited" bind:value={feat.timeoutMs} disabled={loading || saving} />
		</div>
	{/snippet}

	<div class="panel-body">

		<!-- ── Default LLM ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Default LLM</h3>
			<p class="section-note">Primary LLM connection used by akm operations. Override per-operation using LLM Profiles below.</p>
			<div class="control-grid">
				<label class="control-label" for="defaultLlmEndpoint">Endpoint</label>
				<input id="defaultLlmEndpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={defaultLlmEndpoint} disabled={loading || saving} />
				<label class="control-label" for="defaultLlmModel">Model</label>
				<input id="defaultLlmModel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={defaultLlmModel} disabled={loading || saving} />
				<label class="control-label" for="defaultLlmProvider">Provider</label>
				<input id="defaultLlmProvider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={defaultLlmProvider} disabled={loading || saving} />
				<label class="control-label" for="defaultLlmApiKey">API Key</label>
				<input id="defaultLlmApiKey" class="control-input" type="text" spellcheck="false" placeholder={'${AKM_LLM_API_KEY}'} bind:value={defaultLlmApiKey} disabled={loading || saving} />
			</div>
		</section>

		<!-- ── LLM Profiles ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">LLM Profiles</h3>
			<p class="section-note">Named profiles for <code>profiles.llm</code>. Each profile is a full LLM connection configuration referenceable by name in feature operations.</p>

			{#if llmProfiles.length === 0}
				<p class="empty-note">No profiles defined.</p>
			{/if}

			{#each llmProfiles as p (p.id)}
				<div class="profile-card">
					<div class="profile-card-header">
						<input class="control-input profile-name-input" type="text" placeholder="profile name" bind:value={p.name} disabled={loading || saving} />
						<button class="btn btn-sm" onclick={() => { expandedLlmId = expandedLlmId === p.id ? null : p.id; }} disabled={loading || saving}>
							{expandedLlmId === p.id ? 'Collapse' : 'Edit'}
						</button>
						<button class="btn btn-sm btn-danger" onclick={() => { if (defaultLlmProfile === p.name) defaultLlmProfile = ''; if (expandedLlmId === p.id) expandedLlmId = null; llmProfiles = llmProfiles.filter(x => x.id !== p.id); }} disabled={loading || saving}>
							Remove
						</button>
					</div>

					{#if expandedLlmId === p.id}
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
						</div>
					{/if}
				</div>
			{/each}

			<button class="btn btn-secondary btn-sm" onclick={() => { const p = newLlmProfile(); llmProfiles = [...llmProfiles, p]; expandedLlmId = p.id; }} disabled={loading || saving}>
				+ Add LLM Profile
			</button>

			{#if llmProfiles.length > 0}
				<div class="control-group" style="margin-top: var(--space-3)">
					<label class="control-label" for="defaultLlmProfile">Default LLM profile</label>
					<select id="defaultLlmProfile" class="control-input" bind:value={defaultLlmProfile} disabled={loading || saving}>
						<option value="">— none —</option>
						{#each llmProfiles as p}
							{#if p.name}<option value={p.name}>{p.name}</option>{/if}
						{/each}
					</select>
				</div>
			{/if}
		</section>

		<!-- ── Agent Profiles ────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Agent Profiles</h3>
			<p class="section-note">Named profiles for <code>profiles.agent</code>. Used by feature operations that run via opencode or claude CLI.</p>

			{#if agentProfiles.length === 0}
				<p class="empty-note">No agent profiles defined.</p>
			{/if}

			{#each agentProfiles as p (p.id)}
				<div class="profile-card">
					<div class="profile-card-header">
						<input class="control-input profile-name-input" type="text" placeholder="profile name" bind:value={p.name} disabled={loading || saving} />
						<span class="badge">{p.platform}</span>
						<button class="btn btn-sm" onclick={() => { expandedAgentId = expandedAgentId === p.id ? null : p.id; }} disabled={loading || saving}>
							{expandedAgentId === p.id ? 'Collapse' : 'Edit'}
						</button>
						<button class="btn btn-sm btn-danger" onclick={() => { if (defaultAgentProfile === p.name) defaultAgentProfile = ''; if (expandedAgentId === p.id) expandedAgentId = null; agentProfiles = agentProfiles.filter(x => x.id !== p.id); }} disabled={loading || saving}>
							Remove
						</button>
					</div>

					{#if expandedAgentId === p.id}
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

			<button class="btn btn-secondary btn-sm" onclick={() => { const p = newAgentProfile(); agentProfiles = [...agentProfiles, p]; expandedAgentId = p.id; }} disabled={loading || saving}>
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

		<!-- ── Features ─────────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Features — Improve</h3>
			<p class="section-note">Controls which operations run during <code>akm improve</code>. Profile references the LLM or agent profile to use; leave blank to inherit the default.</p>
			<div class="feature-table">
				<div class="feature-table-head">
					<span></span><span>Operation</span><span>Mode</span><span>Profile</span><span>Timeout (ms)</span>
				</div>
				{@render featRow(featImproveReflect, 'reflect', 'Propose stash updates via self-reflection')}
				{@render featRow(featImproveDistill, 'distill', 'Quality-judge and distill feedback into reusable knowledge')}
				{@render featRow(featImproveMemConsolidation, 'memory_consolidation', 'Deduplicate and merge overlapping memories')}
				{@render featRow(featImproveFeedbackDistillation, 'feedback_distillation', 'Extract durable lessons from collected feedback')}
				{@render featRow(featImproveValidation, 'validation', 'Third-model confidence and staleness scoring')}
				{@render featRow(featImprovePropose, 'propose', 'Author new stash assets (requires tool-capable agent mode)')}
			</div>
		</section>

		<section class="config-section">
			<h3 class="section-title">Features — Index</h3>
			<p class="section-note">Controls which operations run during <code>akm index</code>.</p>
			<div class="feature-table">
				<div class="feature-table-head">
					<span></span><span>Operation</span><span>Mode</span><span>Profile</span><span>Timeout (ms)</span>
				</div>
				{@render featRow(featIndexMemInference, 'memory_inference', 'Derive structured memories from pending memory files')}
				{@render featRow(featIndexGraphExtraction, 'graph_extraction', 'Extract entities and relations for graph-boosted search')}
				{@render featRow(featIndexMetadataEnhance, 'metadata_enhance', 'LLM-driven description and tag enrichment')}
				{@render featRow(featIndexStalenessDetection, 'staleness_detection', 'Detect and mark deprecated or superseded memories')}
			</div>
		</section>

		<section class="config-section">
			<h3 class="section-title">Features — Search</h3>
			<p class="section-note">Controls which operations run during <code>akm search</code> / <code>akm curate</code>.</p>
			<div class="feature-table">
				<div class="feature-table-head">
					<span></span><span>Operation</span><span>Mode</span><span>Profile</span><span>Timeout (ms)</span>
				</div>
				<div class="feature-row">
					<input type="checkbox" bind:checked={featSearchCurateRerank.enabled} disabled={loading || saving} />
					<div>
						<span class="feat-name">curate_rerank</span>
						<span class="feat-hint">LLM reranking during akm curate to improve result relevance</span>
					</div>
					<select class="control-input" bind:value={featSearchCurateRerank.mode} disabled={loading || saving}>
						<option value="">default</option>
						<option value="llm">llm</option>
						<option value="agent">agent</option>
						<option value="sdk">sdk</option>
					</select>
					<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" placeholder="— default profile —" bind:value={featSearchCurateRerank.profile} disabled={loading || saving} />
					<input class="control-input control-input--narrow" type="number" min="1" placeholder="unlimited" bind:value={featSearchCurateRerank.timeoutMs} disabled={loading || saving} />
				</div>
			</div>
		</section>

		<!-- Profile name datalist for feature profile inputs -->
		<datalist id="llm-profiles-list">
			{#each llmProfileNames as name}<option value={name}></option>{/each}
		</datalist>
		<datalist id="agent-profiles-list">
			{#each agentProfileNames as name}<option value={name}></option>{/each}
		</datalist>

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

		<!-- ── Improve ───────────────────────────────────────────────────── -->
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
			</div>
			<h4 class="subsection-title">Reflect cooldown by asset type (days; blank = use akm default)</h4>
			<div class="cooldown-grid">
				{#each COOLDOWN_TYPES as type}
					<div class="control-group">
						<label class="control-label" for="cd-{type}">{type} <span class="default-hint">(default: {COOLDOWN_DEFAULTS[type]})</span></label>
						<input id="cd-{type}" class="control-input control-input--narrow" type="number" min="0" placeholder={String(COOLDOWN_DEFAULTS[type])} bind:value={reflectCooldowns[type]} disabled={loading || saving} />
					</div>
				{/each}
			</div>
		</section>

		<!-- ── Search Tuning ─────────────────────────────────────────────── -->
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
	.panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-6); }
	.panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.panel-header-actions { display: flex; gap: var(--space-2); }

	.panel-body { display: flex; flex-direction: column; gap: var(--space-8); }

	.config-section { display: flex; flex-direction: column; gap: var(--space-4); }

	.section-title {
		font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text);
		text-transform: uppercase; letter-spacing: 0.05em; margin: 0;
		padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border);
	}
	.subsection-title {
		font-size: var(--text-xs); font-weight: var(--font-semibold); color: var(--color-text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin: var(--space-2) 0 0;
	}

	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; margin: 0; }

	.controls { display: flex; flex-direction: column; gap: var(--space-4); }
	.controls--grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--space-4); }

	.control-group { display: flex; flex-direction: column; gap: var(--space-1); }
	.control-group--wide { grid-column: 1 / -1; }
	.control-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }

	.control-input {
		font-size: var(--text-sm); color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border);
		border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%;
	}
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Feature table */
	.feature-table { display: flex; flex-direction: column; gap: var(--space-1); }
	.feature-table-head {
		display: grid;
		grid-template-columns: 1.5rem 1fr 7rem 12rem 8rem;
		gap: var(--space-2);
		padding: 0 var(--space-2) var(--space-1);
		font-size: var(--text-xs); font-weight: var(--font-semibold);
		color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em;
	}
	.feature-row {
		display: grid;
		grid-template-columns: 1.5rem 1fr 7rem 12rem 8rem;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
	}
	.feature-row input[type="checkbox"] { width: 1rem; height: 1rem; }
	.feat-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); font-family: var(--font-mono); display: block; }
	.feat-hint { font-size: var(--text-xs); color: var(--color-text-secondary); }

	/* Cooldown grid */
	.cooldown-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--space-3);
	}
	.default-hint { font-weight: var(--font-normal); color: var(--color-text-secondary); text-transform: none; letter-spacing: 0; }

	/* Profile cards */
	.profile-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
	.profile-card-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--color-bg-secondary); }
	.profile-name-input { flex: 1; min-width: 8rem; }
	.profile-card-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); border-top: 1px solid var(--color-border); }

	.badge { font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-sm); background: var(--color-bg-tertiary, var(--color-bg-secondary)); color: var(--color-text-secondary); border: 1px solid var(--color-border); white-space: nowrap; }
	.btn-danger { color: var(--color-error, #dc2626); }
	.btn-danger:hover { background: var(--color-error-bg, rgba(220, 38, 38, 0.08)); }

	.toggle-row { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; font-size: var(--text-sm); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-hint { color: var(--color-text-secondary); font-size: var(--text-xs); }

	.error-banner {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md); font-size: var(--text-sm);
		color: var(--color-error, #dc2626); margin-bottom: var(--space-4);
	}
	.spinner { display: inline-block; width: 0.75rem; height: 0.75rem; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
