import { describe, it, expect } from 'vitest';
import { akmConfigToForm, formToAkmPayload, buildLlmEnginePayload } from './akm-config';
import {
	PROCESS_KEYS,
	DEFAULT_ENABLED,
	emptyFEntry,
	readFEntry,
	buildProcessConfig,
	optInt,
	optNum,
	type FEntry,
} from './improve-process-helpers';
import type { LlmEngine } from './profile-types';

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip fidelity guard for AkmTab.svelte (akm 0.9 schema).
//
// AkmTab.load() maps a raw akm config object into UI state via
// akmConfigToForm(); AkmTab.save() maps that UI state back into the akm
// payload via formToAkmPayload(). Both are the EXACT functions the component
// uses (extracted to akm-config.ts), as is the per-process improve mapping
// (readFEntry/buildProcessConfig). This suite drives them over a
// representative 0.9 config and asserts the save payload deep-equals the
// input — proving no field is silently dropped on the round trip — plus the
// 0.8→0.9 migration edges (single engines map, retired keys, llmEngine
// gating).
// ─────────────────────────────────────────────────────────────────────────────

const idGen = () => 'test-id';

function representativeConfig(): Record<string, unknown> {
	return {
		engines: {
			default: {
				kind: 'llm',
				endpoint: 'https://api.openai.com/v1/chat/completions',
				model: 'gpt-4o-mini',
				provider: 'openai',
				apiKey: '${AKM_LLM_API_KEY}',
				temperature: 0.2,
				maxTokens: 4096,
				timeoutMs: 30000,
				concurrency: 4,
				contextLength: 128000,
				supportsJsonSchema: true,
				enableThinking: true,
				extraParams: { top_p: 0.9 },
			},
			opencode: {
				kind: 'agent',
				platform: 'opencode',
				bin: 'opencode',
				args: ['run', '--model', 'gpt-4o'],
				workspace: '${PWD}',
				model: 'gpt-4o',
			},
			sdk: {
				kind: 'agent',
				platform: 'opencode-sdk',
				model: 'anthropic/claude-sonnet-4-5',
				workspace: '${PWD}',
				llmEngine: 'default',
			},
		},
		defaults: { llmEngine: 'default', engine: 'opencode', improveStrategy: 'default' },
		improve: {
			strategies: {
				default: {
					description: 'default improve strategy',
					limit: 30,
					processes: {
						reflect: {
							enabled: true,
							engine: 'default',
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
							judgment: { engine: 'default', timeoutMs: 9000 },
						},
					},
					sync: { enabled: true, push: false, message: 'akm improve sync' },
				},
			},
			utilityDecay: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 },
			eventRetentionDays: 90,
		},
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
		search: { minScore: 0.35, curateRerank: { enabled: true } },
		feedback: { requireReason: true, allowedFailureModes: ['stale', 'wrong'] },
		index: { sessions: { enabled: true } },
	};
}

describe('AkmTab load → save round-trip (akm 0.9)', () => {
	it('preserves every modeled field (incl. rest/Tri/process) through load then save', () => {
		const input = representativeConfig();
		const output = formToAkmPayload(akmConfigToForm(input, idGen));
		expect(output).toEqual(input);
	});

	it('round-trips the unmodeled forward-compat field via process `rest`', () => {
		const input = representativeConfig();
		const output = formToAkmPayload(akmConfigToForm(input, idGen)) as Record<string, unknown>;
		const processes = (
			(
				(output.improve as Record<string, unknown>).strategies as Record<string, unknown>
			).default as Record<string, unknown>
		).processes as Record<string, unknown>;
		expect((processes.reflect as Record<string, unknown>).experimentalFutureField).toEqual({
			nested: 'preserve-me',
			count: 7,
		});
	});

	it('round-trips an empty config to the minimal save shape', () => {
		const output = formToAkmPayload(akmConfigToForm({}, idGen));
		expect(output).toEqual({
			engines: {},
			defaults: {},
			improve: { strategies: {} },
			embedding: { endpoint: '', model: '', dimension: 1536 },
			semanticSearchMode: 'auto',
			output: { format: 'json', detail: 'brief' },
		});
	});

	it('keeps llmEngine out of the payload for non-sdk agent platforms', () => {
		const input = representativeConfig();
		const form = akmConfigToForm(input, idGen);
		const sdk = form.agentEngines.find((p) => p.name === 'sdk');
		if (!sdk) throw new Error('sdk agent engine not loaded');
		sdk.platform = 'claude'; // user flips the platform away from opencode-sdk
		const output = formToAkmPayload(form) as Record<string, unknown>;
		const engines = output.engines as Record<string, Record<string, unknown>>;
		expect(engines.sdk.platform).toBe('claude');
		expect(engines.sdk).not.toHaveProperty('llmEngine');
	});

	it('tags every saved engine with its kind', () => {
		const output = formToAkmPayload(akmConfigToForm(representativeConfig(), idGen)) as Record<string, unknown>;
		const engines = output.engines as Record<string, Record<string, unknown>>;
		expect(engines.default.kind).toBe('llm');
		expect(engines.opencode.kind).toBe('agent');
		expect(engines.sdk.kind).toBe('agent');
	});
});

describe('improve process mapping (0.8 → 0.9 migration edges)', () => {
	it('emptyFEntry seeds every process with the documented default enablement', () => {
		for (const k of PROCESS_KEYS) {
			const e = emptyFEntry(DEFAULT_ENABLED[k]);
			expect(e.enabled).toBe(DEFAULT_ENABLED[k]);
			expect(e.engine).toBe('');
			expect(e.judgment).toEqual({ engine: '', timeoutMs: '' });
		}
	});

	it('drops the retired mode/profile pair on read instead of passing it through rest', () => {
		const entry: FEntry = readFEntry(
			{ enabled: true, mode: 'llm', profile: 'default', engine: 'main', futureField: 1 },
			true,
		);
		expect(entry.engine).toBe('main');
		expect(entry.rest).toEqual({ futureField: 1 });
		const built = buildProcessConfig(entry);
		expect(built).not.toHaveProperty('mode');
		expect(built).not.toHaveProperty('profile');
		expect(built.engine).toBe('main');
	});

	it('builds a 0.9 judgment block with engine + timeoutMs only', () => {
		const entry = readFEntry(
			{ enabled: true, judgment: { engine: 'judge', timeoutMs: 5000 } },
			false,
		);
		expect(buildProcessConfig(entry).judgment).toEqual({ engine: 'judge', timeoutMs: 5000 });
	});
});

describe('LLM engine payload (0.9)', () => {
	const baseEngine: LlmEngine = {
		id: 'test-id',
		name: 'main',
		endpoint: 'http://x',
		model: 'm',
		provider: '',
		apiKey: '',
		showApiKey: false,
		temperature: '',
		maxTokens: '',
		timeoutMs: '',
		concurrency: '',
		contextLength: '',
		supportsJsonSchema: false,
		enableThinking: false,
		extraParams: '',
	};

	it('never emits the retired judgeModel / capabilities fields', () => {
		const out = buildLlmEnginePayload(baseEngine);
		expect(out).toEqual({ kind: 'llm', endpoint: 'http://x', model: 'm' });
	});

	it('surfaces invalid extraParams as a friendly error', () => {
		expect(() => buildLlmEnginePayload({ ...baseEngine, extraParams: 'not json' })).toThrow(
			/extraParams must be valid JSON/,
		);
	});

	// akm >= 0.9.8 fails closed at config load on extraParams keys that have a
	// first-class engine field (temperature, maxTokens, enableThinking,
	// reasoningEffort) — every akm command, including the boot check, then
	// exits 78 until the file is rewritten. The UI's extraParams box is
	// free-form JSON, so the builder lifts those keys onto the fields the way
	// akm's own `migrate apply` does instead of writing a config akm rejects.
	it('lifts legacy extraParams keys onto the first-class fields akm shadows them with', () => {
		const out = buildLlmEnginePayload({
			...baseEngine,
			extraParams: JSON.stringify({
				temperature: 0.2,
				max_tokens: 512,
				enable_thinking: true,
				'reasoning-effort': 'high',
				top_p: 0.9,
			}),
		});
		expect(out).toEqual({
			kind: 'llm',
			endpoint: 'http://x',
			model: 'm',
			temperature: 0.2,
			maxTokens: 512,
			enableThinking: true,
			reasoningEffort: 'high',
			extraParams: { top_p: 0.9 },
		});
	});

	it('drops a legacy extraParams key that duplicates the field, and omits an emptied extraParams', () => {
		const out = buildLlmEnginePayload({
			...baseEngine,
			temperature: '0.2',
			extraParams: JSON.stringify({ temperature: 0.2 }),
		});
		expect(out).toEqual({ kind: 'llm', endpoint: 'http://x', model: 'm', temperature: 0.2 });
	});

	it('refuses a legacy extraParams key that disagrees with the field rather than guessing', () => {
		expect(() =>
			buildLlmEnginePayload({
				...baseEngine,
				temperature: '0.7',
				extraParams: JSON.stringify({ temperature: 0.2 }),
			}),
		).toThrow(/extraParams\.temperature \(0\.2\) conflicts with the temperature field \(0\.7\)/);
	});
});

// Svelte 5 number inputs bind null when cleared (to_number('') === null), and
// the drawers' string-typed draft fields feed straight into optInt/optNum — a
// TypeError at s.trim() used to abort the whole AKM save.
describe('optInt / optNum — cleared and numeric inputs', () => {
	it('optInt maps null/undefined/empty to undefined', () => {
		expect(optInt(null)).toBeUndefined();
		expect(optInt(undefined)).toBeUndefined();
		expect(optInt('')).toBeUndefined();
		expect(optInt('   ')).toBeUndefined();
	});

	it('optInt integerizes numeric inputs and parses strings', () => {
		expect(optInt(42)).toBe(42);
		expect(optInt(7.9)).toBe(7);
		expect(optInt(NaN)).toBeUndefined();
		expect(optInt('30000')).toBe(30000);
		expect(optInt('not-a-number')).toBeUndefined();
	});

	it('optNum maps null/undefined/empty to undefined and passes numbers through', () => {
		expect(optNum(null)).toBeUndefined();
		expect(optNum(undefined)).toBeUndefined();
		expect(optNum('')).toBeUndefined();
		expect(optNum(0.7)).toBe(0.7);
		expect(optNum(NaN)).toBeUndefined();
		expect(optNum('0.2')).toBe(0.2);
	});
});
