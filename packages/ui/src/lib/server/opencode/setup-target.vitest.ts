import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveSetupOpencodeTarget } from './setup-target.js';

const { getAssistantOpencodeTarget, getWizardOpencodeUrl } = vi.hoisted(() => ({
  getAssistantOpencodeTarget: vi.fn(),
  getWizardOpencodeUrl: vi.fn(),
}));

vi.mock('../opencode-target.js', () => ({ getAssistantOpencodeTarget }));
vi.mock('./wizard-instance.js', () => ({
  getWizardOpencodeUrl,
  setWizardOpencodeUrl: vi.fn(),
}));

beforeEach(() => {
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

    const target = await resolveSetupOpencodeTarget();

    expect(target).toEqual({
      source: 'assistant',
      url: 'http://127.0.0.1:3810',
      username: 'opencode',
      password: 'secret',
    });
  });

  test('falls back to the wizard-spawned instance when the assistant is not up yet', async () => {
    // The fresh-host case (W1): nothing listens on the assistant's target
    // before the first deploy, but `ensure` has a wizard instance running.
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue('http://127.0.0.1:40000');
    vi.stubGlobal('fetch', fetchRespondingTo('http://127.0.0.1:40000'));

    const target = await resolveSetupOpencodeTarget();

    // No credential attached — the wizard-spawned `opencode serve` has none.
    expect(target).toEqual({ source: 'wizard', url: 'http://127.0.0.1:40000' });
  });

  test('keeps an OAuth callback on the wizard source when the assistant becomes healthy', async () => {
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue('http://127.0.0.1:40000');
    let assistantHealthy = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const reachable = url.startsWith('http://127.0.0.1:40000') || assistantHealthy;
      return new Response('{}', { status: reachable ? 200 : 500 });
    }));

    const authorizeTarget = await resolveSetupOpencodeTarget();
    expect(authorizeTarget?.source).toBe('wizard');

    assistantHealthy = true;
    const callbackTarget = await resolveSetupOpencodeTarget(authorizeTarget?.source);
    expect(callbackTarget).toEqual({ source: 'wizard', url: 'http://127.0.0.1:40000' });
  });

  test('returns null when neither the assistant nor a wizard instance is reachable', async () => {
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    expect(await resolveSetupOpencodeTarget()).toBeNull();
  });

  test('returns null when the assistant is down and no wizard instance was ever started', async () => {
    getAssistantOpencodeTarget.mockReturnValue({ url: 'http://127.0.0.1:3810' });
    getWizardOpencodeUrl.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    expect(await resolveSetupOpencodeTarget()).toBeNull();
  });
});
