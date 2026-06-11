<script lang="ts">
	import { onMount } from 'svelte';
 import {
		fetchAkmConfig,
		detectAkmEmbedding,
		reindexAkm,
		saveAkmConfig,
		testAkmEmbedding,
	} from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import AkmKnowledgeStatsSection from '$lib/components/akm/AkmKnowledgeStatsSection.svelte';
	import EmbeddingSection from '$lib/components/akm/EmbeddingSection.svelte';
	import BehaviorSection from '$lib/components/akm/BehaviorSection.svelte';
	import AkmHealthReportSection from '$lib/components/akm/AkmHealthReportSection.svelte';
	import LlmProfilesSection from '$lib/components/akm/LlmProfilesSection.svelte';
	import AgentProfilesSection from '$lib/components/akm/AgentProfilesSection.svelte';
	import ImproveProfilesSection from '$lib/components/akm/ImproveProfilesSection.svelte';
	import LlmProfileDrawer from '$lib/components/akm/LlmProfileDrawer.svelte';
	import AgentProfileDrawer from '$lib/components/akm/AgentProfileDrawer.svelte';
	import ImproveProfileDrawer from '$lib/components/akm/ImproveProfileDrawer.svelte';
	import {
		PROCESS_KEYS,
		DEFAULT_ENABLED,
		optNum,
		optInt,
		emptyFEntry,
		readFEntry,
		buildProcessConfig,
		triFromEnabled,
		type Tri,
		type FEntry,
		type ProcKey,
	} from '$lib/components/akm/improve-process-helpers';
	import type { LlmProfile, AgentProfile, ImproveProfile } from '$lib/components/akm/profile-types';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	// ── Status ───────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let detectingEmbedding = $state(false);
	let testingEmbedding = $state(false);
	let reindexing = $state(false);
	let error = $state('');

	// Host AKM sharing now lives in its own Knowledge sub-tab
	// (akm/HostSharingSection.svelte) — moved out of this megaform.

	// ── LLM Profiles ─────────────────────────────────────────────────────────────
	let llmProfiles = $state<LlmProfile[]>([]);
	let defaultLlmProfile = $state('');

	// ── Agent Profiles ────────────────────────────────────────────────────────────
	let agentProfiles = $state<AgentProfile[]>([]);
	let defaultAgentProfile = $state('');

	// ── Improve Profiles ──────────────────────────────────────────────────────────
	let improveProfiles = $state<ImproveProfile[]>([]);
	let defaultImproveProfile = $state('');

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

	// ── Behavior ─────────────────────────────────────────────────────────────────
	let semanticSearchMode = $state<'auto' | 'off'>('auto');
	let outputFormat = $state<'json' | 'yaml' | 'text'>('json');
	let outputDetail = $state<'brief' | 'normal' | 'full'>('brief');

	// ── Advanced: top-level improve / search / feedback / index ────────────────────
	let imHalfLife = $state('');            // improve.utilityDecay.halfLifeDays
	let imFeedbackBoost = $state('');       // improve.utilityDecay.feedbackStabilityBoost
	let imEventRetention = $state('');      // improve.eventRetentionDays
	let searchMinScore = $state('');        // search.minScore
	let searchCurateRerank = $state<Tri>(''); // search.curateRerank.enabled
	let fbRequireReason = $state<Tri>('');   // feedback.requireReason
	let fbFailureModes = $state('');        // feedback.allowedFailureModes (comma-separated)
	let indexJson = $state('');             // index (raw JSON — complex per-pass schema)

	// ── Knowledge subtab ─────────────────────────────────────────────────────────
	// Two sections: AI Services (model/agent/improve connections + embedding) and
	// Behavior. Host Sharing moved to its own Knowledge sub-tab.
	let knowledgeSection = $state<'ai-services' | 'behavior' | 'health-report'>('ai-services');

	// ── Drawer ────────────────────────────────────────────────────────────────────
	type DrawerType = 'llm' | 'agent' | 'improve' | null;
	let drawerType = $state<DrawerType>(null);
	let drawerLlm = $state<LlmProfile | null>(null);
	let drawerAgent = $state<AgentProfile | null>(null);
	let drawerImprove = $state<ImproveProfile | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmProfileNames = $derived(llmProfiles.map(p => p.name).filter(n => n));

	// ── Helpers ──────────────────────────────────────────────────────────────────
	function newLlmProfile(): LlmProfile {
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', showApiKey: false, temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', judgeModel: '', supportsJsonSchema: false, enableThinking: false, structuredOutput: false, extraParams: '' };
	}
	function newAgentProfile(): AgentProfile {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}
	function newImproveProfile(): ImproveProfile {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) processes[k] = emptyFEntry(DEFAULT_ENABLED[k]);
		return {
			id: crypto.randomUUID(), name: '', description: '', limit: 25, autoAccept: 0,
			processes, syncEnabled: '', syncPush: '', syncMessage: '',
		};
	}

	function profileFromRaw(raw: Record<string, unknown>): Omit<LlmProfile, 'name' | 'id'> {
		return {
			endpoint: (raw.endpoint as string) ?? '',
			model: (raw.model as string) ?? '',
			provider: (raw.provider as string) ?? '',
			apiKey: (raw.apiKey as string) ?? '',
			showApiKey: false,
			temperature: raw.temperature != null ? String(raw.temperature) : '',
			maxTokens: raw.maxTokens != null ? String(raw.maxTokens) : '',
			timeoutMs: raw.timeoutMs != null ? String(raw.timeoutMs) : '',
			concurrency: raw.concurrency != null ? String(raw.concurrency) : '',
			contextLength: raw.contextLength != null ? String(raw.contextLength) : '',
			judgeModel: (raw.judgeModel as string) ?? '',
			supportsJsonSchema: (raw.supportsJsonSchema as boolean) ?? false,
			enableThinking: (raw.enableThinking as boolean) ?? false,
			structuredOutput: ((raw.capabilities as Record<string, unknown> | undefined)?.structuredOutput as boolean) ?? false,
			extraParams: raw.extraParams && typeof raw.extraParams === 'object' ? JSON.stringify(raw.extraParams, null, 2) : '',
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
		if (p.enableThinking) out.enableThinking = true;
		if (p.structuredOutput) out.capabilities = { structuredOutput: true };
		if (p.extraParams.trim()) {
			// Parse the JSON object; throw a friendly error so save() surfaces it
			// rather than sending malformed data the schema would reject.
			let parsed: unknown;
			try { parsed = JSON.parse(p.extraParams); }
			catch { throw new Error(`LLM profile "${p.name}": extraParams must be valid JSON`); }
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
				throw new Error(`LLM profile "${p.name}": extraParams must be a JSON object`);
			out.extraParams = parsed;
		}
		return out;
	}

	function improveProfileFromRaw(name: string, raw: Record<string, unknown>): ImproveProfile {
		const procs = (raw.processes as Record<string, unknown> | undefined) ?? {};
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) processes[k] = readFEntry(procs[k], DEFAULT_ENABLED[k]);
		const sync = raw.sync as Record<string, unknown> | undefined;
		return {
			id: crypto.randomUUID(), name,
			description: (raw.description as string) ?? '',
			limit: typeof raw.limit === 'number' ? raw.limit : 25,
			autoAccept: typeof raw.autoAccept === 'number' ? raw.autoAccept : 0,
			processes,
			syncEnabled: triFromEnabled(sync ? { enabled: sync.enabled } : undefined),
			syncPush: triFromEnabled(sync ? { enabled: sync.push } : undefined),
			syncMessage: (sync?.message as string) ?? '',
		};
	}

	// ── Drawer actions ────────────────────────────────────────────────────────────
	function openLlmDrawer(p: LlmProfile) {
		drawerLlm = { ...p };
		drawerType = 'llm';
	}
	function openAgentDrawer(p: AgentProfile) {
		drawerAgent = { ...p };
		drawerType = 'agent';
	}
	function openImproveDrawer(ip: ImproveProfile) {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) {
			const src = ip.processes[k];
			processes[k] = { ...src, judgment: { ...src.judgment }, rest: { ...src.rest } };
		}
		drawerImprove = { ...ip, processes };
		drawerType = 'improve';
	}

	function applyDrawer() {
		if (drawerType === 'llm' && drawerLlm) {
			const copy = { ...drawerLlm };
			const idx = llmProfiles.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? llmProfiles[idx].name : '';
			llmProfiles = idx >= 0
				? llmProfiles.map((p, i) => i === idx ? copy : p)
				: [...llmProfiles, copy];
			if (defaultLlmProfile === oldName) defaultLlmProfile = copy.name;
		} else if (drawerType === 'agent' && drawerAgent) {
			const copy = { ...drawerAgent };
			const idx = agentProfiles.findIndex(p => p.id === copy.id);
			const oldName = idx >= 0 ? agentProfiles[idx].name : '';
			agentProfiles = idx >= 0
				? agentProfiles.map((p, i) => i === idx ? copy : p)
				: [...agentProfiles, copy];
			if (defaultAgentProfile === oldName) defaultAgentProfile = copy.name;
		} else if (drawerType === 'improve' && drawerImprove) {
			const copy = { ...drawerImprove, processes: { ...drawerImprove.processes } };
			const idx = improveProfiles.findIndex(ip => ip.id === copy.id);
			const oldName = idx >= 0 ? improveProfiles[idx].name : '';
			improveProfiles = idx >= 0
				? improveProfiles.map((ip, i) => i === idx ? copy : ip)
				: [...improveProfiles, copy];
			if (defaultImproveProfile === oldName) defaultImproveProfile = copy.name;
		}
		closeDrawer();
	}

	function closeDrawer() {
		drawerType = null;
		drawerLlm = null;
		drawerAgent = null;
		drawerImprove = null;
	}

	function removeProfile(type: 'llm' | 'agent' | 'improve', id: string) {
		if (type === 'llm') {
			const name = llmProfiles.find(p => p.id === id)?.name ?? '';
			if (defaultLlmProfile === name) defaultLlmProfile = '';
			llmProfiles = llmProfiles.filter(p => p.id !== id);
		} else if (type === 'agent') {
			const name = agentProfiles.find(p => p.id === id)?.name ?? '';
			if (defaultAgentProfile === name) defaultAgentProfile = '';
			agentProfiles = agentProfiles.filter(p => p.id !== id);
		} else {
			const name = improveProfiles.find(ip => ip.id === id)?.name ?? '';
			if (defaultImproveProfile === name) defaultImproveProfile = '';
			improveProfiles = improveProfiles.filter(ip => ip.id !== id);
		}
		if (drawerType === type) closeDrawer();
	}

	// ── Load ─────────────────────────────────────────────────────────────────────
	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const { config } = await fetchAkmConfig();
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

			const rawImpProfiles = rawProfiles?.improve as Record<string, unknown> | undefined;
			improveProfiles = rawImpProfiles
				? Object.entries(rawImpProfiles).map(([name, p]) => improveProfileFromRaw(name, p as Record<string, unknown>))
				: [];

			const rawDefaults = config.defaults as Record<string, unknown> | undefined;
			defaultLlmProfile = (rawDefaults?.llm as string) ?? '';
			defaultAgentProfile = (rawDefaults?.agent as string) ?? '';
			defaultImproveProfile = (rawDefaults?.improve as string) ?? '';

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

			semanticSearchMode = (config.semanticSearchMode as 'auto' | 'off') ?? 'auto';
			const output = config.output as Record<string, unknown> | undefined;
			outputFormat = (output?.format as 'json' | 'yaml' | 'text') ?? 'json';
			outputDetail = (output?.detail as 'brief' | 'normal' | 'full') ?? 'brief';

			const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
			const triE = (o: unknown): Tri => (o && typeof o === 'object' && 'enabled' in (o as Record<string, unknown>) ? ((o as Record<string, unknown>).enabled ? 'on' : 'off') : '');
			const improveTop = config.improve as Record<string, unknown> | undefined;
			const decay = improveTop?.utilityDecay as Record<string, unknown> | undefined;
			imHalfLife = num(decay?.halfLifeDays);
			imFeedbackBoost = num(decay?.feedbackStabilityBoost);
			imEventRetention = num(improveTop?.eventRetentionDays);
			const search = config.search as Record<string, unknown> | undefined;
			searchMinScore = num(search?.minScore);
			searchCurateRerank = triE(search?.curateRerank);
			const feedback = config.feedback as Record<string, unknown> | undefined;
			fbRequireReason = typeof feedback?.requireReason === 'boolean' ? (feedback.requireReason ? 'on' : 'off') : '';
			fbFailureModes = Array.isArray(feedback?.allowedFailureModes) ? (feedback!.allowedFailureModes as string[]).join(', ') : '';
			indexJson = config.index && typeof config.index === 'object' ? JSON.stringify(config.index, null, 2) : '';
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

			const profilesImprove: Record<string, unknown> = {};
			for (const ip of improveProfiles) {
				if (!ip.name.trim()) continue;
				const processes: Record<string, unknown> = {};
				for (const k of PROCESS_KEYS) processes[k] = buildProcessConfig(ip.processes[k]);
				const entry: Record<string, unknown> = { limit: ip.limit, processes };
				if (ip.description) entry.description = ip.description;
				if (ip.autoAccept > 0) entry.autoAccept = ip.autoAccept;
				// profile-level git sync (akm sync block) — emit only configured fields
				const sync: Record<string, unknown> = {};
				if (ip.syncEnabled) sync.enabled = ip.syncEnabled === 'on';
				if (ip.syncPush) sync.push = ip.syncPush === 'on';
				if (ip.syncMessage.trim()) sync.message = ip.syncMessage.trim();
				if (Object.keys(sync).length) entry.sync = sync;
				profilesImprove[ip.name.trim()] = entry;
			}

			const embPayload: Record<string, unknown> = { endpoint: embEndpoint, model: embModel, dimension: embDimension };
			if (embProvider) embPayload.provider = embProvider;
			if (embApiKey) embPayload.apiKey = embApiKey;
			if (embLocalModel) embPayload.localModel = embLocalModel;
			const bs = optInt(embBatchSize); if (bs !== undefined) embPayload.batchSize = bs;
			const cs = optInt(embChunkSize); if (cs !== undefined) embPayload.chunkSize = cs;
			const ecl = optInt(embContextLength); if (ecl !== undefined) embPayload.contextLength = ecl;
			const numCtx = optInt(embOllamaNumCtx); if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

			const defaultsPayload: Record<string, unknown> = {};
			if (defaultLlmProfile) defaultsPayload.llm = defaultLlmProfile;
			if (defaultAgentProfile) defaultsPayload.agent = defaultAgentProfile;
			if (defaultImproveProfile) defaultsPayload.improve = defaultImproveProfile;

			// Advanced: top-level improve / search / feedback / index (emit only configured fields)
			const improveTopPayload: Record<string, unknown> = {};
			const decayPayload: Record<string, unknown> = {};
			const hl = optNum(imHalfLife); if (hl !== undefined) decayPayload.halfLifeDays = hl;
			const fb = optNum(imFeedbackBoost); if (fb !== undefined) decayPayload.feedbackStabilityBoost = fb;
			if (Object.keys(decayPayload).length) improveTopPayload.utilityDecay = decayPayload;
			const er = optNum(imEventRetention); if (er !== undefined) improveTopPayload.eventRetentionDays = er;

			const searchPayload: Record<string, unknown> = {};
			const ms = optNum(searchMinScore); if (ms !== undefined) searchPayload.minScore = ms;
			if (searchCurateRerank) searchPayload.curateRerank = { enabled: searchCurateRerank === 'on' };

			const feedbackPayload: Record<string, unknown> = {};
			if (fbRequireReason) feedbackPayload.requireReason = fbRequireReason === 'on';
			const modes = fbFailureModes.split(',').map((s) => s.trim()).filter(Boolean);
			if (modes.length) feedbackPayload.allowedFailureModes = modes;

			let indexPayload: unknown;
			if (indexJson.trim()) {
				let parsed: unknown;
				try { parsed = JSON.parse(indexJson); }
				catch { throw new Error('Index config must be valid JSON'); }
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
					throw new Error('Index config must be a JSON object keyed by pass name');
				indexPayload = parsed;
			}

			await saveAkmConfig({
				profiles: { llm: profilesLlm, agent: profilesAgent, improve: profilesImprove },
				defaults: defaultsPayload,
				embedding: embPayload,
				semanticSearchMode,
				output: { format: outputFormat, detail: outputDetail },
				...(Object.keys(improveTopPayload).length ? { improve: improveTopPayload } : {}),
				...(Object.keys(searchPayload).length ? { search: searchPayload } : {}),
				...(Object.keys(feedbackPayload).length ? { feedback: feedbackPayload } : {}),
				...(indexPayload !== undefined ? { index: indexPayload } : {}),
			});
			notifications.push('success', 'AKM config saved.');
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to save AKM config.';
			notifications.push('error', msg);
		} finally {
			saving = false;
		}
	}

	async function detectEmbedding(): Promise<void> {
		detectingEmbedding = true;
		error = '';
		try {
			const detected = await detectAkmEmbedding();
			embEndpoint = detected.endpoint;
			embModel = detected.model;
			embProvider = detected.provider;
			embDimension = detected.dimension;
			notifications.push('success', detected.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to detect embedding settings.';
			notifications.push('error', msg);
		}
		finally {
			detectingEmbedding = false;
		}
	}

	async function testEmbedding(): Promise<void> {
		testingEmbedding = true;
		error = '';
		try {
			let endpoint = embEndpoint.trim();
			let model = embModel.trim();
			let provider = embProvider.trim();

			if (!endpoint || !model) {
				const detected = await detectAkmEmbedding();
				endpoint = detected.endpoint;
				model = detected.model;
				provider = detected.provider;
				embEndpoint = detected.endpoint;
				embModel = detected.model;
				embProvider = detected.provider;
				embDimension = detected.dimension;
			}

			const result = await testAkmEmbedding({
				endpoint,
				model,
				provider,
				apiKey: embApiKey,
				dimension: embDimension,
			});
			embDimension = result.dimension;
			notifications.push('success', result.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to test embedding settings.';
			notifications.push('error', msg);
		}
		finally {
			testingEmbedding = false;
		}
	}

	async function reindexKnowledge(): Promise<void> {
		reindexing = true;
		try {
			const result = await reindexAkm();
			notifications.push('success', result.message);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to rebuild the AKM index.';
			notifications.push('error', msg);
		} finally {
			reindexing = false;
		}
	}

	onMount(() => { if (tokenStored) { void load(); } });
</script>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>Knowledge</h2>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing || !tokenStored}>
				{#if loading}<Spinner />{/if}
				Refresh
			</button>
			<button class="btn btn-secondary btn-sm" onclick={() => void reindexKnowledge()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing || !tokenStored}>
				{#if reindexing}<Spinner />{/if}
				Re-index
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing || !tokenStored}>
				{#if saving}<Spinner />{/if}
				Save
			</button>
		</div>
	</div>

	{#if error}<div class="error-banner"><span>{error}</span></div>{/if}

	<div class="panel-body">

		<!-- ── Knowledge subtab strip ────────────────────────────────────── -->
		<div class="k-tabs" role="tablist" aria-label="Knowledge sections">
			<button
				role="tab"
				class="k-tab"
				class:k-tab--active={knowledgeSection === 'ai-services'}
				aria-selected={knowledgeSection === 'ai-services'}
				onclick={() => { knowledgeSection = 'ai-services'; }}
			>AI Services</button>
			<button
				role="tab"
				class="k-tab"
				class:k-tab--active={knowledgeSection === 'behavior'}
				aria-selected={knowledgeSection === 'behavior'}
				onclick={() => { knowledgeSection = 'behavior'; }}
			>Behavior</button>
			<button
				role="tab"
				class="k-tab"
				class:k-tab--active={knowledgeSection === 'health-report'}
				aria-selected={knowledgeSection === 'health-report'}
				onclick={() => { knowledgeSection = 'health-report'; }}
			>Health Report</button>
		</div>

		<!-- ── AI Services group (model/agent/improve connections + embedding) ── -->
		{#if knowledgeSection === 'ai-services'}
		<AkmKnowledgeStatsSection disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing || !tokenStored} />

		<p class="section-note section-note--lead">The AI services your assistant uses to build and search its memory — the language models that organize memories, the embedding provider for semantic search, and the maintenance pipeline.</p>

		<!-- ── LLM Profiles ──────────────────────────────────────────────── -->
		<LlmProfilesSection
			bind:profiles={llmProfiles}
			bind:defaultName={defaultLlmProfile}
			disabled={loading || saving}
			onedit={(p) => openLlmDrawer(p)}
			onadd={() => { drawerLlm = newLlmProfile(); drawerType = 'llm'; }}
			onremove={(id) => removeProfile('llm', id)}
		/>

		<!-- ── Agent Profiles ────────────────────────────────────────────── -->
		<AgentProfilesSection
			bind:profiles={agentProfiles}
			bind:defaultName={defaultAgentProfile}
			disabled={loading || saving}
			onedit={(p) => openAgentDrawer(p)}
			onadd={() => { drawerAgent = newAgentProfile(); drawerType = 'agent'; }}
			onremove={(id) => removeProfile('agent', id)}
		/>

		<!-- ── Improve Profiles ───────────────────────────────────────────── -->
		<ImproveProfilesSection
			bind:profiles={improveProfiles}
			bind:defaultName={defaultImproveProfile}
			disabled={loading || saving}
			onedit={(ip) => openImproveDrawer(ip)}
			onadd={() => { drawerImprove = newImproveProfile(); drawerType = 'improve'; }}
			onremove={(id) => removeProfile('improve', id)}
		/>

		<!-- ── Embedding (semantic search) — part of AI Services ─────────────── -->
		<EmbeddingSection
			bind:endpoint={embEndpoint}
			bind:model={embModel}
			bind:provider={embProvider}
			bind:apiKey={embApiKey}
			bind:dimension={embDimension}
			bind:localModel={embLocalModel}
			bind:batchSize={embBatchSize}
			bind:chunkSize={embChunkSize}
			bind:contextLength={embContextLength}
			bind:ollamaNumCtx={embOllamaNumCtx}
			detecting={detectingEmbedding}
			testing={testingEmbedding}
			ondetect={() => void detectEmbedding()}
			ontest={() => void testEmbedding()}
			disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing}
		/>

		{/if}<!-- end AI Services group -->

		<!-- ── Behavior group ────────────────────────────────────────────── -->
		{#if knowledgeSection === 'behavior'}

		<!-- ── Behavior + advanced tuning ────────────────────────────────── -->
		<BehaviorSection
			bind:semanticSearchMode
			bind:outputFormat
			bind:outputDetail
			bind:imHalfLife
			bind:imFeedbackBoost
			bind:imEventRetention
			bind:searchMinScore
			bind:searchCurateRerank
			bind:fbRequireReason
			bind:fbFailureModes
			bind:indexJson
			disabled={loading || saving}
		/>

		{/if}<!-- end behavior group -->

		{#if knowledgeSection === 'health-report'}
		<AkmHealthReportSection disabled={loading || saving || detectingEmbedding || testingEmbedding || reindexing || !tokenStored} />
		{/if}

	</div>

	<!-- ── Slide-in Drawer ───────────────────────────────────────────────────── -->
	{#if drawerType === 'llm' && drawerLlm}
		<LlmProfileDrawer bind:draft={drawerLlm} oncancel={closeDrawer} onapply={applyDrawer} />
	{:else if drawerType === 'agent' && drawerAgent}
		<AgentProfileDrawer bind:draft={drawerAgent} oncancel={closeDrawer} onapply={applyDrawer} />
	{:else if drawerType === 'improve' && drawerImprove}
		<ImproveProfileDrawer bind:draft={drawerImprove} llmProfileNames={llmProfileNames} oncancel={closeDrawer} onapply={applyDrawer} />
	{/if}

</div>

<style>
	/* ── Knowledge subtab strip ─────────────────────────────────────────────── */
	.k-tabs {
		display: flex;
		/* Single row: grow to fill evenly when there's room (desktop), scroll
		   horizontally when there isn't (320px) — never wrap into an asymmetric
		   grid that orphans the last item. */
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
		gap: var(--space-1);
		padding: var(--space-1);
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		margin-bottom: var(--space-2);
	}
	.k-tabs::-webkit-scrollbar { display: none; }
	.k-tab {
		flex: 1 0 auto;
		min-height: 2.75rem; /* 44px target */
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--font-normal, 400);
		color: var(--color-text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition: background 150ms, color 150ms;
	}
	.k-tab:hover {
		background: var(--color-surface-hover, rgba(0, 0, 0, 0.05));
		color: var(--color-text);
	}
	.k-tab:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}
	.k-tab--active {
		background: var(--color-bg);
		border-color: var(--color-border);
		color: var(--color-text);
		font-weight: var(--font-semibold);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}
	@media (max-width: 400px) {
		.k-tab { font-size: var(--text-xs); padding: var(--space-2); }
	}

	.panel-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-6);
		position: sticky; top: 0; z-index: 10;
		background: var(--color-bg);
		padding-top: var(--space-2);
		padding-bottom: var(--space-4);
		border-bottom: 1px solid var(--color-border);
	}
	.panel-header h2 { font-size: var(--text-lg); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.panel-header-actions { display: flex; gap: var(--space-2); }

	.panel-body { display: flex; flex-direction: column; gap: var(--space-8); }

	.section-note--lead {
		font-size: var(--text-sm); color: var(--color-text-secondary);
		max-width: 72ch; margin: 0 0 var(--space-4);
	}
	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }

	/* Error banner */
	.error-banner {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-error-bg, rgba(220, 38, 38, 0.08));
		border: 1px solid var(--color-error-border, rgba(220, 38, 38, 0.25));
		border-radius: var(--radius-md); font-size: var(--text-sm);
		color: var(--color-error, #dc2626); margin-bottom: var(--space-4);
	}
</style>
