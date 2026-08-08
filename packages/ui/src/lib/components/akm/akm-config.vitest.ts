import { describe, it, expect } from 'vitest';
import { akmConfigToForm, formToAkmPayload } from './akm-config';

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip fidelity for the extracted pure config<->form mappers (akm 0.9).
//
// akmConfigToForm() maps a raw akm config object into UI form state;
// formToAkmPayload() maps that form state back into the akm save payload.
// This test asserts config -> form -> payload is stable for representative
// configs and that partial/missing fields resolve to the documented defaults.
//
// A deterministic id generator is injected so the engine/strategy arrays are
// stable; ids never appear in the payload, so they don't affect the round trip
// — the injection just keeps the form comparison reproducible.
// ─────────────────────────────────────────────────────────────────────────────

const idGen = () => 'test-id';

// Representative 0.9 config exercising engines (both kinds) / strategies /
// embedding / behavior / search / feedback / defaults plus an unmodeled
// forward-compat process field.
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
				timeoutMs: 120000,
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

describe('akmConfigToForm → formToAkmPayload round-trip (akm 0.9)', () => {
	it('preserves every modeled field through form then payload', () => {
		const input = representativeConfig();
		const form = akmConfigToForm(input, idGen);
		const output = formToAkmPayload(form);
		expect(output).toEqual(input);
	});

	it('partitions the single engines map into llm and agent sections by kind', () => {
		const form = akmConfigToForm(representativeConfig(), idGen);
		expect(form.llmEngines.map((p) => p.name)).toEqual(['default']);
		expect(form.agentEngines.map((p) => p.name)).toEqual(['opencode', 'sdk']);
		expect(form.agentEngines[1].llmEngine).toBe('default');
	});

	it('round-trips the unmodeled forward-compat process field via `rest`', () => {
		const input = representativeConfig();
		const output = formToAkmPayload(akmConfigToForm(input, idGen)) as Record<string, unknown>;
		const processes = (
			((output.improve as Record<string, unknown>).strategies as Record<string, unknown>)
				.default as Record<string, unknown>
		).processes as Record<string, unknown>;
		expect((processes.reflect as Record<string, unknown>).experimentalFutureField).toEqual({
			nested: 'preserve-me',
			count: 7,
		});
	});

	it('drops the retired 0.8 process mode/profile pair instead of round-tripping it', () => {
		const input = representativeConfig();
		const improve = input.improve as Record<string, unknown>;
		const strategy = (improve.strategies as Record<string, Record<string, unknown>>).default;
		(strategy.processes as Record<string, Record<string, unknown>>).reflect.mode = 'llm';
		(strategy.processes as Record<string, Record<string, unknown>>).reflect.profile = 'default';
		const output = formToAkmPayload(akmConfigToForm(input, idGen)) as Record<string, unknown>;
		const reflect = (
			(
				((output.improve as Record<string, unknown>).strategies as Record<string, unknown>)
					.default as Record<string, unknown>
			).processes as Record<string, Record<string, unknown>>
		).reflect;
		expect(reflect).not.toHaveProperty('mode');
		expect(reflect).not.toHaveProperty('profile');
	});

	it('throws when an LLM engine and an agent engine share a name', () => {
		const form = akmConfigToForm(representativeConfig(), idGen);
		form.agentEngines[0].name = 'default'; // collides with the llm engine
		expect(() => formToAkmPayload(form)).toThrow(/used by both/);
	});

	it('maps an empty config to the minimal save shape with defaults', () => {
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

	it('applies the same defaults as today for partial / missing fields', () => {
		const form = akmConfigToForm(
			{
				improve: {
					strategies: {
						// strategy missing limit → default 25
						sparse: { processes: {} },
					},
				},
				// engine entry without kind → treated as an llm engine
				engines: { legacy: { endpoint: 'http://x', model: 'm' } },
				// embedding present but missing dimension → default 1536
				embedding: { endpoint: 'http://x', model: 'm' },
				// output present but missing detail → default brief
				output: { format: 'yaml' },
			},
			idGen,
		);

		expect(form.embedding.dimension).toBe(1536);
		expect(form.semanticSearchMode).toBe('auto');
		expect(form.outputFormat).toBe('yaml');
		expect(form.outputDetail).toBe('brief');
		expect(form.improveStrategies[0].limit).toBe(25);
		expect(form.llmEngines.map((p) => p.name)).toEqual(['legacy']);
		expect(form.agentEngines).toEqual([]);
	});
});
