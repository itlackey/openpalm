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
 * the e2e wizard tests — EXCEPT where a store/API "contract" is exactly what a
 * prior bug broke (deploy-poll restart on retry, the Re-check force re-probe,
 * the password surviving a remount): those are pinned here against the mocked
 * $lib/setup-api.js so a regression trips a fast unit test, not just e2e.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SetupState, setupState, INITIAL } from './setup-state.svelte.js';
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
  vi.useRealTimers();
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
    expect(s.hasUsableAI).toBe(false);
    expect(s.verifiedCount).toBe(0);
    expect(s.verifiedProviders).toEqual([]);
  });
});

describe('SetupState — UI login password rerun keep-as-is (PR #564 P1-1)', () => {
  it('an unchanged rerun omits uiLoginPassword from the payload (server preserves the secret)', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.uiLoginPasswordDirty = false;
    s.uiLoginPassword = ''; // never generated on rerun
    expect(s.payload.security).toEqual({});
    expect('uiLoginPassword' in s.payload.security).toBe(false);
  });

  it('an explicit password change on rerun IS sent', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.uiLoginPasswordDirty = true;
    s.uiLoginPassword = 'operator-chose-this';
    expect(s.payload.security).toEqual({ uiLoginPassword: 'operator-chose-this' });
  });

  it('a fresh (non-rerun) install always sends the password', () => {
    const s = new SetupState();
    s.uiLoginPassword = 'fresh-install-pw';
    expect(s.payload.security).toEqual({ uiLoginPassword: 'fresh-install-pw' });
  });
});

describe('SetupState — the assistant key is generated, never typed', () => {
  it('no toggle asks the operator for a credential', () => {
    // Older access setup made the operator hold a second password. Publishing
    // the Assistant API now mints its own key
    // server-side, so the human-facing credential stays the UI login password
    // in every configuration.
    const s = new SetupState();
    s.setAccessToggle('assistantDirect', true);
    expect(s.payload.access?.assistantDirect).toBe(true);
    expect(Object.keys(s.payload)).not.toContain('opencodePassword');
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

describe('SetupState — voice toggle', () => {
  it('handleEnableVoiceChange flips the explicit toggle', () => {
    const s = new SetupState();
    expect(s.voiceEnabled).toBe(false);
    s.handleEnableVoiceChange(true);
    expect(s.voiceEnabled).toBe(true);
    s.handleEnableVoiceChange(false);
    expect(s.voiceEnabled).toBe(false);
  });

  it('enabling picks a default hardware profile when profiles are known', () => {
    const s = new SetupState();
    s.voiceProfiles = [
      { id: 'addon.voice.cpu', services: ['voice'], default: true, available: true },
      { id: 'addon.voice.cuda', services: ['voice-cuda'], available: false },
    ];
    s.handleEnableVoiceChange(true);
    expect(s.selectedVoiceProfile).toBe('addon.voice.cpu');
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

  // W8: switching back to cloud must not silently leave a multi-GB in-stack
  // Ollama enabled in the install payload.
  it('switching back to cloud clears ollamaEnabled', () => {
    const s = new SetupState();
    s.initProviderState();
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    s.handleConnectModeChange('local');
    expect(s.ollamaEnabled).toBe(true);
    s.handleConnectModeChange('cloud');
    expect(s.ollamaEnabled).toBe(false);
    expect(s.payload.addons.ollama).toBeUndefined();
  });

  it('going local with no prior cloud selection then back to cloud clears `llm` instead of leaving it on the disabled local runtime', () => {
    const s = new SetupState();
    s.initProviderState();
    // No cloud model was ever selected — modelMode starts 'cloud' by default
    // but nothing has been chosen yet.
    s.handleConnectModeChange('local');
    expect(s.modelSelection.llm?.connId).toBe('ollama');
    s.handleConnectModeChange('cloud');
    expect(s.ollamaEnabled).toBe(false);
    expect(s.modelSelection.llm).toBeUndefined();
  });

  // W8: detectedCloudConn is the field whose entire purpose is keeping
  // Screen1ModelsStep's "detected cloud service" row visible after switching
  // to local. Before the fix, nothing in production code ever assigned it.
  it('captures detectedCloudConn when leaving a cloud selection for local', () => {
    const s = new SetupState();
    s.initProviderState();
    expect(s.detectedCloudConn).toBe('');
    s.modelSelection.llm = { connId: 'openai', model: 'gpt-4o', dims: 0 };
    s.handleConnectModeChange('local');
    expect(s.detectedCloudConn).toBe('openai');
    // Stays stable — the row must not vanish while the active selection is local.
    expect(s.modelSelection.llm?.connId).toBe('ollama');
    expect(s.detectedCloudConn).toBe('openai');
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

// W6: handleDeployRetry() used to call the one-shot pollDeployStatus() instead
// of startDeployPolling() — the interval was already cleared when the prior
// error was detected, so exactly one poll ran after a retry and the screen
// then froze even on a successful deploy.
describe('SetupState — handleDeployRetry restarts polling (W6)', () => {
  it('keeps polling after a successful retry until the deploy actually finishes', async () => {
    vi.useFakeTimers();
    const api = await import('$lib/setup-api.js');
    vi.mocked(api.fetchDeployStatus)
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { deploying: true, setupComplete: false, deployStatus: [{ service: 'assistant', status: 'pending' }] },
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { deploying: false, setupComplete: true, deployStatus: [{ service: 'assistant', status: 'running' }] },
      }));

    const s = new SetupState();
    s.deployError = 'Stack update failed.';

    await s.handleDeployRetry();
    // startDeployPolling()'s immediate (unawaited) poll — flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(s.deployError).toBeNull();
    expect(s.deployDone).toBe(false); // still the first (still-deploying) response

    // The one-shot bug would never reach this second poll at all.
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.deployDone).toBe(true);

    s.dispose();
  });
});

// W9: LocalModelsStatus's "Re-check" button (shown to macOS users told to
// "install Ollama… then click Re-check") called fetchAndApplyRecommendation()
// with no arguments, which early-returns once a recommendation was already
// applied — by the time the button is visible, one always has been, so the
// button was a no-op.
describe('SetupState — fetchAndApplyRecommendation force re-check (W9)', () => {
  it('a plain call is a no-op once a recommendation was already applied (the bug)', async () => {
    const s = new SetupState();
    s.recommendationApplied = true;
    s.recommendationAlert = 'stale';
    await s.fetchAndApplyRecommendation();
    expect(s.recommendationAlert).toBe('stale');
    expect(s.ollamaEnabled).toBe(false);
  });

  it('force:true re-probes and re-applies even though a recommendation was already applied', async () => {
    const api = await import('$lib/setup-api.js');
    vi.mocked(api.fetchRecommendation).mockResolvedValueOnce({
      ok: true,
      recommendation: {
        action: 'enable-ollama',
        profileVariant: 'cpu',
        gpu: { vendor: 'nvidia', name: 'RTX 4090', vramMb: 24576 },
        alert: 'A capable GPU was found. Local models via Ollama have been enabled for you.',
      },
    });

    const s = new SetupState();
    s.recommendationApplied = true;
    s.recommendation = { action: 'connect-manually', alert: 'stale' };
    s.ollamaEnabled = false;

    await s.fetchAndApplyRecommendation(true);

    expect(api.fetchRecommendation).toHaveBeenCalled();
    expect(s.recommendationAlert).toBe('A capable GPU was found. Local models via Ollama have been enabled for you.');
    expect(s.ollamaEnabled).toBe(true);
  });
});

// W12: reset() (run at the start of every init()) always clears
// uiLoginPassword to '' — a fresh mount used to unconditionally call
// generatePassword() next, so an F5 on the Welcome step silently swapped in a
// DIFFERENT password than the one the user was just told to keep a copy of.
describe('SetupState — uiLoginPassword survives a remount (W12)', () => {
  function makeSessionStorageStub(): Storage {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: () => null,
      get length() { return store.size; },
    } as Storage;
  }

  it('a remount (F5, same tab) reuses the password instead of generating a new one', () => {
    vi.stubGlobal('window', { location: { search: '' }, sessionStorage: makeSessionStorageStub() });

    const first = new SetupState();
    first.init();
    const firstPassword = first.uiLoginPassword;
    expect(firstPassword).not.toBe('');
    first.dispose();

    // A brand-new store instance, same tab (same sessionStorage) — mirrors a
    // full page reload of the singleton in production.
    const second = new SetupState();
    second.init();
    expect(second.uiLoginPassword).toBe(firstPassword);
    second.dispose();
  });

  it('a rerun (?rerun=1) never touches the stored password', () => {
    const sessionStorage = makeSessionStorageStub();
    vi.stubGlobal('window', { location: { search: '?rerun=1' }, sessionStorage });

    const s = new SetupState();
    s.init();
    expect(s.uiLoginPassword).toBe('');
    expect(sessionStorage.getItem('openpalm.setup.uiLoginPassword')).toBeNull();
    s.dispose();
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

describe('SetupState — access toggle defaults', () => {
  it('INITIAL opens nothing — a fresh install needs no interaction', () => {
    const s = new SetupState();
    expect(s.access).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
  });

  it('reset() restores the closed default', () => {
    const s = new SetupState();
    s.setAccessToggle('networkAccess', true);
    s.setAccessToggle('assistantDirect', true);
    s.reset();
    expect(s.access).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
  });
});

describe('SetupState — setAccessToggle', () => {
  it('flips exactly one toggle and leaves the rest alone', () => {
    const s = new SetupState();
    s.setAccessToggle('guardianNetwork', true);
    expect(s.access).toEqual({
      networkAccess: false,
      assistantDirect: false,
      guardianNetwork: true,
      guardianOpenaiApi: false,
    });
  });

  it('marks the step touched, so a rerun sends the field', () => {
    const s = new SetupState();
    expect(s.networkDirty).toBe(false);
    s.setAccessToggle('networkAccess', true);
    expect(s.networkDirty).toBe(true);
  });

  it('is idempotent and reversible', () => {
    const s = new SetupState();
    s.setAccessToggle('networkAccess', true);
    s.setAccessToggle('networkAccess', false);
    expect(s.access.networkAccess).toBe(false);
  });
});

describe('SetupState — rerun keep-as-is contract', () => {
  it('an untouched rerun omits access, so the server preserves the existing exposure', () => {
    const s = new SetupState();
    s.isRerun = true;
    expect(s.payload.access).toBeUndefined();
  });

  it('a touched rerun sends the toggles', () => {
    const s = new SetupState();
    s.isRerun = true;
    s.setAccessToggle('networkAccess', true);
    expect(s.payload.access).toEqual({
      networkAccess: true,
      assistantDirect: false,
      guardianNetwork: false,
      guardianOpenaiApi: false,
    });
  });

  it('a fresh install always sends them, even untouched', () => {
    const s = new SetupState();
    expect(s.payload.access).toBeDefined();
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
      'modelSelection', 'voiceProfiles', 'selectedVoiceProfile',
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
