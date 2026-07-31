import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const getAssistantOpencodeTarget = vi.fn();
vi.mock('../opencode-target.js', () => ({ getAssistantOpencodeTarget }));

const getWizardOpencodeUrl = vi.fn();
vi.mock('./wizard-instance.js', () => ({
  getWizardOpencodeUrl,
  setWizardOpencodeUrl: vi.fn(),
}));

// Dynamically imported per test (after vi.resetModules()) — a static top-level
// import here would evaluate the module graph (and its transitive `vi.mock`
// factories) BEFORE the `const ... = vi.fn()` lines above run, tripping the
// same TDZ hoisting hazard `ensure/server.vitest.ts` avoids the same way.
async function loadModule() {
  return await import('./setup-target.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchRespondingTo(reachableUrl: string) {
  return vi.fn(async (url: string) =>
    new Response('{}', { status: url.startsWith(reachableUrl) ? 200 : 500 }),
  );
}

describe('resolveSetupOpencodeTarget (W1)', () => {
  test('prefers the deployed assistant when it is actually reachable', async () => {
    getAssistantOpencodeTarget.mockReturnValue({
      url: 'http://127.0.0.1:3810', username: 'opencode', password: 'secret',
    });
    getWizardOpencodeUrl.mockReturnValue('http://127.0.0.1:40000');
    vi.stubGlobal('fetch', fetchRespondingTo('http://127.0.0.1:3810'));

    const { resolveSetupOpencodeTarget } = await loadModule();
    const target = await resolveSetupOpencodeTarget();

    expect(target).toEqual({ url: 'http://127.0.0.1:3810', username: 'opencode', password: 'secret' });
  });

  test('falls back to the wizard-spawned instance when the assistant is not up yet', async () => {
    // The fresh-host case (W1): nothing listens on the assistant's target
    // before the first deploy, but `ensure` has a wizard instance running.
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue('http://127.0.0.1:40000');
    vi.stubGlobal('fetch', fetchRespondingTo('http://127.0.0.1:40000'));

    const { resolveSetupOpencodeTarget } = await loadModule();
    const target = await resolveSetupOpencodeTarget();

    // No credential attached — the wizard-spawned `opencode serve` has none.
    expect(target).toEqual({ url: 'http://127.0.0.1:40000' });
  });

  test('returns null when neither the assistant nor a wizard instance is reachable', async () => {
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    const { resolveSetupOpencodeTarget } = await loadModule();
    expect(await resolveSetupOpencodeTarget()).toBeNull();
  });

  test('returns null when the assistant is down and no wizard instance was ever started', async () => {
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const { resolveSetupOpencodeTarget } = await loadModule();
    expect(await resolveSetupOpencodeTarget()).toBeNull();
  });
});
