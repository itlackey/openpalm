import { describe, expect, test } from 'vitest';
import { LOCAL_PROVIDER_IDS, friendlyProviderName, PROVIDERS } from './constants.js';

// ── LOCAL_PROVIDER_IDS — single source of truth ──────────────────────────────
// Previously duplicated across five sites with three drifting sets. This guards
// the canonical definition (PROVIDERS kind==='local' ∪ host-only runtimes).

describe('LOCAL_PROVIDER_IDS', () => {
  test('includes every PROVIDERS entry with kind === "local"', () => {
    for (const p of PROVIDERS.filter((x) => x.kind === 'local')) {
      expect(LOCAL_PROVIDER_IDS.has(p.id)).toBe(true);
    }
  });

  test('includes the host-only detected runtimes not in the wizard catalog', () => {
    expect(LOCAL_PROVIDER_IDS.has('llamacpp')).toBe(true);
    expect(LOCAL_PROVIDER_IDS.has('localai')).toBe(true);
  });

  test('does not treat cloud providers as local', () => {
    expect(LOCAL_PROVIDER_IDS.has('openai')).toBe(false);
    expect(LOCAL_PROVIDER_IDS.has('google')).toBe(false);
    // openai-compatible is a "cloud" kind — server recommendation excludes it
    // separately, but it is NOT a local runtime.
    expect(LOCAL_PROVIDER_IDS.has('openai-compatible')).toBe(false);
  });
});

// ── friendlyProviderName — one shared display-name helper ─────────────────────

describe('friendlyProviderName', () => {
  test('returns curated names for well-known cloud providers', () => {
    expect(friendlyProviderName('openai')).toBe('ChatGPT (OpenAI)');
    expect(friendlyProviderName('google')).toBe('Gemini (Google)');
    expect(friendlyProviderName('github-copilot')).toBe('GitHub Copilot');
    expect(friendlyProviderName('groq')).toBe('Groq');
  });

  test('returns empty string for a missing connId', () => {
    expect(friendlyProviderName('')).toBe('');
  });

  test('uses localLabel for local runtimes when provided', () => {
    expect(friendlyProviderName('ollama', { localLabel: 'Runs on this computer' }))
      .toBe('Runs on this computer');
    expect(friendlyProviderName('llamacpp', { localLabel: 'Runs on this computer' }))
      .toBe('Runs on this computer');
  });

  test('prefers extraProviders name over the static catalog for unknown ids', () => {
    expect(friendlyProviderName('acme', { extraProviders: [{ id: 'acme', name: 'Acme AI' }] }))
      .toBe('Acme AI');
  });

  test('falls back to the PROVIDERS catalog display name', () => {
    expect(friendlyProviderName('together')).toBe('Together AI');
  });

  test('falls back to the raw connId when nothing else matches', () => {
    expect(friendlyProviderName('totally-unknown')).toBe('totally-unknown');
  });
});
