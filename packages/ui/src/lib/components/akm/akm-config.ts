// Pure config<->form mappers for the AKM Knowledge tab.
//
// AkmTab.svelte owns a large set of $state form fields. Previously the
// raw-config → form and form → payload mapping lived inline in load()/save()
// with dozens of `as Record<string, unknown>` casts and ad-hoc num()/triE()
// helpers. This module extracts that mapping into two pure functions —
// akmConfigToForm() and formToAkmPayload() — so the round trip is testable in
// isolation and the component just binds fields and calls these two functions.
//
// The per-process improve mapping is NOT duplicated here: it composes the
// existing improve-process-helpers (readFEntry / buildProcessConfig / …).
// Plain module — no class, no barrel, no Svelte runes.
import {
	PROCESS_KEYS,
	DEFAULT_ENABLED,
	optNum,
	optInt,
	readFEntry,
	buildProcessConfig,
	triFromEnabled,
	type Tri,
	type FEntry,
	type ProcKey,
} from './improve-process-helpers';
import type { LlmProfile, AgentProfile, ImproveProfile } from './profile-types';

// ── Typed form shapes (replace the inline casts) ─────────────────────────────

/** Embedding connection form fields (mirrors EmbeddingSection bindables). */
export interface EmbeddingForm {
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
}

/** Full AKM Knowledge-tab form state. */
export interface AkmForm {
	llmProfiles: LlmProfile[];
	defaultLlmProfile: string;
	agentProfiles: AgentProfile[];
	defaultAgentProfile: string;
	improveProfiles: ImproveProfile[];
	defaultImproveProfile: string;
	embedding: EmbeddingForm;
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

/** Generates fresh UI-list ids; overridable so tests stay deterministic. */
export type IdGen = () => string;
const defaultIdGen: IdGen = () => crypto.randomUUID();

// ── Small typed read helpers (narrow unknown JSON) ───────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const numStr = (v: unknown): string => (typeof v === 'number' ? String(v) : '');

// ── config → form ────────────────────────────────────────────────────────────

function llmProfileFromRaw(raw: Record<string, unknown>): Omit<LlmProfile, 'name' | 'id'> {
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
		structuredOutput: (asRecord(raw.capabilities)?.structuredOutput as boolean) ?? false,
		extraParams:
			raw.extraParams && typeof raw.extraParams === 'object'
				? JSON.stringify(raw.extraParams, null, 2)
				: '',
	};
}

function improveProfileFromRaw(name: string, raw: Record<string, unknown>, idGen: IdGen): ImproveProfile {
	const procs = asRecord(raw.processes) ?? {};
	const processes = {} as Record<ProcKey, FEntry>;
	for (const k of PROCESS_KEYS) processes[k] = readFEntry(procs[k], DEFAULT_ENABLED[k]);
	const sync = asRecord(raw.sync);
	return {
		id: idGen(),
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

/** Map a raw akm config object into UI form state. Pure. */
export function akmConfigToForm(config: Record<string, unknown>, idGen: IdGen = defaultIdGen): AkmForm {
	const rawProfiles = asRecord(config.profiles);

	const rawLlm = asRecord(rawProfiles?.llm);
	const llmProfiles: LlmProfile[] = rawLlm
		? Object.entries(rawLlm).map(([name, p]) => ({
				id: idGen(),
				name,
				...llmProfileFromRaw(asRecord(p) ?? {}),
			}))
		: [];

	const rawAgent = asRecord(rawProfiles?.agent);
	const agentProfiles: AgentProfile[] = rawAgent
		? Object.entries(rawAgent).map(([name, p]) => {
				const raw = asRecord(p) ?? {};
				return {
					id: idGen(),
					name,
					platform: (raw.platform as 'opencode' | 'claude' | 'opencode-sdk') ?? 'opencode',
					bin: (raw.bin as string) ?? '',
					args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '',
					workspace: (raw.workspace as string) ?? '',
					model: (raw.model as string) ?? '',
				};
			})
		: [];

	const rawImprove = asRecord(rawProfiles?.improve);
	const improveProfiles: ImproveProfile[] = rawImprove
		? Object.entries(rawImprove).map(([name, p]) => improveProfileFromRaw(name, asRecord(p) ?? {}, idGen))
		: [];

	const rawDefaults = asRecord(config.defaults);

	const e = asRecord(config.embedding);
	const ollamaOpts = asRecord(e?.ollamaOptions);
	const embedding: EmbeddingForm = {
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

	const output = asRecord(config.output);
	const improveTop = asRecord(config.improve);
	const decay = asRecord(improveTop?.utilityDecay);
	const search = asRecord(config.search);
	const feedback = asRecord(config.feedback);

	return {
		llmProfiles,
		defaultLlmProfile: (rawDefaults?.llm as string) ?? '',
		agentProfiles,
		defaultAgentProfile: (rawDefaults?.agent as string) ?? '',
		improveProfiles,
		defaultImproveProfile: (rawDefaults?.improve as string) ?? '',
		embedding,
		semanticSearchMode: (config.semanticSearchMode as 'auto' | 'off') ?? 'auto',
		outputFormat: (output?.format as 'json' | 'yaml' | 'text') ?? 'json',
		outputDetail: (output?.detail as 'brief' | 'normal' | 'full') ?? 'brief',
		imHalfLife: numStr(decay?.halfLifeDays),
		imFeedbackBoost: numStr(decay?.feedbackStabilityBoost),
		imEventRetention: numStr(improveTop?.eventRetentionDays),
		searchMinScore: numStr(search?.minScore),
		searchCurateRerank: triFromEnabled(search?.curateRerank),
		fbRequireReason:
			typeof feedback?.requireReason === 'boolean' ? (feedback.requireReason ? 'on' : 'off') : '',
		fbFailureModes: Array.isArray(feedback?.allowedFailureModes)
			? (feedback?.allowedFailureModes as string[]).join(', ')
			: '',
		indexJson: config.index && typeof config.index === 'object' ? JSON.stringify(config.index, null, 2) : '',
	};
}

// ── form → payload ───────────────────────────────────────────────────────────

/**
 * Build the akm save payload for one LLM profile. Throws a friendly error when
 * extraParams is not a valid JSON object so save() can surface it.
 */
export function buildLlmProfilePayload(p: LlmProfile): Record<string, unknown> {
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

/**
 * Map UI form state back into the akm save payload. Pure (may throw on invalid
 * extraParams / index JSON, exactly as the previous inline save() did).
 */
export function formToAkmPayload(form: AkmForm): Record<string, unknown> {
	const profilesLlm: Record<string, unknown> = {};
	for (const p of form.llmProfiles) {
		if (p.name.trim()) profilesLlm[p.name.trim()] = buildLlmProfilePayload(p);
	}

	const profilesAgent: Record<string, unknown> = {};
	for (const p of form.agentProfiles) {
		if (!p.name.trim()) continue;
		const entry: Record<string, unknown> = { platform: p.platform };
		if (p.bin) entry.bin = p.bin;
		if (p.args) entry.args = p.args.split(/\s+/).filter(Boolean);
		if (p.workspace) entry.workspace = p.workspace;
		if (p.model) entry.model = p.model;
		profilesAgent[p.name.trim()] = entry;
	}

	const profilesImprove: Record<string, unknown> = {};
	for (const ip of form.improveProfiles) {
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

	const emb = form.embedding;
	const embPayload: Record<string, unknown> = {
		endpoint: emb.endpoint,
		model: emb.model,
		dimension: emb.dimension,
	};
	if (emb.provider) embPayload.provider = emb.provider;
	if (emb.apiKey) embPayload.apiKey = emb.apiKey;
	if (emb.localModel) embPayload.localModel = emb.localModel;
	const bs = optInt(emb.batchSize);
	if (bs !== undefined) embPayload.batchSize = bs;
	const cs = optInt(emb.chunkSize);
	if (cs !== undefined) embPayload.chunkSize = cs;
	const ecl = optInt(emb.contextLength);
	if (ecl !== undefined) embPayload.contextLength = ecl;
	const numCtx = optInt(emb.ollamaNumCtx);
	if (numCtx !== undefined) embPayload.ollamaOptions = { num_ctx: numCtx };

	const defaultsPayload: Record<string, unknown> = {};
	if (form.defaultLlmProfile) defaultsPayload.llm = form.defaultLlmProfile;
	if (form.defaultAgentProfile) defaultsPayload.agent = form.defaultAgentProfile;
	if (form.defaultImproveProfile) defaultsPayload.improve = form.defaultImproveProfile;

	const improveTopPayload: Record<string, unknown> = {};
	const decayPayload: Record<string, unknown> = {};
	const hl = optNum(form.imHalfLife);
	if (hl !== undefined) decayPayload.halfLifeDays = hl;
	const fb = optNum(form.imFeedbackBoost);
	if (fb !== undefined) decayPayload.feedbackStabilityBoost = fb;
	if (Object.keys(decayPayload).length) improveTopPayload.utilityDecay = decayPayload;
	const er = optNum(form.imEventRetention);
	if (er !== undefined) improveTopPayload.eventRetentionDays = er;

	const searchPayload: Record<string, unknown> = {};
	const ms = optNum(form.searchMinScore);
	if (ms !== undefined) searchPayload.minScore = ms;
	if (form.searchCurateRerank) searchPayload.curateRerank = { enabled: form.searchCurateRerank === 'on' };

	const feedbackPayload: Record<string, unknown> = {};
	if (form.fbRequireReason) feedbackPayload.requireReason = form.fbRequireReason === 'on';
	const modes = form.fbFailureModes
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (modes.length) feedbackPayload.allowedFailureModes = modes;

	let indexPayload: unknown;
	if (form.indexJson.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(form.indexJson);
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
		semanticSearchMode: form.semanticSearchMode,
		output: { format: form.outputFormat, detail: form.outputDetail },
		...(Object.keys(improveTopPayload).length ? { improve: improveTopPayload } : {}),
		...(Object.keys(searchPayload).length ? { search: searchPayload } : {}),
		...(Object.keys(feedbackPayload).length ? { feedback: feedbackPayload } : {}),
		...(indexPayload !== undefined ? { index: indexPayload } : {}),
	};
}
