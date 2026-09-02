// Pure config<->form mappers for the AKM Knowledge tab (akm 0.9 schema).
//
// AkmTab.svelte owns a large set of $state form fields. Previously the
// raw-config → form and form → payload mapping lived inline in load()/save()
// with dozens of `as Record<string, unknown>` casts and ad-hoc num()/triE()
// helpers. This module extracts that mapping into two pure functions —
// akmConfigToForm() and formToAkmPayload() — so the round trip is testable in
// isolation and the component just binds fields and calls these two functions.
//
// akm 0.9: LLM + agent engines share ONE `engines.<name>` map partitioned by
// `kind`; improve strategies live under `improve.strategies.<name>`; defaults
// are `defaults.llmEngine` / `defaults.engine` / `defaults.improveStrategy`.
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
import type { LlmEngine, AgentEngine, ImproveStrategy, AgentPlatform } from './profile-types';

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
	llmEngines: LlmEngine[];
	defaultLlmEngine: string;
	agentEngines: AgentEngine[];
	defaultAgentEngine: string;
	improveStrategies: ImproveStrategy[];
	defaultImproveStrategy: string;
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

function llmEngineFromRaw(raw: Record<string, unknown>): Omit<LlmEngine, 'name' | 'id'> {
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
		supportsJsonSchema: (raw.supportsJsonSchema as boolean) ?? false,
		enableThinking: (raw.enableThinking as boolean) ?? false,
		extraParams:
			raw.extraParams && typeof raw.extraParams === 'object'
				? JSON.stringify(raw.extraParams, null, 2)
				: '',
	};
}

function agentEngineFromRaw(name: string, raw: Record<string, unknown>, idGen: IdGen): AgentEngine {
	return {
		id: idGen(),
		name,
		platform: (raw.platform as AgentPlatform) ?? 'opencode',
		bin: (raw.bin as string) ?? '',
		args: Array.isArray(raw.args) ? (raw.args as string[]).join(' ') : '',
		workspace: (raw.workspace as string) ?? '',
		model: (raw.model as string) ?? '',
		timeoutMs: raw.timeoutMs != null ? String(raw.timeoutMs) : '',
		llmEngine: (raw.llmEngine as string) ?? '',
	};
}

function improveStrategyFromRaw(name: string, raw: Record<string, unknown>, idGen: IdGen): ImproveStrategy {
	const procs = asRecord(raw.processes) ?? {};
	const processes = {} as Record<ProcKey, FEntry>;
	for (const k of PROCESS_KEYS) processes[k] = readFEntry(procs[k], DEFAULT_ENABLED[k]);
	const sync = asRecord(raw.sync);
	return {
		id: idGen(),
		name,
		description: (raw.description as string) ?? '',
		limit: typeof raw.limit === 'number' ? raw.limit : 25,
		processes,
		syncEnabled: triFromEnabled(sync ? { enabled: sync.enabled } : undefined),
		syncPush: triFromEnabled(sync ? { enabled: sync.push } : undefined),
		syncMessage: (sync?.message as string) ?? '',
	};
}

/** Map a raw akm config object into UI form state. Pure. */
export function akmConfigToForm(config: Record<string, unknown>, idGen: IdGen = defaultIdGen): AkmForm {
	// One engines map, partitioned into the two UI sections by `kind`.
	const rawEngines = asRecord(config.engines);
	const llmEngines: LlmEngine[] = [];
	const agentEngines: AgentEngine[] = [];
	if (rawEngines) {
		for (const [name, entry] of Object.entries(rawEngines)) {
			const raw = asRecord(entry) ?? {};
			if (raw.kind === 'agent') agentEngines.push(agentEngineFromRaw(name, raw, idGen));
			else llmEngines.push({ id: idGen(), name, ...llmEngineFromRaw(raw) });
		}
	}

	const improveTop = asRecord(config.improve);
	const rawStrategies = asRecord(improveTop?.strategies);
	const improveStrategies: ImproveStrategy[] = rawStrategies
		? Object.entries(rawStrategies).map(([name, s]) => improveStrategyFromRaw(name, asRecord(s) ?? {}, idGen))
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
	const decay = asRecord(improveTop?.utilityDecay);
	const search = asRecord(config.search);
	const feedback = asRecord(config.feedback);
	const rawFbModes = feedback?.allowedFailureModes;
	const fbModes = Array.isArray(rawFbModes) ? (rawFbModes as string[]).join(', ') : '';

	return {
		llmEngines,
		defaultLlmEngine: (rawDefaults?.llmEngine as string) ?? '',
		agentEngines,
		defaultAgentEngine: (rawDefaults?.engine as string) ?? '',
		improveStrategies,
		defaultImproveStrategy: (rawDefaults?.improveStrategy as string) ?? '',
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
		fbFailureModes: fbModes,
		indexJson: config.index && typeof config.index === 'object' ? JSON.stringify(config.index, null, 2) : '',
	};
}

// ── form → payload ───────────────────────────────────────────────────────────

/**
 * extraParams keys akm refuses at config load because a first-class engine
 * field shadows them (akm 0.9.8, `LIFTABLE_EXTRA_PARAMS_KEYS`), keyed by akm's
 * normalization of the raw key (lower-case, non-alphanumerics dropped) so
 * `max_tokens`, `maxTokens` and `MAX-TOKENS` all resolve to the same field.
 */
const LIFTED_EXTRA_PARAM_FIELDS: Record<string, 'temperature' | 'maxTokens' | 'enableThinking' | 'reasoningEffort'> = {
	temperature: 'temperature',
	maxtokens: 'maxTokens',
	enablethinking: 'enableThinking',
	reasoningeffort: 'reasoningEffort',
};

const normalizeExtraParamKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Move legacy extraParams keys onto the first-class engine fields, the way
 * akm's own `migrate apply` lift does, so the UI never writes a config akm
 * fails closed on. A key whose field is already set to a different value is
 * an error rather than a guess — akm refuses that config too.
 */
function liftLegacyExtraParams(
	name: string,
	out: Record<string, unknown>,
	extraParams: Record<string, unknown>,
): Record<string, unknown> {
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(extraParams)) {
		const field = LIFTED_EXTRA_PARAM_FIELDS[normalizeExtraParamKey(key)];
		if (!field) {
			rest[key] = value;
			continue;
		}
		if (out[field] !== undefined && out[field] !== value)
			throw new Error(
				`LLM engine "${name}": extraParams.${key} (${JSON.stringify(value)}) conflicts with the ${field} field (${JSON.stringify(out[field])}) — set it in one place`,
			);
		out[field] = value;
	}
	return rest;
}

/**
 * Build the akm save payload for one LLM engine (engines.<name>, kind "llm").
 * Throws a friendly error when extraParams is not a valid JSON object so
 * save() can surface it.
 */
export function buildLlmEnginePayload(p: LlmEngine): Record<string, unknown> {
	const out: Record<string, unknown> = { kind: 'llm', endpoint: p.endpoint, model: p.model };
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
	if (p.supportsJsonSchema) out.supportsJsonSchema = true;
	if (p.enableThinking) out.enableThinking = true;
	if (p.extraParams.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(p.extraParams);
		} catch {
			throw new Error(`LLM engine "${p.name}": extraParams must be valid JSON`);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(`LLM engine "${p.name}": extraParams must be a JSON object`);
		const rest = liftLegacyExtraParams(p.name, out, parsed as Record<string, unknown>);
		if (Object.keys(rest).length > 0) out.extraParams = rest;
	}
	return out;
}

/**
 * Map UI form state back into the akm save payload. Pure (may throw on invalid
 * extraParams / index JSON or on an LLM/agent engine name collision, exactly
 * as save() expects to surface).
 */
export function formToAkmPayload(form: AkmForm): Record<string, unknown> {
	// LLM + agent engines share ONE engines map — a name can only exist once.
	const engines: Record<string, unknown> = {};
	for (const p of form.llmEngines) {
		if (p.name.trim()) engines[p.name.trim()] = buildLlmEnginePayload(p);
	}
	for (const p of form.agentEngines) {
		const name = p.name.trim();
		if (!name) continue;
		if (name in engines)
			throw new Error(`Engine name "${name}" is used by both an LLM engine and an agent engine — names must be unique`);
		const entry: Record<string, unknown> = { kind: 'agent', platform: p.platform };
		if (p.bin) entry.bin = p.bin;
		if (p.args) entry.args = p.args.split(/\s+/).filter(Boolean);
		if (p.workspace) entry.workspace = p.workspace;
		if (p.model) entry.model = p.model;
		const to = optInt(p.timeoutMs);
		if (to !== undefined) entry.timeoutMs = to;
		if (p.platform === 'opencode-sdk' && p.llmEngine) entry.llmEngine = p.llmEngine;
		engines[name] = entry;
	}

	const strategies: Record<string, unknown> = {};
	for (const st of form.improveStrategies) {
		if (!st.name.trim()) continue;
		const processes: Record<string, unknown> = {};
		for (const k of PROCESS_KEYS) processes[k] = buildProcessConfig(st.processes[k]);
		const entry: Record<string, unknown> = { limit: st.limit, processes };
		if (st.description) entry.description = st.description;
		const sync: Record<string, unknown> = {};
		if (st.syncEnabled) sync.enabled = st.syncEnabled === 'on';
		if (st.syncPush) sync.push = st.syncPush === 'on';
		if (st.syncMessage.trim()) sync.message = st.syncMessage.trim();
		if (Object.keys(sync).length) entry.sync = sync;
		strategies[st.name.trim()] = entry;
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
	if (form.defaultLlmEngine) defaultsPayload.llmEngine = form.defaultLlmEngine;
	if (form.defaultAgentEngine) defaultsPayload.engine = form.defaultAgentEngine;
	if (form.defaultImproveStrategy) defaultsPayload.improveStrategy = form.defaultImproveStrategy;

	// akm 0.9: strategies live INSIDE the top-level improve block, next to the
	// global tuning knobs.
	const improvePayload: Record<string, unknown> = { strategies };
	const decayPayload: Record<string, unknown> = {};
	const hl = optNum(form.imHalfLife);
	if (hl !== undefined) decayPayload.halfLifeDays = hl;
	const fb = optNum(form.imFeedbackBoost);
	if (fb !== undefined) decayPayload.feedbackStabilityBoost = fb;
	if (Object.keys(decayPayload).length) improvePayload.utilityDecay = decayPayload;
	const er = optNum(form.imEventRetention);
	if (er !== undefined) improvePayload.eventRetentionDays = er;

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
		engines,
		defaults: defaultsPayload,
		improve: improvePayload,
		embedding: embPayload,
		semanticSearchMode: form.semanticSearchMode,
		output: { format: form.outputFormat, detail: form.outputDetail },
		...(Object.keys(searchPayload).length ? { search: searchPayload } : {}),
		...(Object.keys(feedbackPayload).length ? { feedback: feedbackPayload } : {}),
		...(indexPayload !== undefined ? { index: indexPayload } : {}),
	};
}
