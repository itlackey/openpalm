import { describe, it, expect } from 'vitest';
import {
	PROCESS_KEYS,
	DEFAULT_ENABLED,
	optNum,
	optInt,
	readFEntry,
	buildProcessConfig,
	triFromEnabled,
	type FEntry,
	type Tri,
	type ProcKey,
} from './akm/improve-process-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip fidelity guard for AkmTab.svelte.
//
// AkmTab.load() maps a raw akm config object into UI state; AkmTab.save() maps
// that UI state back into the akm payload. This test reproduces BOTH mappings
// over a representative config and asserts the save payload deep-equals the
// (normalized) input — proving no field is silently dropped on the round trip.
//
// The per-process improve mapping (readFEntry/buildProcessConfig) is imported
// from improve-process-helpers.ts and is the EXACT code AkmTab + the improve
// drawer use. The LLM/agent/improve-top mapping is mirrored here field-for-field
// from AkmTab.svelte; if that inline logic changes, this test must change with
// it, which is the guard.
//
// rest/Tri/process fields are deliberately exercised below.
// ─────────────────────────────────────────────────────────────────────────────

// ── UI-state shapes (mirror AkmTab) ──────────────────────────────────────────
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
	structuredOutput: boolean;
	extraParams: string;
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
interface ImproveProfile {
	id: string;
	name: string;
	description: string;
	limit: number;
	autoAccept: number;
	processes: Record<ProcKey, FEntry>;
	syncEnabled: Tri;
	syncPush: Tri;
	syncMessage: string;
}

// ── load-mapping (mirrors AkmTab.load) ───────────────────────────────────────
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
		structuredOutput:
			((raw.capabilities as Record<string, unknown> | undefined)?.structuredOutput as boolean) ?? false,
		extraParams: raw.extraParams && typeof raw.extraParams === 'object' ? JSON.stringify(raw.extraParams, null, 2) : '',
	};
}

function improveProfileFromRaw(name: string, raw: Record<string, unknown>): ImproveProfile {
	const procs = (raw.processes as Record<string, unknown> | undefined) ?? {};
	const processes = {} as Record<ProcKey, FEntry>;
	for (const k of PROCESS_KEYS) processes[k] = readFEntry(procs[k], DEFAULT_ENABLED[k]);
	const sync = raw.sync as Record<string, unknown> | undefined;
	return {
		id: 'test-id',
		name,
		description: (raw.description as string) ?? '',
		limit: typeof raw.limit === 'number' ? raw.limit : 25,
		autoAccept: typeof raw.autoAccept === 'number' ? raw.autoAccept : 0,
		processes,
		syncEnabled: triFromEnabled(sync ? { enabled: sync.enabled } : undefined),
		syncPush: triFromEnabled(sync ? { enabled: sync.push } : undefined),
		syncMessage: (sync?.message as string) ?? '',
	};
}

interface Loaded {
	llmProfiles: LlmProfile[];
	defaultLlmProfile: string;
	agentProfiles: AgentProfile[];
	defaultAgentProfile: string;
	improveProfiles: ImproveProfile[];
	defaultImproveProfile: string;
	emb: {
		endpoint: string;
		model: string;
		provider: string;
		apiKey: string;
		dimension: number;
		localModel: string;
		batchSize: string;
		chunkSize: string;
		contextLength: string;
		ollamaNumCtx: string;
	};
	semanticSearchMode: 'auto' | 'off';
	outputFormat: 'json' | 'yaml' | 'text';
	outputDetail: 'brief' | 'normal' | 'full';
	imHalfLife: string;
	imFeedbackBoost: string;
	imEventRetention: string;
	searchMinScore: string;
	searchCurateRerank: Tri;
	fbRequireReason: Tri;
	fbFailureModes: string;
	indexJson: string;
}

function load(config: Record<string, unknown>): Loaded {
	const rawProfiles = config.profiles as Record<string, unknown> | undefined;

	const rawLlm = rawProfiles?.llm as Record<string, unknown> | undefined;
	const llmProfiles = rawLlm
		? Object.entries(rawLlm).map(([name, p]) => ({
				id: 'test-id',
				name,
				...profileFromRaw(p as Record<string, unknown>),
			}))
		: [];

	const rawAgent = rawProfiles?.agent as Record<string, unknown> | undefined;
	const agentProfiles = rawAgent
		? Object.entries(rawAgent).map(([name, p]) => {
				const raw = p as Record<string, unknown>;
				return {
					id: 'test-id',
					name,
					platform: (raw.platform as 'opencode' | 'claude' | 'opencode-sdk') ?? 'opencode',
					bin: (raw.bin as string) ?? '',
					args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '',
					workspace: (raw.workspace as string) ?? '',
					model: (raw.model as string) ?? '',
				};
			})
		: [];

	const rawImpProfiles = rawProfiles?.improve as Record<string, unknown> | undefined;
	const improveProfiles = rawImpProfiles
		? Object.entries(rawImpProfiles).map(([name, p]) => improveProfileFromRaw(name, p as Record<string, unknown>))
		: [];

	const rawDefaults = config.defaults as Record<string, unknown> | undefined;
	const defaultLlmProfile = (rawDefaults?.llm as string) ?? '';
	const defaultAgentProfile = (rawDefaults?.agent as string) ?? '';
	const defaultImproveProfile = (rawDefaults?.improve as string) ?? '';

	const e = config.embedding as Record<string, unknown> | undefined;
	const ollamaOpts = e?.ollamaOptions as Record<string, unknown> | undefined;
	const emb = {
		endpoint: (e?.endpoint as string) ?? '',
		model: (e?.model as string) ?? '',
		provider: (e?.provider as string) ?? '',
		apiKey: (e?.apiKey as string) ?? '',
		dimension: typeof e?.dimension === 'number' ? e.dimension : 1536,
		localModel: (e?.localModel as string) ?? '',
		batchSize: e?.batchSize != null ? String(e.batchSize) : '',
		chunkSize: e?.chunkSize != null ? String(e.chunkSize) : '',
		contextLength: e?.contextLength != null ? String(e.contextLength) : '',
		ollamaNumCtx: ollamaOpts?.num_ctx != null ? String(ollamaOpts.num_ctx) : '',
	};

	const semanticSearchMode = (config.semanticSearchMode as 'auto' | 'off') ?? 'auto';
	const output = config.output as Record<string, unknown> | undefined;
	const outputFormat = (output?.format as 'json' | 'yaml' | 'text') ?? 'json';
	const outputDetail = (output?.detail as 'brief' | 'normal' | 'full') ?? 'brief';

	const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '');
	const triE = (o: unknown): Tri =>
		o && typeof o === 'object' && 'enabled' in (o as Record<string, unknown>)
			? (o as Record<string, unknown>).enabled
				? 'on'
				: 'off'
			: '';
	const improveTop = config.improve as Record<string, unknown> | undefined;
	const decay = improveTop?.utilityDecay as Record<string, unknown> | undefined;
	const imHalfLife = num(decay?.halfLifeDays);
	const imFeedbackBoost = num(decay?.feedbackStabilityBoost);
	const imEventRetention = num(improveTop?.eventRetentionDays);
	const search = config.search as Record<string, unknown> | undefined;
	const searchMinScore = num(search?.minScore);
	const searchCurateRerank = triE(search?.curateRerank);
	const feedback = config.feedback as Record<string, unknown> | undefined;
	const fbRequireReason: Tri =
		typeof feedback?.requireReason === 'boolean' ? (feedback.requireReason ? 'on' : 'off') : '';
	const fbFailureModes = Array.isArray(feedback?.allowedFailureModes)
		? (feedback!.allowedFailureModes as string[]).join(', ')
		: '';
	const indexJson = config.index && typeof config.index === 'object' ? JSON.stringify(config.index, null, 2) : '';

	return {
		llmProfiles,
		defaultLlmProfile,
		agentProfiles,
		defaultAgentProfile,
		improveProfiles,
		defaultImproveProfile,
		emb,
		semanticSearchMode,
		outputFormat,
		outputDetail,
		imHalfLife,
		imFeedbackBoost,
		imEventRetention,
		searchMinScore,
		searchCurateRerank,
		fbRequireReason,
		fbFailureModes,
		indexJson,
	};
}

// ── save-payload (mirrors AkmTab.save) ───────────────────────────────────────
function buildLlmProfilePayload(p: LlmProfile): Record<string, unknown> {
	const out: Record<string, unknown> = { endpoint: p.endpoint, model: p.model };
	if (p.provider) out.provider = p.provider;
	if (p.apiKey) out.apiKey = p.apiKey;
	const t = optNum(p.temperature);
	if (t !== undefined) out.temperature = t;
	const mt = optInt(p.maxTokens);
	if (mt !== undefined) out.maxTokens = mt;
	const to = optInt(p.timeoutMs);
	if (to !== undefined) out.timeoutMs = to;
	const co = optInt(p.concurrency);
	if (co !== undefined) out.concurrency = co;
	const cl = optInt(p.contextLength);
	if (cl !== undefined) out.contextLength = cl;
	if (p.judgeModel) out.judgeModel = p.judgeModel;
	if (p.supportsJsonSchema) out.supportsJsonSchema = true;
	if (p.enableThinking) out.enableThinking = true;
	if (p.structuredOutput) out.capabilities = { structuredOutput: true };
	if (p.extraParams.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(p.extraParams);
		} catch {
			throw new Error(`LLM profile "${p.name}": extraParams must be valid JSON`);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(`LLM profile "${p.name}": extraParams must be a JSON object`);
		out.extraParams = parsed;
	}
	return out;
}

function save(s: Loaded): Record<string, unknown> {
	const profilesLlm: Record<string, unknown> = {};
	for (const p of s.llmProfiles) {
		if (p.name.trim()) profilesLlm[p.name.trim()] = buildLlmProfilePayload(p);
	}

	const profilesAgent: Record<string, unknown> = {};
	for (const p of s.agentProfiles) {
		if (!p.name.trim()) continue;
		const entry: Record<string, unknown> = { platform: p.platform };
		if (p.bin) entry.bin = p.bin;
		if (p.args) entry.args = p.args.split(/\s+/).filter(Boolean);
		if (p.workspace) entry.workspace = p.workspace;
		if (p.model) entry.model = p.model;
		profilesAgent[p.name.trim()] = entry;
	}

	const profilesImprove: Record<string, unknown> = {};
	for (const ip of s.improveProfiles) {
		if (!ip.name.trim()) continue;
		const processes: Record<string, unknown> = {};
		for (const k of PROCESS_KEYS) processes[k] = buildProcessConfig(ip.processes[k]);
		const entry: Record<string, unknown> = { limit: ip.limit, processes };
		if (ip.description) entry.description = ip.description;
		if (ip.autoAccept > 0) entry.autoAccept = ip.autoAccept;
		const sync: Record<string, unknown> = {};
		if (ip.syncEnabled) sync.enabled = ip.syncEnabled === 'on';
		if (ip.syncPush) sync.push = ip.syncPush === 'on';
		if (ip.syncMessage.trim()) sync.message = ip.syncMessage.trim();
		if (Object.keys(sync).length) entry.sync = sync;
		profilesImprove[ip.name.trim()] = entry;
	}

	const embPayload: Record<string, unknown> = {
		endpoint: s.emb.endpoint,
		model: s.emb.model,
		dimension: s.emb.dimension,
	};
	if (s.emb.provider) embPayload.provider = s.emb.provider;
	if (s.emb.apiKey) embPayload.apiKey = s.emb.apiKey;
	if (s.emb.localModel) embPayload.localModel = s.emb.localModel;
	const bs = optInt(s.emb.batchSize);
	if (bs !== undefined) embPayload.batchSize = bs;
	const cs = optInt(s.emb.chunkSize);
	if (cs !== undefined) embPayload.chunkSize = cs;
	const ecl = optInt(s.emb.contextLength);
	if (ecl !== undefined) embPayload.contextLength = ecl;
	const numCtx = optInt(s.emb.ollamaNumCtx);
	if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

	const defaultsPayload: Record<string, unknown> = {};
	if (s.defaultLlmProfile) defaultsPayload.llm = s.defaultLlmProfile;
	if (s.defaultAgentProfile) defaultsPayload.agent = s.defaultAgentProfile;
	if (s.defaultImproveProfile) defaultsPayload.improve = s.defaultImproveProfile;

	const improveTopPayload: Record<string, unknown> = {};
	const decayPayload: Record<string, unknown> = {};
	const hl = optNum(s.imHalfLife);
	if (hl !== undefined) decayPayload.halfLifeDays = hl;
	const fb = optNum(s.imFeedbackBoost);
	if (fb !== undefined) decayPayload.feedbackStabilityBoost = fb;
	if (Object.keys(decayPayload).length) improveTopPayload.utilityDecay = decayPayload;
	const er = optNum(s.imEventRetention);
	if (er !== undefined) improveTopPayload.eventRetentionDays = er;

	const searchPayload: Record<string, unknown> = {};
	const ms = optNum(s.searchMinScore);
	if (ms !== undefined) searchPayload.minScore = ms;
	if (s.searchCurateRerank) searchPayload.curateRerank = { enabled: s.searchCurateRerank === 'on' };

	const feedbackPayload: Record<string, unknown> = {};
	if (s.fbRequireReason) feedbackPayload.requireReason = s.fbRequireReason === 'on';
	const modes = s.fbFailureModes
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
	if (modes.length) feedbackPayload.allowedFailureModes = modes;

	let indexPayload: unknown;
	if (s.indexJson.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(s.indexJson);
		} catch {
			throw new Error('Index config must be valid JSON');
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error('Index config must be a JSON object keyed by pass name');
		indexPayload = parsed;
	}

	return {
		profiles: { llm: profilesLlm, agent: profilesAgent, improve: profilesImprove },
		defaults: defaultsPayload,
		embedding: embPayload,
		semanticSearchMode: s.semanticSearchMode,
		output: { format: s.outputFormat, detail: s.outputDetail },
		...(Object.keys(improveTopPayload).length ? { improve: improveTopPayload } : {}),
		...(Object.keys(searchPayload).length ? { search: searchPayload } : {}),
		...(Object.keys(feedbackPayload).length ? { feedback: feedbackPayload } : {}),
		...(indexPayload !== undefined ? { index: indexPayload } : {}),
	};
}

// ── Representative config exercising rest/Tri/process fields ──────────────────
function representativeConfig(): Record<string, unknown> {
	return {
		profiles: {
			llm: {
				default: {
					endpoint: 'https://api.openai.com/v1/chat/completions',
					model: 'gpt-4o-mini',
					provider: 'openai',
					apiKey: '${AKM_LLM_API_KEY}',
					temperature: 0.2,
					maxTokens: 4096,
					timeoutMs: 30000,
					concurrency: 4,
					contextLength: 128000,
					judgeModel: 'gpt-4o',
					supportsJsonSchema: true,
					enableThinking: true,
					capabilities: { structuredOutput: true },
					extraParams: { top_p: 0.9 },
				},
			},
			agent: {
				opencode: {
					platform: 'opencode',
					bin: 'opencode',
					args: ['run', '--model', 'gpt-4o'],
					workspace: '${PWD}',
					model: 'gpt-4o',
				},
				sdk: {
					platform: 'opencode-sdk',
					model: 'anthropic/claude-sonnet-4-5',
					workspace: '${PWD}',
				},
			},
			improve: {
				default: {
					description: 'default improve profile',
					limit: 30,
					autoAccept: 0.85,
					processes: {
						reflect: {
							enabled: true,
							mode: 'llm',
							profile: 'default',
							timeoutMs: 12000,
							allowedTypes: ['skill', 'knowledge'],
							qualityGate: { enabled: true },
							// forward-compat field this UI does NOT model → must round-trip via rest
							experimentalFutureField: { nested: 'preserve-me', count: 7 },
						},
						distill: { enabled: true, qualityGate: { enabled: false } },
						consolidate: { enabled: true, contradictionDetection: { enabled: true } },
						validation: { enabled: false },
						memoryInference: { enabled: true },
						graphExtraction: { enabled: true },
						extract: {
							enabled: true,
							defaultSince: '7d',
							maxTotalChars: 50000,
							maxChunkSize: 20,
						},
						triage: {
							enabled: true,
							applyMode: 'promote',
							policy: 'strict',
							maxAcceptsPerRun: 5,
							maxDiffLines: 200,
							rejectEmpty: true,
							judgment: { mode: 'llm', profile: 'default', timeoutMs: 9000 },
						},
					},
					sync: { enabled: true, push: false, message: 'akm improve sync' },
				},
			},
		},
		defaults: { llm: 'default', agent: 'opencode', improve: 'default' },
		embedding: {
			endpoint: 'https://api.openai.com/v1/embeddings',
			model: 'text-embedding-3-small',
			provider: 'openai',
			apiKey: '${AKM_EMBED_API_KEY}',
			dimension: 1536,
			localModel: 'Xenova/bge-small-en-v1.5',
			batchSize: 32,
			chunkSize: 1000,
			contextLength: 8192,
			ollamaOptions: { num_ctx: 4096 },
		},
		semanticSearchMode: 'auto',
		output: { format: 'json', detail: 'brief' },
		improve: {
			utilityDecay: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
			eventRetentionDays: 90,
		},
		search: { minScore: 0.35, curateRerank: { enabled: true } },
		feedback: { requireReason: true, allowedFailureModes: ['stale', 'wrong'] },
		index: { sessions: { enabled: true } },
	};
}

describe('AkmTab load → save round-trip', () => {
	it('preserves every modeled field (incl. rest/Tri/process) through load then save', () => {
		const input = representativeConfig();
		const loaded = load(input);
		const output = save(loaded);
		expect(output).toEqual(input);
	});

	it('round-trips the unmodeled forward-compat field via process `rest`', () => {
		const input = representativeConfig();
		const output = save(load(input)) as Record<string, unknown>;
		const reflect = (
			(
				(output.profiles as Record<string, unknown>).improve as Record<string, unknown>
			).default as Record<string, unknown>
		).processes as Record<string, unknown>;
		expect((reflect.reflect as Record<string, unknown>).experimentalFutureField).toEqual({
			nested: 'preserve-me',
			count: 7,
		});
	});

	it('round-trips an empty config to the minimal save shape', () => {
		const output = save(load({}));
		expect(output).toEqual({
			profiles: { llm: {}, agent: {}, improve: {} },
			defaults: {},
			embedding: { endpoint: '', model: '', dimension: 1536 },
			semanticSearchMode: 'auto',
			output: { format: 'json', detail: 'brief' },
		});
	});
});
