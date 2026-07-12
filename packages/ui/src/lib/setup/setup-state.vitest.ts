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
import { SetupState, setupState, INITIAL } from './setup-state.svelte.js';
import type { ProviderState } from '$lib/client/types.js';
import { fetchCurrentConfig } from '$lib/setup-api.js';

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

describe('SetupState — home-password rerun keep-as-is (PR #564 r3566887969)', () => {
  it('re-selecting the active home-password preset on a rerun does NOT rotate the password', () => {
    const s = new SetupState();
    // Simulate a rerun over an existing home-password install: the secret is
    // never returned, so the box is empty, but the install already has one.
    s.isRerun = true;
    s.hasExistingOpencodePassword = true;
    s.networkPreset = 'home-password';
    s.opencodePassword = '';
    s.networkDirty = false;

    s.handleNetworkPresetChange('home-password'); // re-click the selected row

    expect(s.opencodePassword).toBe(''); // no generatePassword()
    expect(s.networkDirty).toBe(false); // not marked dirty
    expect(s.payload.network).toBeUndefined(); // payload omits network → no rotation
  });

  it('typing a new password on the rerun IS a genuine change and rotates', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.hasExistingOpencodePassword = true;
    s.networkPreset = 'home-password';
    s.opencodePassword = '';

    s.handleOpencodePasswordInput('a-brand-new-pw');

    expect(s.networkDirty).toBe(true);
    expect(s.payload.network).toEqual({ preset: 'home-password', opencodePassword: 'a-brand-new-pw' });
  });

  it('a fresh (non-rerun) install still auto-generates a home-password', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-password');
    expect(s.opencodePassword.length).toBeGreaterThanOrEqual(8);
    expect(s.networkDirty).toBe(true);
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
    s.providerState.openai.verified = true;
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

    s.providerState.openai.verified = true;
    expect(s.verifiedCount).toBe(1);
    expect(s.hasOpenAI).toBe(true);
    expect(s.verifiedProviders.map((p) => p.id)).toContain('openai');

    s.providerState.groq.verified = true;
    expect(s.verifiedCount).toBe(2);
  });

  it('voiceDefaults switch to OpenAI voices once OpenAI is verified', () => {
    const s = new SetupState();
    s.initProviderState();
    expect(s.voiceDefaults).toEqual({ tts: 'browser-tts', stt: 'browser-stt' });
    s.providerState.openai.verified = true;
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
    s.providerState.openai = providerEntry({ verified: true, models: ['gpt-4o', 'gpt-4o-mini'] });

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
    s.providerState.openai = providerEntry({ verified: true, models: ['gpt-4o'] });
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    expect(s.payload.llm).toBeDefined();
    expect(s.payload.llm?.model).toBe('gpt-4o');
  });
});

// ── #563 T49-T53: network access preset store fields/derivations ───────────

describe('SetupState — network access preset defaults (#563 T49)', () => {
  it('T49: INITIAL carries networkPreset "this-pc", empty opencodePassword, homeOpenAck false', () => {
    const s = new SetupState();
    expect(s.networkPreset).toBe('this-pc');
    expect(s.opencodePassword).toBe('');
    expect(s.homeOpenAck).toBe(false);
  });

  it('T49: reset() restores networkPreset/opencodePassword/homeOpenAck to their INITIAL defaults', () => {
    const s = new SetupState();
    s.networkPreset = 'home-open';
    s.opencodePassword = 'typed-pw';
    s.homeOpenAck = true;
    s.reset();
    expect(s.networkPreset).toBe('this-pc');
    expect(s.opencodePassword).toBe('');
    expect(s.homeOpenAck).toBe(false);
  });
});

describe('SetupState — handleNetworkPresetChange (#563 T50/T51)', () => {
  it('T50: pre-fills a generated password only when switching to home-password with an empty field', () => {
    const s = new SetupState();
    expect(s.opencodePassword).toBe('');
    s.handleNetworkPresetChange('home-password');
    expect(s.networkPreset).toBe('home-password');
    expect(s.opencodePassword).not.toBe('');
    expect(s.opencodePassword.length).toBeGreaterThanOrEqual(8);
  });

  it('T50: a user-typed password survives re-selecting home-password', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-password');
    s.opencodePassword = 'my-own-password';
    s.handleNetworkPresetChange('home-password');
    expect(s.opencodePassword).toBe('my-own-password');
  });

  it('T50: switching away and back to home-password does not regenerate an existing password', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-password');
    s.opencodePassword = 'my-own-password';
    s.handleNetworkPresetChange('this-pc');
    s.handleNetworkPresetChange('home-password');
    expect(s.opencodePassword).toBe('my-own-password');
  });

  it('T51: clears homeOpenAck when leaving home-open', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-open');
    s.homeOpenAck = true;
    s.handleNetworkPresetChange('this-pc');
    expect(s.homeOpenAck).toBe(false);
  });

  it('T51: homeOpenAck is untouched when re-selecting home-open', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-open');
    s.homeOpenAck = true;
    s.handleNetworkPresetChange('home-open');
    expect(s.homeOpenAck).toBe(true);
  });
});

describe('SetupState — networkChoiceValid gates install (#563 T52)', () => {
  it('this-pc and shared-guardian are always valid', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('this-pc');
    expect(s.networkChoiceValid).toBe(true);
    s.handleNetworkPresetChange('shared-guardian');
    expect(s.networkChoiceValid).toBe(true);
  });

  it('home-open requires the risk-acknowledgement checkbox', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-open');
    expect(s.networkChoiceValid).toBe(false);
    s.homeOpenAck = true;
    expect(s.networkChoiceValid).toBe(true);
  });

  it('home-password requires an 8+ char password', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-password');
    s.opencodePassword = '1234567';
    expect(s.networkChoiceValid).toBe(false);
    s.opencodePassword = '12345678';
    expect(s.networkChoiceValid).toBe(true);
  });

  it('payload reflects the chosen preset (delegation to buildSetupPayload)', () => {
    const s = new SetupState();
    s.handleNetworkPresetChange('home-password');
    s.opencodePassword = 'lan-secret-123';
    expect(s.payload.network).toEqual({ preset: 'home-password', opencodePassword: 'lan-secret-123' });
  });

  // Regression: a rerun over an untouched home-password (or home-open) install
  // must remain valid — the payload already omits `network` (keep-as-is, D7),
  // so the gate must not force the operator to re-enter a password/ack it
  // never asked for. Mirrors the payload's own send condition
  // `(!isRerun || networkDirty)`.
  it('rerun + untouched home-password preset (password never returned, S3) is valid', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.networkPreset = 'home-password';
    s.opencodePassword = ''; // never sent back by the server
    s.networkDirty = false;
    expect(s.networkChoiceValid).toBe(true);
    expect(s.payload.network).toBeUndefined();
  });

  it('rerun + untouched home-open preset is valid even with homeOpenAck still false', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.networkPreset = 'home-open';
    s.homeOpenAck = false;
    s.networkDirty = false;
    expect(s.networkChoiceValid).toBe(true);
  });

  it('rerun + DIRTIED home-password preset still requires a real password', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.networkPreset = 'home-password';
    s.opencodePassword = '';
    s.networkDirty = true;
    expect(s.networkChoiceValid).toBe(false);
    s.opencodePassword = '12345678';
    expect(s.networkChoiceValid).toBe(true);
  });
});

describe('SetupState — rerun network preset pre-fill / networkDirty contract (#563 T53, D7)', () => {
  afterEach(() => {
    vi.mocked(fetchCurrentConfig).mockReset();
    vi.mocked(fetchCurrentConfig).mockImplementation(async () => null);
  });

  it('T53: rerun with a detected preset pre-fills it; networkDirty stays false', async () => {
    vi.mocked(fetchCurrentConfig).mockResolvedValueOnce({ network: { preset: 'shared-guardian' } } as never);
    vi.stubGlobal('window', { location: { search: '?rerun=1' } });
    const s = new SetupState();
    s.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.networkPreset).toBe('shared-guardian');
    expect(s.networkDirty).toBe(false);
    s.dispose();
  });

  it('T53: rerun keeps network out of the payload until a network field is touched', async () => {
    vi.mocked(fetchCurrentConfig).mockResolvedValueOnce({ network: { preset: 'home-password' } } as never);
    vi.stubGlobal('window', { location: { search: '?rerun=1' } });
    const s = new SetupState();
    s.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.networkPreset).toBe('home-password');
    // Rerun prefill alone must NOT dirty the field — a rerun over a custom
    // stack.env must never silently rewrite it (D7).
    expect(s.payload.network).toBeUndefined();

    // Now the operator actively touches the network step — networkDirty
    // flips and the payload starts sending it.
    s.handleNetworkPresetChange('home-password');
    s.opencodePassword = 'lan-secret-123';
    expect(s.payload.network).toEqual({ preset: 'home-password', opencodePassword: 'lan-secret-123' });
    s.dispose();
  });

  it('T53: rerun over a custom (undetected) env leaves networkPreset null', async () => {
    vi.mocked(fetchCurrentConfig).mockResolvedValueOnce({} as never);
    vi.stubGlobal('window', { location: { search: '?rerun=1' } });
    const s = new SetupState();
    s.init();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.networkPreset).toBeNull();
    expect(s.payload.network).toBeUndefined();
    s.dispose();
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
    const discord = setupState.portalSelection.discord;
    if (typeof discord === 'object') discord.enabled = true;

    // Remount (init() runs once per mount and resets first).
    setupState.init();

    // Whole-store snapshot: EVERY reactive field must return to its constructor
    // default. A pristine `new SetupState()` is the source of truth for those
    // defaults; init() additionally re-seeds `providerState` and mints a fresh
    // login token, so we mirror those two deterministic mutations on the
    // reference before comparing. This guards all ~51 fields (including any
    // added later) against a reset() that forgets one — not just a spot-check.
    const fresh = new SetupState();
    fresh.initProviderState(); // init() re-seeds providerState right after reset()
    fresh.uiLoginPassword = setupState.uiLoginPassword; // random per mount — normalize

    // Public reactive fields only (derived getters + private internals excluded).
    const FIELDS = [
      'currentStep', 'maxVisitedStep', 'showDeploy', 'systemCheckPassed',
      'modelMode', 'voiceEnabled', 'uiLoginPassword', 'step0Error',
      'autoModeImporting', 'gpuDetected', 'providerState', 'detectedHostProviders',
      'detectedProviders', 'opencodeAvailable', 'opencodeProviders', 'opencodeAuth',
      'hostProviderCount', 'allowEmptyInstall', 'recommendation', 'recommendationAlert',
      'recommendationApplied', 'detectedGpuVramMb', 'detectedGpuVendor', 'detectedGpuName',
      'modelSelection', 'voiceTts', 'voiceStt', 'voiceProfiles', 'selectedVoiceProfile',
      'importedLlmModel', 'importedSmallModel', 'portalSelection', 'ollamaEnabled',
      'ollamaProfiles', 'selectedOllamaProfile', 'imageTag', 'hostAkmEnabled',
      'installError', 'installing', 'emptyAiAck', 'deployData', 'deployDone',
      'deployHasWarnings', 'deployError', 'deployPollErrors', 'savedCloudLlm',
      'detectedCloudConn', 'hostImportTriggered', 'hostImporting', 'hostImportError',
      'isRerun',
    ] as const;
    // structuredClone flattens Svelte's $state proxies to plain objects so the
    // deep-equality diff reads cleanly (and preserves undefined/null fields).
    const snapshot = (s: SetupState): Record<string, unknown> => {
      const rec = s as unknown as Record<string, unknown>;
      return structuredClone(Object.fromEntries(FIELDS.map((k) => [k, rec[k]])));
    };
    expect(snapshot(setupState)).toEqual(snapshot(fresh));

    // A fresh (non-rerun) mount does not bypass System Check, and init() always
    // mints a login token (the one field the snapshot deliberately normalizes).
    expect(setupState.isRerun).toBe(false);
    expect(setupState.uiLoginPassword).not.toBe('');

    // Derived predicates (getters, not part of the field snapshot) recompute clean.
    expect(setupState.canComplete).toBe(false);
    expect(setupState.hasUsableAI).toBe(false);
    expect(setupState.verifiedCount).toBe(0);

    // Tidy up the background work init() kicked off so it can't leak into
    // other tests.
    setupState.dispose();
  });
});

describe('SetupState — reset() restores every INITIAL field (single source)', () => {
  // Guards the "forgot to reset X" class of bug at its root: reset() derives
  // from the exported INITIAL template, so this test enumerates INITIAL's own
  // keys instead of a hand-maintained field list. Any field added to INITIAL is
  // automatically covered here — no third mirror to keep in sync.
  it('after dirtying every resettable field, reset() returns each to its INITIAL default', () => {
    const s = new SetupState();
    const keys = Object.keys(INITIAL) as (keyof typeof INITIAL)[];

    // Dirty EVERY resettable field to a sentinel guaranteed to differ from its
    // default (numbers, bools, strings, null, undefined, empty {}/[], and the
    // nested portal/voice objects all differ from this marker object).
    const rec = s as unknown as Record<string, unknown>;
    for (const k of keys) rec[k] = { __dirty: true };

    // Sanity: the dirtying actually took (so a no-op reset couldn't pass).
    for (const k of keys) expect(rec[k]).toEqual({ __dirty: true });

    s.reset();

    // Every field is back to its INITIAL value. structuredClone normalizes
    // Svelte's $state proxies to plain objects and preserves undefined/null.
    for (const k of keys) {
      expect(structuredClone(rec[k])).toEqual(structuredClone(INITIAL[k]));
    }

    // Object/array fields must be FRESH instances, not aliases of the shared
    // INITIAL template (a reset that assigned the template directly would let a
    // later in-place mutation corrupt every future reset).
    for (const k of keys) {
      const def = INITIAL[k];
      if (def !== null && typeof def === 'object') {
        expect(rec[k]).not.toBe(def);
      }
    }

    s.dispose();
  });
});
