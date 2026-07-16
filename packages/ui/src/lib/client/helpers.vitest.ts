import { describe, expect, test } from 'vitest';
import {
  generatePassword, buildPortalsConfig, buildVerifiedProviders,
  computeAutoModelSelection, resolvePreferredModelSelection,
} from './helpers.js';
import type { OpenCodeProvider, ProviderState } from './types.js';

function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    selected: true, verified: true, verifying: false, error: false,
    apiKey: '', baseUrl: '', models: [], ollamaMode: null, ...overrides,
  };
}

// ── generatePassword ─────────────────────────────────────────────────────────

describe('generatePassword', () => {
  test('returns 32 lowercase hex chars', () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[0-9a-f]{32}$/);
  });

  test('is random across calls', () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

// ── buildPortalsConfig ───────────────────────────────────────────────────────

describe('buildPortalsConfig', () => {
  test('locked API portal is always true; disabled portals omitted', () => {
    const cfg = buildPortalsConfig({
      discord: { enabled: false, botToken: '', applicationId: '' },
      slack: { enabled: false, slackBotToken: '', slackAppToken: '' },
    });
    expect(cfg.api).toBe(true);
    expect(cfg.discord).toBeUndefined();
    expect(cfg.slack).toBeUndefined();
  });

  test('enabled portal keeps only non-empty declared credentials', () => {
    const cfg = buildPortalsConfig({
      discord: { enabled: true, botToken: 'tok', applicationId: '' },
    });
    expect(cfg.discord).toEqual({ enabled: true, botToken: 'tok' });
  });

  test('plain-boolean selection becomes true', () => {
    const cfg = buildPortalsConfig({ discord: true });
    expect(cfg.discord).toBe(true);
  });
});

// ── buildVerifiedProviders ───────────────────────────────────────────────────

describe('buildVerifiedProviders', () => {
  test('without OpenCode: only verified static providers', () => {
    const result = buildVerifiedProviders(false, [], {
      openai: providerState({ verified: true }),
      groq: providerState({ verified: false }),
    });
    expect(result.map((p) => p.id)).toEqual(['openai']);
  });

  test('with OpenCode: verified opencode providers inherit static fallback models', () => {
    const opencode: OpenCodeProvider[] = [{ id: 'ollama', name: 'Ollama' }];
    const result = buildVerifiedProviders(true, opencode, {
      ollama: providerState({ verified: true, baseUrl: 'http://ollama:11434' }),
    });
    const ollama = result.find((p) => p.id === 'ollama');
    expect(ollama?.baseUrl).toBe('http://ollama:11434');
    // inherited from static PROVIDERS entry
    expect(ollama?.embModel).toBe('nomic-embed-text');
  });

  test('with OpenCode: appends verified static providers not in the OpenCode list', () => {
    const opencode: OpenCodeProvider[] = [{ id: 'openai', name: 'OpenAI' }];
    const result = buildVerifiedProviders(true, opencode, {
      openai: providerState({ verified: true }),
      ollama: providerState({ verified: true }),
    });
    const ids = result.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('ollama');
    // ollama came from the static list (not duplicated)
    expect(ids.filter((id) => id === 'ollama')).toHaveLength(1);
  });
});

// ── computeAutoModelSelection ────────────────────────────────────────────────

describe('computeAutoModelSelection', () => {
  test('fills unset llm with the best-ranked chat option; never sets embedding', () => {
    const providers = buildVerifiedProviders(false, [], {
      openai: providerState({ verified: true, models: ['gpt-4o', 'text-embedding-3-small'] }),
    });
    const result = computeAutoModelSelection({}, providers, {
      openai: providerState({ verified: true, models: ['gpt-4o', 'text-embedding-3-small'] }),
    });
    expect(result.llm?.model).toBe('gpt-4o');
    expect(result.embedding).toBeUndefined();
  });

  test('preserves an already-set role', () => {
    const providers = buildVerifiedProviders(false, [], {
      openai: providerState({ verified: true, models: ['gpt-4o'] }),
    });
    const result = computeAutoModelSelection(
      { llm: { connId: 'openai', model: 'gpt-pinned' } },
      providers,
      { openai: providerState({ verified: true, models: ['gpt-4o'] }) },
    );
    expect(result.llm?.model).toBe('gpt-pinned');
  });
});

// ── resolvePreferredModelSelection ───────────────────────────────────────────

describe('resolvePreferredModelSelection', () => {
  const state = { openai: providerState({ verified: true, models: ['gpt-4o', 'gpt-4o-mini'] }) };
  const providers = buildVerifiedProviders(false, [], state);

  test('exact full id match', () => {
    const r = resolvePreferredModelSelection('llm', 'gpt-4o', providers, state);
    expect(r).toEqual({ connId: 'openai', model: 'gpt-4o', dims: 0 });
  });

  test('provider-hint + model-name-part match', () => {
    const r = resolvePreferredModelSelection('llm', 'openai/gpt-4o-mini', providers, state);
    expect(r?.connId).toBe('openai');
    expect(r?.model).toBe('gpt-4o-mini');
  });

  test('offline fallback: provider verified but model list empty', () => {
    const emptyState = { openai: providerState({ verified: true, models: [] }) };
    const emptyProviders = buildVerifiedProviders(false, [], emptyState);
    const r = resolvePreferredModelSelection('llm', 'openai/some-model', emptyProviders, emptyState);
    expect(r).toEqual({ connId: 'openai', model: 'some-model', dims: 0 });
  });

  test('undefined preference returns undefined', () => {
    expect(resolvePreferredModelSelection('llm', undefined, providers, state)).toBeUndefined();
  });
});
