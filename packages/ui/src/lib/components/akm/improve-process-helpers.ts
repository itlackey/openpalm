// Pure, framework-free helpers for AKM "improve" profiles.
//
// These constants + functions are used by BOTH the AkmTab orchestrator
// (load() reads raw akm config into UI state; save() builds the akm payload)
// AND the ImproveProfileDrawer (which renders the per-process controls and
// needs PROCESS_KEYS / PROCESS_HINTS / the FEntry shape). Keeping them here —
// a plain module, no class, no barrel — lets a vitest round-trip test exercise
// the exact same mapping the component uses, guarding save fidelity.

export type FMode = '' | 'llm' | 'agent' | 'sdk';
export type Tri = '' | 'on' | 'off'; // unset / enabled / disabled (for {enabled?} sub-objects)

export interface Judgment {
	mode: FMode;
	profile: string;
	timeoutMs: string;
}

export interface FEntry {
	enabled: boolean;
	mode: FMode;
	profile: string;
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
	rest: Record<string, unknown>; // forward-compat: preserve any field we don't model
}

// Process keys per akm ImproveProfileProcessesSchema (0.8.0). Each maps to which
// advanced fields are meaningful, so the drawer only shows relevant controls.
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
	if (typeof s === 'number') return isNaN(s) ? undefined : s;
	const n = parseFloat(s);
	return s.trim() === '' || isNaN(n) ? undefined : n;
}

export function optInt(s: string | number): number | undefined {
	if (typeof s === 'number') return isNaN(s) ? undefined : Math.trunc(s);
	const n = parseInt(s, 10);
	return s.trim() === '' || isNaN(n) ? undefined : n;
}

export function emptyFEntry(enabled: boolean): FEntry {
	return {
		enabled,
		mode: '',
		profile: '',
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
		judgment: { mode: '', profile: '', timeoutMs: '' },
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
	'mode',
	'profile',
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

export function readFEntry(raw: unknown, defaultEnabled: boolean): FEntry {
	const e = emptyFEntry(defaultEnabled);
	if (typeof raw === 'boolean') {
		e.enabled = raw;
		return e;
	}
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
		e.judgment = {
			mode: (j.mode as FMode) ?? '',
			profile: (j.profile as string) ?? '',
			timeoutMs: j.timeoutMs != null ? String(j.timeoutMs) : '',
		};
	}
	// preserve any field akm supports that this UI doesn't model
	for (const [k, v] of Object.entries(r)) if (!KNOWN_PROC_KEYS.has(k)) e.rest[k] = v;
	return e;
}

export function buildProcessConfig(e: FEntry): Record<string, unknown> {
	const out: Record<string, unknown> = { ...e.rest, enabled: e.enabled };
	if (e.mode) out.mode = e.mode;
	if (e.profile) out.profile = e.profile;
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
	if (e.judgment.mode) j.mode = e.judgment.mode;
	if (e.judgment.profile) j.profile = e.judgment.profile;
	if (e.judgment.timeoutMs !== '') j.timeoutMs = parseInt(e.judgment.timeoutMs, 10);
	if (Object.keys(j).length) out.judgment = j;
	return out;
}
