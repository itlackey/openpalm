// Pure, framework-free helpers for AKM "improve" strategies (akm 0.9 schema).
//
// These constants + functions are used by BOTH the AkmTab orchestrator
// (load() reads raw akm config into UI state; save() builds the akm payload)
// AND the ImproveProfileDrawer (which renders the per-process controls and
// needs PROCESS_KEYS / PROCESS_HINTS / the FEntry shape). Keeping them here —
// a plain module, no class, no barrel — lets a vitest round-trip test exercise
// the exact same mapping the component uses, guarding save fidelity.

export type Tri = '' | 'on' | 'off'; // unset / enabled / disabled (for {enabled?} sub-objects)

export interface Judgment {
	engine: string;
	timeoutMs: string;
}

export interface FEntry {
	enabled: boolean;
	// akm 0.9: a single engine name replaces the 0.8 mode+profile pair.
	engine: string;
	timeoutMs: string;
	// advanced (akm ImproveProcessConfigSchema) — all optional
	allowedTypes: string; // comma-separated
	qualityGate: Tri; // reflect/distill
	contradictionDetection: Tri; // consolidate
	defaultSince: string;
	maxTotalChars: string;
	maxChunkSize: string; // extract
	applyMode: '' | 'queue' | 'promote';
	policy: string;
	maxAcceptsPerRun: string;
	maxDiffLines: string;
	rejectEmpty: boolean; // triage
	judgment: Judgment; // triage
	rest: Record<string, unknown>; // forward-compat: preserve any field we don't model (e.g. model / llm overrides)
}

// Process keys per akm improve.strategies.<name>.processes (0.9.0). Each maps
// to which advanced fields are meaningful, so the drawer only shows relevant
// controls.
export const PROCESS_KEYS = [
	'reflect',
	'distill',
	'consolidate',
	'validation',
	'memoryInference',
	'graphExtraction',
	'extract',
	'triage',
] as const;
export type ProcKey = (typeof PROCESS_KEYS)[number];

export const PROCESS_HINTS: Record<ProcKey, string> = {
	reflect: 'Propose stash updates via self-reflection',
	distill: 'Quality-judge and distill feedback',
	consolidate: 'Deduplicate and merge overlapping memories',
	validation: 'Third-model confidence and staleness scoring',
	memoryInference: 'Derive structured memories from pending files',
	graphExtraction: 'Extract entities and relations for graph search',
	extract: 'Read session logs and queue insight proposals',
	triage: 'Auto-review and accept/promote queued proposals',
};

export const DEFAULT_ENABLED: Record<ProcKey, boolean> = {
	reflect: true,
	distill: true,
	consolidate: false,
	validation: false,
	memoryInference: true,
	graphExtraction: true,
	extract: true,
	triage: false,
};

export function optNum(s: string | number): number | undefined {
	if (typeof s === 'number') return Number.isNaN(s) ? undefined : s;
	const n = parseFloat(s);
	return s.trim() === '' || Number.isNaN(n) ? undefined : n;
}

export function optInt(s: string | number): number | undefined {
	if (typeof s === 'number') return Number.isNaN(s) ? undefined : Math.trunc(s);
	const n = parseInt(s, 10);
	return s.trim() === '' || Number.isNaN(n) ? undefined : n;
}

export function emptyFEntry(enabled: boolean): FEntry {
	return {
		enabled,
		engine: '',
		timeoutMs: '',
		allowedTypes: '',
		qualityGate: '',
		contradictionDetection: '',
		defaultSince: '',
		maxTotalChars: '',
		maxChunkSize: '',
		applyMode: '',
		policy: '',
		maxAcceptsPerRun: '',
		maxDiffLines: '',
		rejectEmpty: false,
		judgment: { engine: '', timeoutMs: '' },
		rest: {},
	};
}

export const triFromEnabled = (o: unknown): Tri =>
	typeof o === 'object' && o !== null && 'enabled' in (o as Record<string, unknown>)
		? (o as Record<string, unknown>).enabled
			? 'on'
			: 'off'
		: '';

// Known per-process keys we model explicitly; everything else round-trips via `rest`.
const KNOWN_PROC_KEYS = new Set([
	'enabled',
	'engine',
	'timeoutMs',
	'allowedTypes',
	'qualityGate',
	'contradictionDetection',
	'defaultSince',
	'maxTotalChars',
	'maxChunkSize',
	'applyMode',
	'policy',
	'maxAcceptsPerRun',
	'maxDiffLines',
	'rejectEmpty',
	'judgment',
]);

// Retired 0.8 keys (mode/profile pair → engine in 0.9). Recognized so a
// pre-upgrade config is DROPPED on load rather than round-tripped via `rest`
// (akm 0.9 hard-rejects them).
const RETIRED_PROC_KEYS = new Set(['mode', 'profile']);

// config.json is operator-editable, so a field can hold any JSON type. Every
// FEntry string field must actually BE a string: a non-string that survives the
// read is written straight back out by buildProcessConfig, where the endpoint
// rejects the whole save (engine/policy) or akm rejects the config. Dropping the
// bad value keeps the form saveable and loses nothing a valid config had.
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function readFEntry(raw: unknown, defaultEnabled: boolean): FEntry {
	const e = emptyFEntry(defaultEnabled);
	if (typeof raw === 'boolean') {
		e.enabled = raw;
		return e;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return e;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === 'boolean') e.enabled = r.enabled;
	e.engine = str(r.engine);
	e.timeoutMs = r.timeoutMs != null ? String(r.timeoutMs) : '';
	e.allowedTypes = Array.isArray(r.allowedTypes) ? (r.allowedTypes as string[]).join(', ') : '';
	e.qualityGate = triFromEnabled(r.qualityGate);
	e.contradictionDetection = triFromEnabled(r.contradictionDetection);
	e.defaultSince = str(r.defaultSince);
	e.maxTotalChars = r.maxTotalChars != null ? String(r.maxTotalChars) : '';
	e.maxChunkSize = r.maxChunkSize != null ? String(r.maxChunkSize) : '';
	// applyMode is an enum, not free text — an out-of-range string is rejected by
	// the endpoint's APPLY_MODES check, so only the two valid values survive.
	e.applyMode = r.applyMode === 'queue' || r.applyMode === 'promote' ? r.applyMode : '';
	e.policy = str(r.policy);
	e.maxAcceptsPerRun = r.maxAcceptsPerRun != null ? String(r.maxAcceptsPerRun) : '';
	e.maxDiffLines = r.maxDiffLines != null ? String(r.maxDiffLines) : '';
	e.rejectEmpty = r.rejectEmpty === true;
	if (typeof r.judgment === 'object' && r.judgment !== null) {
		const j = r.judgment as Record<string, unknown>;
		e.judgment = {
			engine: str(j.engine),
			timeoutMs: j.timeoutMs != null ? String(j.timeoutMs) : '',
		};
	}
	// preserve any field akm supports that this UI doesn't model — but never the
	// retired 0.8 mode/profile pair, which akm 0.9 rejects
	for (const [k, v] of Object.entries(r))
		if (!KNOWN_PROC_KEYS.has(k) && !RETIRED_PROC_KEYS.has(k)) e.rest[k] = v;
	return e;
}

export function buildProcessConfig(e: FEntry): Record<string, unknown> {
	const out: Record<string, unknown> = { ...e.rest, enabled: e.enabled };
	if (e.engine) out.engine = e.engine;
	if (e.timeoutMs !== '') out.timeoutMs = parseInt(e.timeoutMs, 10);
	const types = e.allowedTypes
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (types.length) out.allowedTypes = types;
	if (e.qualityGate) out.qualityGate = { enabled: e.qualityGate === 'on' };
	if (e.contradictionDetection) out.contradictionDetection = { enabled: e.contradictionDetection === 'on' };
	if (e.defaultSince) out.defaultSince = e.defaultSince;
	const mtc = optInt(e.maxTotalChars);
	if (mtc !== undefined) out.maxTotalChars = mtc;
	const mcs = optInt(e.maxChunkSize);
	if (mcs !== undefined) out.maxChunkSize = mcs;
	if (e.applyMode) out.applyMode = e.applyMode;
	if (e.policy) out.policy = e.policy;
	const mapr = optInt(e.maxAcceptsPerRun);
	if (mapr !== undefined) out.maxAcceptsPerRun = mapr;
	const mdl = optInt(e.maxDiffLines);
	if (mdl !== undefined) out.maxDiffLines = mdl;
	if (e.rejectEmpty) out.rejectEmpty = true;
	const j: Record<string, unknown> = {};
	if (e.judgment.engine) j.engine = e.judgment.engine;
	if (e.judgment.timeoutMs !== '') j.timeoutMs = parseInt(e.judgment.timeoutMs, 10);
	if (Object.keys(j).length) out.judgment = j;
	return out;
}
