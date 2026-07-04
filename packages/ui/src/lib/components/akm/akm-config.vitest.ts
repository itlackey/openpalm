import { describe, it, expect } from 'vitest';
import { akmConfigToForm, formToAkmPayload } from './akm-config';

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip fidelity for the extracted pure config<->form mappers.
//
// akmConfigToForm() maps a raw akm config object into UI form state;
// formToAkmPayload() maps that form state back into the akm save payload.
// This test asserts config -> form -> payload is stable for representative
// configs and that partial/missing fields resolve to the documented defaults.
//
// A deterministic id generator is injected so the profile arrays are stable;
// ids never appear in the payload, so they don't affect the round trip — the
// injection just keeps the form comparison reproducible.
// ─────────────────────────────────────────────────────────────────────────────

const idGen = () => 'test-id';

// Representative config exercising embedding / behavior / search / feedback /
// defaults plus profiles (incl. an unmodeled forward-compat process field).
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

describe('akmConfigToForm → formToAkmPayload round-trip', () => {
	it('preserves every modeled field through form then payload', () => {
		const input = representativeConfig();
		const form = akmConfigToForm(input, idGen);
		const output = formToAkmPayload(form);
		expect(output).toEqual(input);
	});

	it('round-trips the unmodeled forward-compat process field via `rest`', () => {
		const input = representativeConfig();
		const output = formToAkmPayload(akmConfigToForm(input, idGen)) as Record<string, unknown>;
		const processes = (
			((output.profiles as Record<string, unknown>).improve as Record<string, unknown>)
				.default as Record<string, unknown>
		).processes as Record<string, unknown>;
		expect((processes.reflect as Record<string, unknown>).experimentalFutureField).toEqual({
			nested: 'preserve-me',
			count: 7,
		});
	});

	it('maps an empty config to the minimal save shape with defaults', () => {
		const output = formToAkmPayload(akmConfigToForm({}, idGen));
		expect(output).toEqual({
			profiles: { llm: {}, agent: {}, improve: {} },
			defaults: {},
			embedding: { endpoint: '', model: '', dimension: 1536 },
			semanticSearchMode: 'auto',
			output: { format: 'json', detail: 'brief' },
		});
	});

	it('applies the same defaults as today for partial / missing fields', () => {
		const form = akmConfigToForm(
			{
				profiles: {
					improve: {
						// improve profile missing limit/autoAccept → defaults 25 / 0
						sparse: { processes: {} },
					},
				},
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
		expect(form.improveProfiles[0].limit).toBe(25);
		expect(form.improveProfiles[0].autoAccept).toBe(0);
	});
});
