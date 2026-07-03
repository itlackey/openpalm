/**
 * Unit tests for the setup wizard store (setup-state.svelte.ts).
 *
 * These pin the store's OBSERVABLE behavior — the derivations and state
 * transitions that used to live inline in routes/setup/+page.svelte — so the
 * prop-drilling collapse can proceed without changing behavior. Runs in the
 * node ("server") vitest project; the `.svelte.ts` store is compiled by the
 * Svelte plugin, so its runes work here (the browser project can't launch in
 * this sandbox).
 *
 * Only pure/testable logic is covered: derivations (canComplete, enableVoice,
 * verifiedProviders, payload delegation), gating (goToStep), and synchronous
 * state transitions (handleConnectModeChange, handleEnableVoiceChange,
 * autoSelectModels). Fetch/window-dependent methods are exercised elsewhere by
 * the e2e wizard tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SetupState, setupState } from './setup-state.svelte.js';
import type { ProviderState } from '$lib/client/types.js';

// Stub the data-access layer so the exported singleton's init() discovery
// fetches resolve to benign values instead of hitting the network (or throwing
// on a relative URL in node). Only the singleton reset test drives init(); the
// pure-logic tests below never touch these.
vi.mock('$lib/setup-api.js', () => ({
  fetchVoiceProfiles: vi.fn(async () => null),
  fetchOllamaProfiles: vi.fn(async () => null),
  fetchRecommendation: vi.fn(async () => null),
  ensureOpenCode: vi.fn(async () => null),
  fetchOpenCodeStatus: vi.fn(async () => null),
  fetchOpenCodeProviders: vi.fn(async () => null),
  fetchDetectedProviders: vi.fn(async () => null),
  fetchProviderModels: vi.fn(async () => ({ models: [] })),
  authorizeOpenCodeOAuth: vi.fn(async () => ({})),
  pollOpenCodeOAuthCallback: vi.fn(async () => ({ ok: false, data: null })),
  completeSetup: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchDeployStatus: vi.fn(async () => ({ ok: false, data: null })),
  retryDeploy: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchHostStatus: vi.fn(async () => null),
  importHost: vi.fn(async () => ({ ok: true, data: { ok: true } })),
  fetchCurrentConfig: vi.fn(async () => null),
  fetchSetupStatus: vi.fn(async () => ({ setupComplete: false })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function providerEntry(patch: Partial<ProviderState> = {}): ProviderState {
  return {
    selected: false, verified: false, verifying: false, error: false,
    apiKey: '', baseUrl: '', models: [], ollamaMode: null,
    ...patch,
  };
}

describe('SetupState — defaults', () => {
  it('starts on the hidden system-check step with nothing selected', () => {
    const s = new SetupState();
    expect(s.currentStep).toBe(0);
    expect(s.modelMode).toBe('cloud');
    expect(s.voiceEnabled).toBe(false);
    expect(s.canComplete).toBe(false);
    expect(s.enableVoice).toBe(false);
    expect(s.hasUsableAI).toBe(false);
    expect(s.verifiedCount).toBe(0);
    expect(s.verifiedProviders).toEqual([]);
  });
});

describe('SetupState — canComplete', () => {
  it('is true once a chat model is selected', () => {
    const s = new SetupState();
    expect(s.canComplete).toBe(false);
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    expect(s.canComplete).toBe(true);
    expect(s.hasUsableAI).toBe(true);
  });

  it('is true when the empty-install escape is opted into', () => {
    const s = new SetupState();
    s.allowEmptyInstall = true;
    expect(s.canComplete).toBe(true);
  });

  it('is a derived predicate, NOT effect-synced — background provider changes do not flip allowEmptyInstall', () => {
    const s = new SetupState();
    s.initProviderState();
    s.allowEmptyInstall = true;
    // Simulate a background verification landing (the historical bug had an
    // $effect flip allowEmptyInstall off here, silently moving the checkbox).
    s.providerState['openai'].verified = true;
    expect(s.allowEmptyInstall).toBe(true);
    expect(s.canComplete).toBe(true);
  });
});

describe('SetupState — enableVoice / voice toggle', () => {
  it('enableVoice reflects the bundled engine on either side', () => {
    const s = new SetupState();
    expect(s.enableVoice).toBe(false);
    s.voiceTts = { engine: 'openpalm-voice' };
    expect(s.enableVoice).toBe(true);
    s.voiceTts = { engine: '' };
    expect(s.enableVoice).toBe(false);
    s.voiceStt = { engine: 'openpalm-voice' };
    expect(s.enableVoice).toBe(true);
  });

  it('handleEnableVoiceChange drives both engines and the derived follows', () => {
    const s = new SetupState();
    s.handleEnableVoiceChange(true);
    expect(s.voiceTts.engine).toBe('openpalm-voice');
    expect(s.voiceStt.engine).toBe('openpalm-voice');
    expect(s.enableVoice).toBe(true);

    s.handleEnableVoiceChange(false);
    expect(s.voiceTts.engine).toBe('');
    expect(s.voiceStt.engine).toBe('');
    expect(s.enableVoice).toBe(false);
  });

  it('persisted voice sides drop when disabled, display a fallback engine', () => {
    const s = new SetupState();
    // No engine chosen, voice off → persisted side is '' (won't be saved),
    // displayed side falls back to the browser default.
    expect(s.persistedVoiceTts.engine).toBe('');
    expect(s.displayedVoiceTts.engine).toBe('browser-tts');
    s.handleEnableVoiceChange(true);
    expect(s.persistedVoiceTts.engine).toBe('openpalm-voice');
    expect(s.displayedVoiceTts.engine).toBe('openpalm-voice');
  });
});

describe('SetupState — verified providers derivations', () => {
  it('counts and lists verified static providers', () => {
    const s = new SetupState();
    s.initProviderState();
    expect(s.verifiedCount).toBe(0);
    expect(s.hasOpenAI).toBe(false);

    s.providerState['openai'].verified = true;
    expect(s.verifiedCount).toBe(1);
    expect(s.hasOpenAI).toBe(true);
    expect(s.verifiedProviders.map((p) => p.id)).toContain('openai');

    s.providerState['groq'].verified = true;
    expect(s.verifiedCount).toBe(2);
  });

  it('voiceDefaults switch to OpenAI voices once OpenAI is verified', () => {
    const s = new SetupState();
    s.initProviderState();
    expect(s.voiceDefaults).toEqual({ tts: 'browser-tts', stt: 'browser-stt' });
    s.providerState['openai'].verified = true;
    expect(s.voiceDefaults).toEqual({ tts: 'openai-tts', stt: 'openai-stt' });
  });
});

describe('SetupState — handleConnectModeChange (cloud ↔ local)', () => {
  it('remembers the cloud model, enables Ollama, and points llm at local', () => {
    const s = new SetupState();
    s.initProviderState();
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };

    s.handleConnectModeChange('local');
    expect(s.modelMode).toBe('local');
    expect(s.savedCloudLlm).toEqual({ connId: 'openai', model: 'gpt-4o', dims: 0 });
    expect(s.ollamaEnabled).toBe(true);
    // Chat model now points at a local runtime (ollama), so Continue is enabled.
    expect(s.modelSelection.llm?.connId).toBe('ollama');
    expect(s.canComplete).toBe(true);
  });

  it('restores the saved cloud model when switching back to cloud', () => {
    const s = new SetupState();
    s.initProviderState();
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    s.handleConnectModeChange('local');
    s.handleConnectModeChange('cloud');
    expect(s.modelMode).toBe('cloud');
    expect(s.modelSelection.llm?.connId).toBe('openai');
    expect(s.modelSelection.llm?.model).toBe('gpt-4o');
  });
});

describe('SetupState — autoSelectModels', () => {
  it('fills the unset chat role from a verified provider, preserving set roles', () => {
    const s = new SetupState();
    s.initProviderState();
    s.providerState['openai'] = providerEntry({ verified: true, models: ['gpt-4o', 'gpt-4o-mini'] });

    s.autoSelectModels();
    expect(s.modelSelection.llm?.connId).toBe('openai');
    // Embedding is never auto-selected.
    expect(s.modelSelection.embedding).toBeUndefined();

    // A pre-set role is not overwritten.
    s.modelSelection.llm = { connId: 'groq', model: 'x', dims: 0 };
    s.autoSelectModels();
    expect(s.modelSelection.llm?.connId).toBe('groq');
  });
});

describe('SetupState — goToStep gating', () => {
  it('blocks forward navigation until the system check passes', () => {
    const s = new SetupState();
    expect(s.systemCheckPassed).toBe(false);
    s.goToStep(1);
    expect(s.currentStep).toBe(0);
  });

  it('advances and tracks the furthest visited step once unlocked', () => {
    const s = new SetupState();
    s.systemCheckPassed = true;
    s.isRerun = true; // avoid the step-1 recommendation fetch side effect
    s.goToStep(1);
    expect(s.currentStep).toBe(1);
    expect(s.maxVisitedStep).toBe(1);
    s.goToStep(3);
    expect(s.currentStep).toBe(3);
    expect(s.maxVisitedStep).toBe(3);
    // Going back doesn't lower the high-water mark.
    s.goToStep(1);
    expect(s.currentStep).toBe(1);
    expect(s.maxVisitedStep).toBe(3);
  });

  it('clamps out-of-range steps to a no-op', () => {
    const s = new SetupState();
    s.systemCheckPassed = true;
    s.goToStep(4);
    expect(s.currentStep).toBe(0);
    s.goToStep(-1);
    expect(s.currentStep).toBe(0);
  });
});

describe('SetupState — payload derivation delegates to buildSetupPayload', () => {
  it('reflects live wizard state (password, llm) in the derived payload', () => {
    const s = new SetupState();
    s.initProviderState();
    s.uiLoginPassword = 'hunter2';

    expect(s.payload.version).toBe(2);
    expect(s.payload.security.uiLoginPassword).toBe('hunter2');
    expect(s.payload.llm).toBeUndefined();

    // Verify a provider and select its chat model — the payload picks it up.
    s.providerState['openai'] = providerEntry({ verified: true, models: ['gpt-4o'] });
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    expect(s.payload.llm).toBeDefined();
    expect(s.payload.llm?.model).toBe('gpt-4o');
  });
});

describe('SetupState — module singleton is reset on a fresh (non-rerun) mount', () => {
  // This exercises the EXPORTED singleton + init()/reset() path (the pure-logic
  // tests above use `new SetupState()`, which is always fresh, so they can't
  // catch singleton persistence). Regression guard: a second SPA entry to
  // /setup (client-side pushState nav — no full reload, so the module is not
  // re-initialized) must reopen a FRESH wizard, not the stale one left behind.
  it('a dirtied singleton returns to defaults after init() for a non-rerun mount', () => {
    // Non-rerun URL; init() reads window.location.search.
    vi.stubGlobal('window', { location: { search: '' } });

    // Dirty the singleton the way an interrupted first visit would leave it:
    // advanced past System Check to Step 2 with a model + voice selected.
    setupState.currentStep = 2;
    setupState.maxVisitedStep = 2;
    setupState.systemCheckPassed = true;
    setupState.modelMode = 'local';
    setupState.voiceEnabled = true;
    setupState.voiceTts = { engine: 'openpalm-voice' };
    setupState.voiceStt = { engine: 'openpalm-voice' };
    setupState.selectedVoiceProfile = 'voice-cuda';
    setupState.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    setupState.ollamaEnabled = true;
    setupState.allowEmptyInstall = true;
    setupState.emptyAiAck = true;
    setupState.installError = 'boom';
    setupState.showDeploy = true;
    setupState.deployDone = true;
    setupState.hostImportTriggered = true;
    setupState.recommendationApplied = true;
    setupState.savedCloudLlm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    setupState.detectedCloudConn = 'openai';
    const discord = setupState.portalSelection['discord'];
    if (typeof discord === 'object') discord.enabled = true;

    // Remount (init() runs once per mount and resets first).
    setupState.init();

    // Fresh wizard: System Check no longer bypassed, back on the hidden step 0.
    expect(setupState.currentStep).toBe(0);
    expect(setupState.maxVisitedStep).toBe(0);
    expect(setupState.systemCheckPassed).toBe(false);
    expect(setupState.isRerun).toBe(false);

    // Selections cleared.
    expect(setupState.modelMode).toBe('cloud');
    expect(setupState.voiceEnabled).toBe(false);
    expect(setupState.voiceTts.engine).toBe('');
    expect(setupState.voiceStt.engine).toBe('');
    expect(setupState.selectedVoiceProfile).toBe('');
    expect(setupState.modelSelection.llm).toBeUndefined();
    expect(setupState.ollamaEnabled).toBe(false);
    expect(setupState.savedCloudLlm).toBeUndefined();
    expect(setupState.detectedCloudConn).toBe('');

    // Gating / one-shot flags cleared.
    expect(setupState.allowEmptyInstall).toBe(false);
    expect(setupState.emptyAiAck).toBe(false);
    expect(setupState.installError).toBe('');
    expect(setupState.showDeploy).toBe(false);
    expect(setupState.deployDone).toBe(false);
    expect(setupState.hostImportTriggered).toBe(false);
    expect(setupState.recommendationApplied).toBe(false);

    // Fresh portal objects (no lingering enabled/credentials).
    expect(setupState.portalSelection['discord']).toEqual({ enabled: false, botToken: '', applicationId: '' });

    // Derived predicates recompute clean.
    expect(setupState.canComplete).toBe(false);
    expect(setupState.hasUsableAI).toBe(false);
    expect(setupState.verifiedCount).toBe(0);

    // Tidy up the background work init() kicked off so it can't leak into
    // other tests.
    setupState.dispose();
  });
});
