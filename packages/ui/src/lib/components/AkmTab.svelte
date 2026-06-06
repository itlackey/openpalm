<script lang="ts">
	import { onMount } from 'svelte';
	import {
		fetchAkmConfig,
		saveAkmConfig,
	} from '$lib/api.js';
	import { notifications } from '$lib/notifications.svelte.js';
	import PasswordInput from '$lib/components/PasswordInput.svelte';
	import EmbeddingSection from '$lib/components/akm/EmbeddingSection.svelte';
	import BehaviorSection from '$lib/components/akm/BehaviorSection.svelte';

	interface Props { tokenStored: boolean; }
	let { tokenStored }: Props = $props();

	// ── Status ───────────────────────────────────────────────────────────────────
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');

	// Host AKM sharing now lives in its own Knowledge sub-tab
	// (akm/HostSharingSection.svelte) — moved out of this megaform.

	// ── Profile types ────────────────────────────────────────────────────────────
	interface LlmProfile {
		id: string;
		name: string;
		endpoint: string;
		model: string;
		provider: string;
		apiKey: string;
		showApiKey: boolean;
		temperature: string;
		maxTokens: string;
		timeoutMs: string;
		concurrency: string;
		contextLength: string;
		judgeModel: string;
		supportsJsonSchema: boolean;
		enableThinking: boolean;
		structuredOutput: boolean;   // capabilities.structuredOutput
		extraParams: string;         // JSON text; '' = unset
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
	type Tri = '' | 'on' | 'off'; // unset / enabled / disabled (for {enabled?} sub-objects)
	interface Judgment { mode: FMode; profile: string; timeoutMs: string; }
	interface FEntry {
		enabled: boolean; mode: FMode; profile: string; timeoutMs: string;
		// advanced (akm ImproveProcessConfigSchema) — all optional
		allowedTypes: string;          // comma-separated
		qualityGate: Tri;              // reflect/distill
		contradictionDetection: Tri;   // consolidate
		defaultSince: string; maxTotalChars: string; maxChunkSize: string; // extract
		applyMode: '' | 'queue' | 'promote'; policy: string; maxAcceptsPerRun: string; maxDiffLines: string; rejectEmpty: boolean; // triage
		judgment: Judgment;            // triage
		rest: Record<string, unknown>; // forward-compat: preserve any field we don't model
	}
	// Process keys per akm ImproveProfileProcessesSchema (0.8.0). Each maps to which
	// advanced fields are meaningful, so the drawer only shows relevant controls.
	const PROCESS_KEYS = ['reflect','distill','consolidate','validation','memoryInference','graphExtraction','extract','triage'] as const;
	type ProcKey = typeof PROCESS_KEYS[number];
	const PROCESS_HINTS: Record<ProcKey, string> = {
		reflect: 'Propose stash updates via self-reflection',
		distill: 'Quality-judge and distill feedback',
		consolidate: 'Deduplicate and merge overlapping memories',
		validation: 'Third-model confidence and staleness scoring',
		memoryInference: 'Derive structured memories from pending files',
		graphExtraction: 'Extract entities and relations for graph search',
		extract: 'Read session logs and queue insight proposals',
		triage: 'Auto-review and accept/promote queued proposals',
	};

	interface ImproveProfile {
		id: string;
		name: string;
		description: string;
		limit: number;
		autoAccept: number;
		processes: Record<ProcKey, FEntry>;
		// profile-level git sync (akm ImproveProfileConfigSchema.sync)
		syncEnabled: Tri;
		syncPush: Tri;
		syncMessage: string;
	}

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
	let knowledgeSection = $state<'ai-services' | 'behavior'>('ai-services');

	// ── Drawer ────────────────────────────────────────────────────────────────────
	type DrawerType = 'llm' | 'agent' | 'improve' | null;
	let drawerType = $state<DrawerType>(null);
	let drawerLlm = $state<LlmProfile | null>(null);
	let drawerAgent = $state<AgentProfile | null>(null);
	let drawerImprove = $state<ImproveProfile | null>(null);

	// ── Derived ──────────────────────────────────────────────────────────────────
	let llmProfileNames = $derived(llmProfiles.map(p => p.name).filter(n => n));

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
		return { id: crypto.randomUUID(), name: '', endpoint: '', model: '', provider: '', apiKey: '', showApiKey: false, temperature: '', maxTokens: '', timeoutMs: '', concurrency: '', contextLength: '', judgeModel: '', supportsJsonSchema: false, enableThinking: false, structuredOutput: false, extraParams: '' };
	}
	function newAgentProfile(): AgentProfile {
		return { id: crypto.randomUUID(), name: '', platform: 'opencode', bin: '', args: '', workspace: '', model: '' };
	}
	const DEFAULT_ENABLED: Record<ProcKey, boolean> = {
		reflect: true, distill: true, consolidate: false, validation: false,
		memoryInference: true, graphExtraction: true, extract: true, triage: false,
	};

	function emptyFEntry(enabled: boolean): FEntry {
		return {
			enabled, mode: '', profile: '', timeoutMs: '',
			allowedTypes: '', qualityGate: '', contradictionDetection: '',
			defaultSince: '', maxTotalChars: '', maxChunkSize: '',
			applyMode: '', policy: '', maxAcceptsPerRun: '', maxDiffLines: '', rejectEmpty: false,
			judgment: { mode: '', profile: '', timeoutMs: '' },
			rest: {},
		};
	}

	function newImproveProfile(): ImproveProfile {
		const processes = {} as Record<ProcKey, FEntry>;
		for (const k of PROCESS_KEYS) processes[k] = emptyFEntry(DEFAULT_ENABLED[k]);
		return {
			id: crypto.randomUUID(), name: '', description: '', limit: 25, autoAccept: 0,
			processes, syncEnabled: '', syncPush: '', syncMessage: '',
		};
	}

	const triFromEnabled = (o: unknown): Tri =>
		typeof o === 'object' && o !== null && 'enabled' in (o as Record<string, unknown>)
			? ((o as Record<string, unknown>).enabled ? 'on' : 'off') : '';

	// Known per-process keys we model explicitly; everything else round-trips via `rest`.
	const KNOWN_PROC_KEYS = new Set([
		'enabled','mode','profile','timeoutMs','allowedTypes','qualityGate','contradictionDetection',
		'defaultSince','maxTotalChars','maxChunkSize','applyMode','policy','maxAcceptsPerRun',
		'maxDiffLines','rejectEmpty','judgment',
	]);

	function readFEntry(raw: unknown, defaultEnabled: boolean): FEntry {
		const e = emptyFEntry(defaultEnabled);
		if (typeof raw === 'boolean') { e.enabled = raw; return e; }
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return e;
		const r = raw as Record<string, unknown>;
		if (typeof r.enabled === 'boolean') e.enabled = r.enabled;
		e.mode = (r.mode as FMode) ?? '';
		e.profile = (r.profile as string) ?? '';
		e.timeoutMs = r.timeoutMs != null ? String(r.timeoutMs) : '';
		e.allowedTypes = Array.isArray(r.allowedTypes) ? (r.allowedTypes as string[]).join(', ') : '';
		e.qualityGate = triFromEnabled(r.qualityGate);
		e.contradictionDetection = triFromEnabled(r.contradictionDetection);
		e.defaultSince = (r.defaultSince as string) ?? '';
		e.maxTotalChars = r.maxTotalChars != null ? String(r.maxTotalChars) : '';
		e.maxChunkSize = r.maxChunkSize != null ? String(r.maxChunkSize) : '';
		e.applyMode = (r.applyMode as '' | 'queue' | 'promote') ?? '';
		e.policy = (r.policy as string) ?? '';
		e.maxAcceptsPerRun = r.maxAcceptsPerRun != null ? String(r.maxAcceptsPerRun) : '';
		e.maxDiffLines = r.maxDiffLines != null ? String(r.maxDiffLines) : '';
		e.rejectEmpty = r.rejectEmpty === true;
		if (typeof r.judgment === 'object' && r.judgment !== null) {
			const j = r.judgment as Record<string, unknown>;
			e.judgment = { mode: (j.mode as FMode) ?? '', profile: (j.profile as string) ?? '', timeoutMs: j.timeoutMs != null ? String(j.timeoutMs) : '' };
		}
		// preserve any field akm supports that this UI doesn't model
		for (const [k, v] of Object.entries(r)) if (!KNOWN_PROC_KEYS.has(k)) e.rest[k] = v;
		return e;
	}

	function buildProcessConfig(e: FEntry): Record<string, unknown> {
		const out: Record<string, unknown> = { ...e.rest, enabled: e.enabled };
		if (e.mode) out.mode = e.mode;
		if (e.profile) out.profile = e.profile;
		if (e.timeoutMs !== '') out.timeoutMs = parseInt(e.timeoutMs, 10);
		const types = e.allowedTypes.split(',').map((s) => s.trim()).filter(Boolean);
		if (types.length) out.allowedTypes = types;
		if (e.qualityGate) out.qualityGate = { enabled: e.qualityGate === 'on' };
		if (e.contradictionDetection) out.contradictionDetection = { enabled: e.contradictionDetection === 'on' };
		if (e.defaultSince) out.defaultSince = e.defaultSince;
		const mtc = optInt(e.maxTotalChars); if (mtc !== undefined) out.maxTotalChars = mtc;
		const mcs = optInt(e.maxChunkSize); if (mcs !== undefined) out.maxChunkSize = mcs;
		if (e.applyMode) out.applyMode = e.applyMode;
		if (e.policy) out.policy = e.policy;
		const mapr = optInt(e.maxAcceptsPerRun); if (mapr !== undefined) out.maxAcceptsPerRun = mapr;
		const mdl = optInt(e.maxDiffLines); if (mdl !== undefined) out.maxDiffLines = mdl;
		if (e.rejectEmpty) out.rejectEmpty = true;
		const j: Record<string, unknown> = {};
		if (e.judgment.mode) j.mode = e.judgment.mode;
		if (e.judgment.profile) j.profile = e.judgment.profile;
		if (e.judgment.timeoutMs !== '') j.timeoutMs = parseInt(e.judgment.timeoutMs, 10);
		if (Object.keys(j).length) out.judgment = j;
		return out;
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

	onMount(() => { if (tokenStored) { void load(); } });
</script>

<!-- Datalist referenced by drawer improve profile inputs -->
<datalist id="llm-profiles-list">
	{#each llmProfileNames as name}<option value={name}></option>{/each}
</datalist>

<div class="panel" role="tabpanel">
	<div class="panel-header">
		<h2>Knowledge</h2>
		<div class="panel-header-actions">
			<button class="btn btn-secondary btn-sm" onclick={() => void load()} disabled={loading || saving || !tokenStored}>
				{#if loading}<span class="spinner"></span>{/if}
				Refresh
			</button>
			<button class="btn btn-primary btn-sm" onclick={() => void save()} disabled={loading || saving || !tokenStored}>
				{#if saving}<span class="spinner"></span>{/if}
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
		</div>

		<!-- ── AI Services group (model/agent/improve connections + embedding) ── -->
		{#if knowledgeSection === 'ai-services'}
		<p class="section-note section-note--lead">The AI services your assistant uses to build and search its memory — the language models that organize memories, the embedding provider for semantic search, and the maintenance pipeline.</p>

		<!-- ── LLM Profiles ──────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Language models <span class="section-title-aka">akm LLM profiles</span></h3>
			<p class="section-note">The language models your assistant uses to organize and improve its memory. Add one per LLM service.</p>

			{#if llmProfiles.length === 0}
				<div class="profile-empty">
					<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
					</svg>
					<p class="empty-note">No LLM profiles configured — add one below.</p>
				</div>
			{:else}
				<div class="profile-list">
					{#each llmProfiles as p (p.id)}
						<div class="profile-row">
							<span class="profile-row-name">{p.name || '(unnamed)'}</span>
							{#if defaultLlmProfile === p.name && p.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if p.name && defaultLlmProfile !== p.name}
									<button class="btn btn-sm" onclick={() => { defaultLlmProfile = p.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openLlmDrawer(p)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('llm', p.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerLlm = newLlmProfile(); drawerType = 'llm'; }} disabled={loading || saving}>
				+ Add LLM Profile
			</button>
		</section>

		<!-- ── Agent Profiles ────────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Agent runners <span class="section-title-aka">akm agent profiles</span></h3>
			<p class="section-note">Runner configs for maintenance steps that spawn a subprocess (opencode or claude CLI).</p>

			{#if agentProfiles.length === 0}
				<div class="profile-empty">
					<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>
						<circle cx="12" cy="10" r="2"/><path d="M9 10H7m10 0h-2"/>
					</svg>
					<p class="empty-note">No agent profiles defined.</p>
				</div>
			{:else}
				<div class="profile-list">
					{#each agentProfiles as p (p.id)}
						<div class="profile-row">
							<span class="profile-row-name">{p.name || '(unnamed)'}</span>
							<span class="badge">{p.platform}</span>
							{#if defaultAgentProfile === p.name && p.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if p.name && defaultAgentProfile !== p.name}
									<button class="btn btn-sm" onclick={() => { defaultAgentProfile = p.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openAgentDrawer(p)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('agent', p.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerAgent = newAgentProfile(); drawerType = 'agent'; }} disabled={loading || saving}>
				+ Add Agent Profile
			</button>
		</section>

		<!-- ── Improve Profiles ───────────────────────────────────────────── -->
		<section class="config-section">
			<h3 class="section-title">Memory maintenance <span class="section-title-aka">akm improve</span></h3>
			<p class="section-note">Scheduled runs that distill, deduplicate, and improve stored memories. Each configuration picks which steps run and which language model they use — add a language model above first.</p>

			{#if improveProfiles.length === 0}
				<div class="profile-empty">
					<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
						<path d="M12 3c-1 2-2 3-3 4 1 3 3 5 3 8a6 6 0 0 1-6-6c0-3 2-5 3-6"/><path d="M17.5 3.5c.5 1.5.5 3-.5 4.5 1 1 2 2.5 2 4a4 4 0 0 1-4-4c0-2 1-3.5 2.5-4.5z"/>
					</svg>
					<p class="empty-note">No improve profiles defined — add one below.</p>
				</div>
			{:else}
				<div class="profile-list">
					{#each improveProfiles as ip (ip.id)}
						<div class="profile-row">
							<span class="profile-row-name">{ip.name || '(unnamed)'}</span>
							{#if ip.description}
								<span class="profile-row-desc">{ip.description}</span>
							{/if}
							{#if defaultImproveProfile === ip.name && ip.name}
								<span class="badge badge--default">Default</span>
							{/if}
							<div class="profile-row-actions">
								{#if ip.name && defaultImproveProfile !== ip.name}
									<button class="btn btn-sm" onclick={() => { defaultImproveProfile = ip.name; }} disabled={loading || saving}>Set Default</button>
								{/if}
								<button class="btn btn-sm" onclick={() => openImproveDrawer(ip)} disabled={loading || saving}>Edit</button>
								<button class="btn btn-sm btn-danger" onclick={() => removeProfile('improve', ip.id)} disabled={loading || saving}>Remove</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<button class="btn btn-secondary btn-sm" onclick={() => { drawerImprove = newImproveProfile(); drawerType = 'improve'; }} disabled={loading || saving}>
				+ Add Improve Profile
			</button>
		</section>

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
			disabled={loading || saving}
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

	</div>

	<!-- ── Slide-in Drawer ───────────────────────────────────────────────────── -->
	{#if drawerType !== null}
		<div class="drawer-scrim" role="presentation" onclick={closeDrawer}></div>

		<div class="drawer" role="dialog" aria-modal="true" aria-label="Edit profile">
			<div class="drawer-header">
				<h3 class="drawer-title">
					{#if drawerType === 'llm'}LLM Profile
					{:else if drawerType === 'agent'}Agent Profile
					{:else}Improve Profile{/if}
				</h3>
				<button class="drawer-close" onclick={closeDrawer} aria-label="Close">✕</button>
			</div>

			<div class="drawer-body">

				{#if drawerType === 'llm' && drawerLlm}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-llm-name">Profile Name</label>
							<input id="d-llm-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={drawerLlm.name} />
						</div>
						<div class="control-group control-group--wide">
							<label class="control-label" for="d-llm-endpoint">Endpoint</label>
							<input id="d-llm-endpoint" class="control-input" type="url" spellcheck="false" placeholder="https://api.openai.com/v1/chat/completions" bind:value={drawerLlm.endpoint} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-model">Model</label>
							<input id="d-llm-model" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o-mini" bind:value={drawerLlm.model} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-provider">Provider (label)</label>
							<input id="d-llm-provider" class="control-input" type="text" spellcheck="false" placeholder="openai" bind:value={drawerLlm.provider} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-apikey">API Key</label>
							<PasswordInput id="d-llm-apikey" placeholder={'${AKM_LLM_API_KEY}'} bind:value={drawerLlm.apiKey} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-temperature">Temperature (0–2)</label>
							<input id="d-llm-temperature" class="control-input control-input--narrow" type="number" min="0" max="2" step="0.1" bind:value={drawerLlm.temperature} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-maxtokens">Max tokens</label>
							<input id="d-llm-maxtokens" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.maxTokens} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-timeout">Timeout (ms)</label>
							<input id="d-llm-timeout" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.timeoutMs} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-concurrency">Concurrency</label>
							<input id="d-llm-concurrency" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.concurrency} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-contextlength">Context length</label>
							<input id="d-llm-contextlength" class="control-input control-input--narrow" type="number" min="1" bind:value={drawerLlm.contextLength} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-llm-judgemodel">Judge model</label>
							<input id="d-llm-judgemodel" class="control-input" type="text" spellcheck="false" placeholder="gpt-4o" bind:value={drawerLlm.judgeModel} />
						</div>
					</div>
					<label class="toggle-row" style="margin-top: var(--space-4)">
						<input type="checkbox" bind:checked={drawerLlm.supportsJsonSchema} />
						<span class="toggle-label">Supports JSON schema</span>
						<span class="toggle-hint">Use response_format: json_schema for structured output</span>
					</label>
					<label class="toggle-row">
					<input type="checkbox" bind:checked={drawerLlm.structuredOutput} />
					<span class="toggle-label">Structured output capability</span>
					<span class="toggle-hint">capabilities.structuredOutput — model reliably returns valid structured JSON</span>
					</label>
					<label class="toggle-row">
					<input type="checkbox" bind:checked={drawerLlm.enableThinking} />
					<span class="toggle-label">Enable thinking</span>
					<span class="toggle-hint">Allow extended/thinking tokens for reasoning models</span>
					</label>
					<div class="control-group control-group--wide" style="margin-top: var(--space-4)">
					<label class="control-label" for="d-llm-extra">Extra params (JSON)</label>
					<textarea id="d-llm-extra" class="control-input" rows="3" spellcheck="false" placeholder={'{ "top_p": 0.9 }'} bind:value={drawerLlm.extraParams}></textarea>
					<span class="feat-hint">Merged into the provider request body. Must be a JSON object.</span>
					</div>

				{:else if drawerType === 'agent' && drawerAgent}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-agent-name">Profile Name</label>
							<input id="d-agent-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. opencode" bind:value={drawerAgent.name} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-agent-platform">Platform</label>
							<select id="d-agent-platform" class="control-input" bind:value={drawerAgent.platform}>
								<option value="opencode">opencode</option>
								<option value="claude">claude</option>
								<option value="opencode-sdk">opencode-sdk</option>
							</select>
						</div>
						{#if drawerAgent.platform !== 'opencode-sdk'}
							<div class="control-group">
								<label class="control-label" for="d-agent-bin">Binary</label>
								<input id="d-agent-bin" class="control-input" type="text" spellcheck="false" placeholder="opencode" bind:value={drawerAgent.bin} />
							</div>
							<div class="control-group control-group--wide">
								<label class="control-label" for="d-agent-args">Extra args (space-separated)</label>
								<input id="d-agent-args" class="control-input" type="text" spellcheck="false" placeholder="run --model gpt-4o" bind:value={drawerAgent.args} />
							</div>
						{:else}
							<div class="control-group">
								<label class="control-label" for="d-agent-model">Model</label>
								<input id="d-agent-model" class="control-input" type="text" spellcheck="false" placeholder="anthropic/claude-sonnet-4-5" bind:value={drawerAgent.model} />
							</div>
							<div class="control-group">
								<label class="control-label" for="d-agent-workspace">Workspace</label>
								<input id="d-agent-workspace" class="control-input" type="text" spellcheck="false" placeholder={'${PWD}'} bind:value={drawerAgent.workspace} />
							</div>
						{/if}
					</div>

				{:else if drawerType === 'improve' && drawerImprove}
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-imp-name">Profile Name</label>
							<input id="d-imp-name" class="control-input" type="text" spellcheck="false" placeholder="e.g. default" bind:value={drawerImprove.name} />
						</div>
						<div class="control-group control-group--wide">
							<label class="control-label" for="d-imp-desc">Description</label>
							<input id="d-imp-desc" class="control-input" type="text" spellcheck="false" placeholder="Optional description" bind:value={drawerImprove.description} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-imp-limit">Max proposals per run</label>
							<input id="d-imp-limit" class="control-input control-input--narrow" type="number" min="1" max="100" bind:value={drawerImprove.limit} />
						</div>
						<div class="control-group">
							<label class="control-label" for="d-imp-autoacc">Auto-accept threshold (0 = manual)</label>
							<input id="d-imp-autoacc" class="control-input control-input--narrow" type="number" min="0" max="1" step="0.05" bind:value={drawerImprove.autoAccept} />
						</div>
					</div>

					<div class="proc-list">
						{#each PROCESS_KEYS as key (key)}
							{@const proc = drawerImprove.processes[key]}
							<div class="proc-card">
								<div class="proc-head">
									<input type="checkbox" bind:checked={proc.enabled} aria-label="{key} enabled" />
									<div class="proc-name"><span class="feat-name">{key}</span><span class="feat-hint">{PROCESS_HINTS[key]}</span></div>
									<select class="control-input" bind:value={proc.mode} aria-label="{key} mode">
										<option value="">Default mode</option>
										<option value="llm">LLM (direct call)</option>
										<option value="agent">Agent (subprocess)</option>
										<option value="sdk">SDK (programmatic)</option>
									</select>
									<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" placeholder="— default profile —" bind:value={proc.profile} aria-label="{key} profile" />
									<input class="control-input control-input--narrow" type="number" min="1" placeholder="timeout ms" bind:value={proc.timeoutMs} aria-label="{key} timeout" />
								</div>
								<details class="proc-adv">
									<summary>Advanced</summary>
									<div class="proc-adv-grid">
										<label class="adv-field"><span>Allowed types (comma-separated)</span>
											<input class="control-input" type="text" spellcheck="false" placeholder="skill, knowledge, …" bind:value={proc.allowedTypes} />
										</label>
										{#if key === 'reflect' || key === 'distill'}
											<label class="adv-field"><span>Quality gate</span>
												<select class="control-input" bind:value={proc.qualityGate}>
													<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
												</select>
											</label>
										{/if}
										{#if key === 'consolidate'}
											<label class="adv-field"><span>Contradiction detection</span>
												<select class="control-input" bind:value={proc.contradictionDetection}>
													<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
												</select>
											</label>
										{/if}
										{#if key === 'extract'}
											<label class="adv-field"><span>Default since</span>
												<input class="control-input" type="text" spellcheck="false" placeholder="e.g. 7d, 2026-01-01" bind:value={proc.defaultSince} />
											</label>
											<label class="adv-field"><span>Max total chars</span>
												<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxTotalChars} />
											</label>
											<label class="adv-field"><span>Max chunk size (1–50)</span>
												<input class="control-input control-input--narrow" type="number" min="1" max="50" bind:value={proc.maxChunkSize} />
											</label>
										{/if}
										{#if key === 'triage'}
											<label class="adv-field"><span>Apply mode</span>
												<select class="control-input" bind:value={proc.applyMode}>
													<option value="">Default</option><option value="queue">Queue</option><option value="promote">Promote</option>
												</select>
											</label>
											<label class="adv-field"><span>Policy</span>
												<input class="control-input" type="text" spellcheck="false" placeholder="policy name/ref" bind:value={proc.policy} />
											</label>
											<label class="adv-field"><span>Max accepts per run</span>
												<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxAcceptsPerRun} />
											</label>
											<label class="adv-field"><span>Max diff lines</span>
												<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.maxDiffLines} />
											</label>
											<label class="adv-field adv-field--check">
												<input type="checkbox" bind:checked={proc.rejectEmpty} /> <span>Reject empty diffs</span>
											</label>
											<div class="adv-field adv-field--wide">
												<span class="adv-sublabel">Judgment (overrides for the accept/reject decision)</span>
												<div class="proc-adv-grid">
													<label class="adv-field"><span>Mode</span>
														<select class="control-input" bind:value={proc.judgment.mode}>
															<option value="">Default</option><option value="llm">LLM</option><option value="agent">Agent</option><option value="sdk">SDK</option>
														</select>
													</label>
													<label class="adv-field"><span>Profile</span>
														<input class="control-input" type="text" spellcheck="false" list="llm-profiles-list" bind:value={proc.judgment.profile} />
													</label>
													<label class="adv-field"><span>Timeout (ms)</span>
														<input class="control-input control-input--narrow" type="number" min="1" bind:value={proc.judgment.timeoutMs} />
													</label>
												</div>
											</div>
										{/if}
									</div>
								</details>
							</div>
						{/each}
					</div>

					<!-- Profile-level git sync (akm ImproveProfileConfigSchema.sync) -->
					<div class="controls controls--grid">
						<div class="control-group">
							<label class="control-label" for="d-imp-sync">Git sync after run</label>
							<select id="d-imp-sync" class="control-input" bind:value={drawerImprove.syncEnabled}>
								<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
							</select>
						</div>
						<div class="control-group">
							<label class="control-label" for="d-imp-syncpush">Push to remote</label>
							<select id="d-imp-syncpush" class="control-input" bind:value={drawerImprove.syncPush}>
								<option value="">Default</option><option value="on">Enabled</option><option value="off">Disabled</option>
							</select>
						</div>
						<div class="control-group control-group--wide">
							<label class="control-label" for="d-imp-syncmsg">Commit message</label>
							<input id="d-imp-syncmsg" class="control-input" type="text" spellcheck="false" placeholder="Optional commit message" bind:value={drawerImprove.syncMessage} />
						</div>
					</div>
				{/if}

			</div>

			<div class="drawer-footer">
				<button class="btn btn-secondary" onclick={closeDrawer}>Cancel</button>
				<button class="btn btn-primary" onclick={applyDrawer}>Apply</button>
			</div>
		</div>
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

	.config-section { display: flex; flex-direction: column; gap: var(--space-4); }

	.section-title {
		font-size: var(--text-sm); font-weight: var(--font-semibold); color: var(--color-text);
		margin: 0;
		padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-border);
	}
	/* Keep the AKM/CLI term as a quiet secondary label next to the plain-language title. */
	.section-title-aka {
		font-size: var(--text-xs); font-weight: var(--font-normal);
		color: var(--color-text-secondary); font-family: var(--font-mono);
		margin-left: var(--space-2);
	}
	.section-note--lead {
		font-size: var(--text-sm); color: var(--color-text-secondary);
		max-width: 72ch; margin: 0 0 var(--space-4);
	}

	.section-note { font-size: var(--text-sm); color: var(--color-text-secondary); margin: 0; }
	.empty-note { font-size: var(--text-sm); color: var(--color-text-secondary); font-style: italic; margin: 0; }
	.profile-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); margin-bottom: var(--space-2); color: var(--color-text-secondary); }
	.profile-empty svg { opacity: 0.45; }

	/* Profile list (compact rows) */
	.profile-list { display: flex; flex-direction: column; gap: var(--space-1); }
	.profile-row {
		display: flex; align-items: center; gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border); border-radius: var(--radius-sm);
		background: var(--color-bg-secondary);
	}
	.profile-row-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.profile-row-desc { font-size: var(--text-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 20rem; }
	.profile-row-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

	/* Badges */
	.badge {
		font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-sm);
		background: var(--color-bg-tertiary, var(--color-bg-secondary)); color: var(--color-text-secondary);
		border: 1px solid var(--color-border); white-space: nowrap; flex-shrink: 0;
	}
	.badge--default {
		background: var(--color-primary-subtle, rgba(99, 102, 241, 0.1));
		color: var(--color-primary, #6366f1);
		border-color: var(--color-primary-border, rgba(99, 102, 241, 0.3));
	}
	/* .badge--off intentionally uses the neutral base .badge styling. */

	/* Controls */
	.controls { display: flex; flex-direction: column; gap: var(--space-4); }
	.controls--grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: var(--space-4); }
	.control-group { display: flex; flex-direction: column; gap: var(--space-1); }
	.control-group--wide { grid-column: 1 / -1; }
	.control-label { font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); }
	.control-input {
		font-size: var(--text-sm); color: var(--color-text);
		background: var(--color-input-bg, var(--color-bg)); border: 1px solid var(--color-border);
		border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); width: 100%;
	}
	.control-input--narrow { max-width: 8rem; }
	.control-input:focus { outline: 2px solid var(--color-primary); outline-offset: 1px; }
	.control-input:disabled { opacity: 0.5; cursor: not-allowed; }

	/* Toggle row */
	.toggle-row { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; font-size: var(--text-sm); }
	.toggle-row input[type="checkbox"] { width: 1rem; height: 1rem; flex-shrink: 0; }
	.toggle-label { font-weight: var(--font-medium); color: var(--color-text); }
	.toggle-hint { color: var(--color-text-secondary); font-size: var(--text-xs); }

	/* Improve drawer process labels */
	.feat-name { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--color-text); font-family: var(--font-mono); display: block; }
	.feat-hint { font-size: var(--text-xs); color: var(--color-text-secondary); }

	/* Improve process cards (common row + collapsible advanced fields) */
	.proc-list { display: flex; flex-direction: column; gap: var(--space-2); }
	.proc-card { border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-secondary); padding: var(--space-2); }
	.proc-head { display: grid; grid-template-columns: 1.5rem 1fr 9rem 11rem 7rem; align-items: center; gap: var(--space-2); }
	@media (max-width: 600px) {
		.proc-head { grid-template-columns: 1.5rem 1fr; }
		.proc-head > :nth-child(n+3) { grid-column: 1 / -1; }
	}
	.proc-head input[type="checkbox"] { width: 1rem; height: 1rem; }
	.proc-name { min-width: 0; }
	.proc-adv { margin-top: var(--space-2); }
	.proc-adv > summary { cursor: pointer; font-size: var(--text-xs); color: var(--color-text-secondary); user-select: none; }
	.proc-adv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: var(--space-2); margin-top: var(--space-2); }
	.adv-field { display: flex; flex-direction: column; gap: 2px; }
	.adv-field > span { font-size: var(--text-xs); color: var(--color-text-secondary); }
	.adv-field--check { flex-direction: row; align-items: center; gap: var(--space-2); }
	.adv-field--wide { grid-column: 1 / -1; }
	.adv-sublabel { display: block; font-size: var(--text-xs); font-weight: var(--font-medium); color: var(--color-text-secondary); margin-bottom: 2px; }

	/* Slide-in drawer */
	.drawer-scrim {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 200;
	}
	.drawer {
		position: fixed; top: 0; right: 0; bottom: 0;
		width: min(640px, 92vw);
		background: var(--color-bg);
		border-left: 1px solid var(--color-border);
		box-shadow: -4px 0 32px rgba(0, 0, 0, 0.2);
		z-index: 201;
		display: flex; flex-direction: column;
		animation: drawer-in 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes drawer-in {
		from { transform: translateX(100%); }
		to   { transform: translateX(0); }
	}
	.drawer-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-4) var(--space-6);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
	}
	.drawer-title { font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text); margin: 0; }
	.drawer-close {
		width: 2rem; height: 2rem; border-radius: var(--radius-sm);
		background: transparent; border: 1px solid var(--color-border);
		color: var(--color-text-secondary); cursor: pointer; font-size: var(--text-sm);
		display: flex; align-items: center; justify-content: center;
	}
	.drawer-close:hover { background: var(--color-surface-hover); color: var(--color-text); }
	.drawer-body { flex: 1; overflow-y: auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-5); }
	.drawer-footer {
		display: flex; justify-content: flex-end; gap: var(--space-3);
		padding: var(--space-4) var(--space-6);
		border-top: 1px solid var(--color-border);
		flex-shrink: 0;
	}

	/* Error banner */
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
