import { describe, it, expect } from 'vitest';
import { resolveDefaultLlmEngine } from './+server';

// ─────────────────────────────────────────────────────────────────────────────
// Wizard-prefill resolution against the akm 0.9 `engines` map.
//
// Two readers parse this same config.json — this one (setup prefill) and the
// AKM tab's mapper (lib/components/akm/akm-config.ts). akm-config.ts routes an
// entry to the agent section only when `kind === 'agent'`, so anything else,
// including a `kind`-less entry, is an LLM engine to it. This reader must agree:
// disagreeing meant a hand-written config that omits the (schema-required) kind
// showed its engine in the AKM tab while the wizard reported no LLM configured
// and prefilled blanks over it.
// ─────────────────────────────────────────────────────────────────────────────

const llm = { kind: 'llm', endpoint: 'http://h/v1/chat/completions', model: 'qwen', provider: 'ollama' };

describe('resolveDefaultLlmEngine', () => {
	it('resolves the engine named by defaults.llmEngine', () => {
		const engine = resolveDefaultLlmEngine({
			engines: { default: llm, fast: { ...llm, model: 'fast-model' } },
			defaults: { llmEngine: 'fast' },
		});
		expect(engine?.model).toBe('fast-model');
	});

	it('falls back to engines.default when defaults.llmEngine is unset', () => {
		expect(resolveDefaultLlmEngine({ engines: { default: llm } })?.model).toBe('qwen');
	});

	it('falls back to engines.default when defaults.llmEngine names a missing engine', () => {
		expect(
			resolveDefaultLlmEngine({ engines: { default: llm }, defaults: { llmEngine: 'gone' } })?.model,
		).toBe('qwen');
	});

	it('treats a kind-less entry as an llm engine, matching the AKM tab reader', () => {
		const engine = resolveDefaultLlmEngine({
			engines: { default: { endpoint: 'http://x/v1/chat/completions', model: 'no-kind' } },
		});
		expect(engine?.model).toBe('no-kind');
	});

	it('never resolves an agent engine, by name or by fallback', () => {
		const agent = { kind: 'agent', platform: 'opencode' };
		expect(
			resolveDefaultLlmEngine({ engines: { reviewer: agent }, defaults: { llmEngine: 'reviewer' } }),
		).toBeUndefined();
		expect(resolveDefaultLlmEngine({ engines: { default: agent } })).toBeUndefined();
	});

	it('skips a named agent engine but still falls back to a usable default', () => {
		const engine = resolveDefaultLlmEngine({
			engines: { default: llm, reviewer: { kind: 'agent', platform: 'opencode' } },
			defaults: { llmEngine: 'reviewer' },
		});
		expect(engine?.model).toBe('qwen');
	});

	it('returns undefined when no engines are configured', () => {
		expect(resolveDefaultLlmEngine({})).toBeUndefined();
		expect(resolveDefaultLlmEngine({ engines: {} })).toBeUndefined();
	});
});
