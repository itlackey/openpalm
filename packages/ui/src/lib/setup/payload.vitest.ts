import { describe, expect, test } from 'vitest';
import {
  buildSetupPayload, parseSetupConfig,
  type SetupPayload, type SetupPayloadInput, type RawSetupConfig,
} from './payload.js';
import type { Provider, ProviderState } from '../client/types.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id, name: id, kind: 'cloud', group: 'cloud', order: 1, icon: '', desc: '',
    baseUrl: `https://api.${id}.test`, llmModel: '', embModel: '', embDims: 0, ...overrides,
  };
}

function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    selected: true, verified: true, verifying: false, error: false,
    apiKey: '', baseUrl: '', models: [], ollamaMode: null, ...overrides,
  };
}

function baseInput(overrides: Partial<SetupPayloadInput> = {}): SetupPayloadInput {
  return {
    modelSelection: {},
    verifiedProviders: [],
    providerState: {},
    ollamaEnabled: false,
    hostLocalLlmRunning: false,
    voiceEnabled: false,
    selectedVoiceProfile: '',
    selectedOllamaProfile: '',
    portalSelection: {},
    uiLoginPassword: 'pw',
    imageTag: '',
    hostAkmEnabled: false,
    // #563 — network access preset. Default matches the wizard default
    // (D5/D7): 'this-pc' on every first run.
    networkPreset: 'this-pc',
    opencodePassword: '',
    ...overrides,
  };
}

// ── buildSetupPayload ────────────────────────────────────────────────────────

describe('buildSetupPayload', () => {
  test('minimal payload has version/security/connections and the always-on API portal', () => {
    const p = buildSetupPayload(baseInput({ uiLoginPassword: 'secret' }));
    expect(p).toEqual({
      version: 2,
      addons: { api: true }, // locked API portal is always enabled
      security: { uiLoginPassword: 'secret' },
      connections: [],
      // #563 — the default networkPreset ('this-pc') always emits a network
      // block with no password (D7: the wizard sends `network` on every
      // first run).
      network: { preset: 'this-pc' },
    });
  });

  test('P1-1: keepExistingUiLoginPassword omits the password (unchanged rerun keeps the secret)', () => {
    const p = buildSetupPayload(baseInput({ uiLoginPassword: 'generated-never-shown', keepExistingUiLoginPassword: true }));
    expect(p.security).toEqual({}); // no uiLoginPassword → server preserves existing
    expect('uiLoginPassword' in p.security).toBe(false);
  });

  test('P1-1: an explicit password (or fresh install) still sends it', () => {
    const p = buildSetupPayload(baseInput({ uiLoginPassword: 'chosen-pw', keepExistingUiLoginPassword: false }));
    expect(p.security).toEqual({ uiLoginPassword: 'chosen-pw' });
  });

  test('selected llm becomes a connection + top-level llm block', () => {
    const p = buildSetupPayload(baseInput({
      modelSelection: { llm: { connId: 'openai', model: 'gpt-4o' } },
      verifiedProviders: [provider('openai')],
      providerState: { openai: providerState({ baseUrl: 'https://api.openai.com', apiKey: 'sk-x' }) },
    }));
    expect(p.connections).toEqual([
      { id: 'openai', name: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-x' },
    ]);
    expect(p.llm).toEqual({ provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com' });
  });

  test('embedding defaults dims to 1536 when unset', () => {
    const p = buildSetupPayload(baseInput({
      modelSelection: { embedding: { connId: 'openai', model: 'text-embedding-3-small' } },
      verifiedProviders: [provider('openai')],
      providerState: { openai: providerState({ baseUrl: 'https://api.openai.com' }) },
    }));
    expect(p.embedding).toEqual({ provider: 'openai', model: 'text-embedding-3-small', dims: 1536, baseUrl: 'https://api.openai.com' });
  });

  test('ollama addon enabled when ollamaEnabled and no host runtime', () => {
    const p = buildSetupPayload(baseInput({ ollamaEnabled: true, selectedOllamaProfile: 'ollama-cpu' }));
    expect(p.addons.ollama).toBe(true);
    expect(p.ollamaProfile).toBe('ollama-cpu');
  });

  test('ollama addon SUPPRESSED when a host runtime is running', () => {
    const p = buildSetupPayload(baseInput({ ollamaEnabled: true, hostLocalLlmRunning: true, selectedOllamaProfile: 'ollama-cpu' }));
    expect(p.addons.ollama).toBeUndefined();
    // ollamaProfile still emitted because it only gates on ollamaEnabled
    expect(p.ollamaProfile).toBe('ollama-cpu');
  });

  test('bundled voice toggle: addon + voiceProfile (no engine blocks — provider choice is client-owned)', () => {
    const p = buildSetupPayload(baseInput({
      voiceEnabled: true,
      selectedVoiceProfile: 'voice-cuda',
    }));
    expect(p.addons.voice).toBe(true);
    expect(p.voiceProfile).toBe('voice-cuda');
    expect(p).not.toHaveProperty('tts');
    expect(p).not.toHaveProperty('stt');
  });

  test('voice off: no addon, no profile', () => {
    const p = buildSetupPayload(baseInput({
      voiceEnabled: false,
      selectedVoiceProfile: 'voice-cuda',
    }));
    expect(p.addons.voice).toBeUndefined();
    expect(p.voiceProfile).toBeUndefined();
  });

  test('portal with credentials → addon + flattened portalCredentials', () => {
    const p = buildSetupPayload(baseInput({
      portalSelection: {
        discord: { enabled: true, botToken: 'tok', applicationId: 'app' },
      },
    }));
    expect(p.addons.discord).toBe(true);
    expect(p.portalCredentials).toEqual({ discord: { botToken: 'tok', applicationId: 'app' } });
  });

  test('locked API portal is always enabled with no credentials', () => {
    const p = buildSetupPayload(baseInput());
    expect(p.addons.api).toBe(true);
    expect(p.portalCredentials).toBeUndefined();
  });

  test('imageTag trimmed and hostAkm flag passed through', () => {
    const p = buildSetupPayload(baseInput({ imageTag: '  v1.2.3  ', hostAkmEnabled: true }));
    expect(p.imageTag).toBe('v1.2.3');
    expect(p.hostAkm).toBe(true);
  });

  test('blank imageTag omitted', () => {
    const p = buildSetupPayload(baseInput({ imageTag: '   ' }));
    expect(p.imageTag).toBeUndefined();
  });
});

// ── #563 network access preset (T44-T48) ─────────────────────────────────────

describe('buildSetupPayload — network access preset (#563)', () => {
  test('T44: default input emits network {preset:"this-pc"} with no password', () => {
    const p = buildSetupPayload(baseInput());
    expect(p.network).toEqual({ preset: 'this-pc' });
  });

  test('T45: home-password emits the password', () => {
    const p = buildSetupPayload(baseInput({ networkPreset: 'home-password', opencodePassword: 'lan-secret-123' }));
    expect(p.network).toEqual({ preset: 'home-password', opencodePassword: 'lan-secret-123' });
  });

  test('T45: home-open does not emit a password', () => {
    const p = buildSetupPayload(baseInput({ networkPreset: 'home-open', opencodePassword: 'ignored' }));
    expect(p.network).toEqual({ preset: 'home-open' });
  });

  test('T45: shared-guardian does not emit a password', () => {
    const p = buildSetupPayload(baseInput({ networkPreset: 'shared-guardian', opencodePassword: 'ignored' }));
    expect(p.network).toEqual({ preset: 'shared-guardian' });
  });

  test('T46: networkPreset null (rerun over a custom env) omits the network field entirely', () => {
    const p = buildSetupPayload(baseInput({ networkPreset: null }));
    expect(p.network).toBeUndefined();
  });
});

describe('parseSetupConfig — network access preset (#563)', () => {
  test('T47: maps network.preset onto PartialSetupState.networkPreset', () => {
    const r = parseSetupConfig({ network: { preset: 'home-password' } } as RawSetupConfig);
    expect(r.networkPreset).toBe('home-password');
  });

  test('T47: maps network.preset === null onto PartialSetupState.networkPreset === null', () => {
    const r = parseSetupConfig({ network: { preset: null } } as RawSetupConfig);
    expect(r.networkPreset).toBeNull();
  });

  test('T47: an unknown preset string maps to null (never a garbage passthrough)', () => {
    const r = parseSetupConfig({ network: { preset: 'not-a-real-preset' } } as RawSetupConfig);
    expect(r.networkPreset).toBeNull();
  });

  test('T47: a missing network field leaves networkPreset unset', () => {
    const r = parseSetupConfig({});
    expect(r.networkPreset).toBeUndefined();
  });
});

describe('network access preset round-trip: build → parse (T48)', () => {
  test.each(['this-pc', 'home-password', 'home-open', 'shared-guardian'] as const)(
    'T48: %s round-trips through the install payload back to the same preset',
    (preset) => {
      const built = buildSetupPayload(
        baseInput({ networkPreset: preset, opencodePassword: preset === 'home-password' ? 'lan-secret-123' : '' }),
      );
      const parsed = parseSetupConfig({ network: built.network ?? { preset: null } } as RawSetupConfig);
      expect(parsed.networkPreset).toBe(preset);
    },
  );
});

// ── parseSetupConfig ─────────────────────────────────────────────────────────

describe('parseSetupConfig', () => {
  test('empty config yields empty enabledAddons/portalCredentials', () => {
    expect(parseSetupConfig({})).toEqual({ enabledAddons: [], portalCredentials: {} });
  });

  test('P1-2: secret-presence metadata is filtered out (never becomes a string credential)', () => {
    const r = parseSetupConfig({
      // Shape current-config actually returns: presence metadata, not plaintext.
      portalCredentials: {
        discord: { botToken: { envKey: 'DISCORD_BOT_TOKEN', present: true } },
        slack: { slackBotToken: { envKey: 'SLACK_BOT_TOKEN', present: true } },
      },
    } as unknown as RawSetupConfig);
    // No metadata object survives → no field can serialize to "[object Object]".
    expect(r.portalCredentials).toEqual({});
  });

  test('P1-2: genuine string credential values still pass through', () => {
    const r = parseSetupConfig({
      portalCredentials: { discord: { applicationId: '12345' } },
    } as unknown as RawSetupConfig);
    expect(r.portalCredentials).toEqual({ discord: { applicationId: '12345' } });
  });

  test('llm/embedding map provider→connId', () => {
    const r = parseSetupConfig({
      llm: { provider: 'openai', model: 'gpt-4o' },
      embedding: { provider: 'openai', model: 'emb', dims: 1536 },
    });
    expect(r.llm).toEqual({ connId: 'openai', model: 'gpt-4o' });
    expect(r.embedding).toEqual({ connId: 'openai', model: 'emb', dims: 1536 });
  });

  test('voice: profile pre-fills, enabled addon flips the toggle', () => {
    const r = parseSetupConfig({
      voice: { selectedProfile: 'voice-cpu' },
      enabledAddons: ['voice'],
    });
    expect(r.selectedVoiceProfile).toBe('voice-cpu');
    expect(r.voiceEnabled).toBe(true);
  });

  test('enabledAddons drives ollama + portal enable', () => {
    const r = parseSetupConfig({
      enabledAddons: ['ollama', 'discord'],
      ollama: { selectedProfile: 'ollama-cuda' },
      portalCredentials: { discord: { botToken: { envKey: 'X', present: true } } },
    });
    expect(r.ollamaEnabled).toBe(true);
    expect(r.selectedOllamaProfile).toBe('ollama-cuda');
    expect(r.enabledAddons).toContain('discord');
    // PR #564 P1-2: the addon is enabled via enabledAddons, but the secret-
    // presence metadata is NOT surfaced as a credential value (would corrupt).
    expect(r.portalCredentials.discord).toBeUndefined();
  });

  test('hostAkm boolean passed through; non-boolean ignored', () => {
    expect(parseSetupConfig({ hostAkm: true }).hostAkmEnabled).toBe(true);
    expect(parseSetupConfig({ hostAkm: 'yes' as unknown }).hostAkmEnabled).toBeUndefined();
  });
});

// ── Round-trip: build → serialize (server transform) → parse ─────────────────
// The two directions serialize DIFFERENT wire shapes (install payload vs
// current-config). This transform models the server persisting the payload and
// re-reading it, so the test proves buildSetupPayload and parseSetupConfig agree
// on every field's semantics — they can't drift without failing here.

function payloadToCurrentConfig(p: SetupPayload): RawSetupConfig {
  const enabledAddons = Object.keys(p.addons).filter((k) => p.addons[k]);
  return {
    hostAkm: p.hostAkm ?? false,
    llm: p.llm ? { provider: p.llm.provider, model: p.llm.model } : null,
    embedding: p.embedding ? { provider: p.embedding.provider, model: p.embedding.model, dims: p.embedding.dims } : null,
    voice: { selectedProfile: p.voiceProfile ?? null },
    enabledAddons,
    ollama: { selectedProfile: p.ollamaProfile ?? null },
    portalCredentials: p.portalCredentials ?? {},
  };
}

describe('build → parse round-trip', () => {
  test('semantic fields survive the payload → current-config → parse cycle', () => {
    const input = baseInput({
      modelSelection: {
        llm: { connId: 'openai', model: 'gpt-4o' },
        embedding: { connId: 'openai', model: 'text-embedding-3-small', dims: 1536 },
      },
      verifiedProviders: [provider('openai')],
      providerState: { openai: providerState({ baseUrl: 'https://api.openai.com', apiKey: 'sk-x' }) },
      voiceEnabled: true,
      selectedVoiceProfile: 'voice-cuda',
      ollamaEnabled: true,
      selectedOllamaProfile: 'ollama-cpu',
      portalSelection: { discord: { enabled: true, botToken: 'tok', applicationId: 'app' } },
      hostAkmEnabled: true,
    });

    const built = buildSetupPayload(input);
    const parsed = parseSetupConfig(payloadToCurrentConfig(built));

    // Models
    expect(parsed.llm).toEqual({ connId: 'openai', model: 'gpt-4o' });
    expect(parsed.embedding).toEqual({ connId: 'openai', model: 'text-embedding-3-small', dims: 1536 });
    // Voice: the capability toggle + hardware profile round-trip
    expect(parsed.voiceEnabled).toBe(true);
    expect(parsed.selectedVoiceProfile).toBe('voice-cuda');
    // Ollama
    expect(parsed.ollamaEnabled).toBe(true);
    expect(parsed.selectedOllamaProfile).toBe('ollama-cpu');
    // Portals + hostAkm
    expect(parsed.enabledAddons).toEqual(expect.arrayContaining(['discord', 'ollama', 'voice', 'api']));
    expect(parsed.portalCredentials.discord).toEqual({ botToken: 'tok', applicationId: 'app' });
    expect(parsed.hostAkmEnabled).toBe(true);
  });

  test('empty install round-trips to empty selections', () => {
    const built = buildSetupPayload(baseInput());
    const parsed = parseSetupConfig(payloadToCurrentConfig(built));
    expect(parsed.llm).toBeUndefined();
    expect(parsed.embedding).toBeUndefined();
    expect(parsed.ollamaEnabled).toBeUndefined();
    expect(parsed.voiceEnabled).toBeUndefined();
    expect(parsed.hostAkmEnabled).toBe(false);
  });
});
