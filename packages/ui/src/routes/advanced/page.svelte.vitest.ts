import type { AfterNavigate } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdvancedPage from './+page.svelte';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

// Mutable so individual tests can drive the `?session=` query param.
const mockPage = vi.hoisted(() => ({ url: new URL('http://localhost/advanced') }));
vi.mock('$app/state', () => ({ page: mockPage }));

const activationMock = vi.hoisted(() => ({
  listener: null as (() => void | Promise<void>) | null,
}));

vi.mock('$lib/connection-events.js', () => ({
  onConnectionActivated: vi.fn((listener: () => void | Promise<void>) => {
    activationMock.listener = listener;
    return () => {
      activationMock.listener = null;
    };
  }),
}));

type MockConnection = {
  id: string;
  label: string;
  url: string;
  kind: 'local-opencode' | 'remote-opencode' | 'openpalm-client-api';
  isDefault: boolean;
  hasPassword: boolean;
};

const mockEndpointsService = vi.hoisted(() => {
  const active: MockConnection = {
    id: 'default',
    label: 'Local assistant',
    url: 'http://127.0.0.1:3800',
    kind: 'local-opencode',
    isDefault: true,
    hasPassword: false,
  };
  return {
    active,
    activeId: active.id,
    endpoints: [active],
    loading: false,
    error: '',
    load: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  // Call the callback immediately to simulate the initial load navigation event.
  afterNavigate: vi.fn((cb: (nav: AfterNavigate) => void) =>
    cb({ to: mockPage, from: null, type: 'goto', complete: Promise.resolve(), delta: 0, willUnload: false } as unknown as AfterNavigate)
  ),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: mockEndpointsService,
}));

/** Stub the endpoint probe. By default the active endpoint is reachable (200) so
 *  the iframe renders. `probeOk` toggles reachability; `sessionDirectory` is the
 *  `directory` returned for a `/proxy/assistant/session/<id>` lookup (null → 404,
 *  i.e. the session doesn't exist on the active endpoint). */
let probeOk = true;
let sessionDirectory: string | null = '/work';
function installFetchStub(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    // Session lookup on the active endpoint (resolves directory / existence).
    if (/\/proxy\/assistant\/session\//.test(url)) {
      if (sessionDirectory === null) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ id: 'x', directory: sessionDirectory }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // Root reachability probe.
    if (url.includes('/proxy/assistant/')) {
      return new Response(probeOk ? 'ok' : 'unreachable', { status: probeOk ? 200 : 503 });
    }
    // Benign default for any other fetch the navbar makes during render.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

const chatMock = vi.hoisted(() => ({
  sending: false,
  send: vi.fn().mockResolvedValue(undefined),
  alignActiveEndpoint: vi.fn(),
  setActiveSessionId: vi.fn(),
  // Navbar renders SessionPicker, which reads the per-endpoint session state.
  byEndpoint: new Map(),
  activeEndpointId: 'default',
  activeSessionId: null as string | null,
  liveConnected: false,
}));

vi.mock('$lib/chat/chat-state.svelte.js', () => ({ chat: chatMock }));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
  voiceState: {
    sttEngine: 'disabled',
    sttSupported: false,
    ttsSupported: false,
    status: 'idle',
    interimTranscript: '',
    autoplayBlocked: false,
    ttsAutoEnabled: false,
  },
  initVoice: vi.fn().mockResolvedValue(undefined),
  destroyVoice: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsAutoEnabled: vi.fn(),
  resumeAutoplay: vi.fn(),
}));

describe('/advanced/+page.svelte', () => {
  beforeEach(() => {
    resetThemeForTests();
    themeService.init();
    probeOk = true;
    sessionDirectory = '/work';
    mockPage.url = new URL('http://localhost/advanced');
    const active: MockConnection = {
      id: 'default',
      label: 'Local assistant',
      url: 'http://127.0.0.1:3800',
      kind: 'local-opencode',
      isDefault: true,
      hasPassword: false,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];
    mockEndpointsService.load.mockClear();
    chatMock.alignActiveEndpoint.mockReset().mockImplementation((endpointId: string) => {
      chatMock.activeEndpointId = endpointId;
    });
    chatMock.setActiveSessionId.mockReset().mockImplementation((sessionId: string, endpointId: string) => {
      if (chatMock.activeEndpointId === endpointId) chatMock.activeSessionId = sessionId;
    });
    chatMock.activeEndpointId = active.id;
    chatMock.activeSessionId = null;
    activationMock.listener = null;
    installFetchStub();
  });

  afterEach(() => {
    resetThemeForTests();
    vi.unstubAllGlobals();
  });

  test('renders the OpenCode iframe and exposes the theme toggle in the navbar', async () => {
    await render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();

    // Settings drawer was replaced with a 3-state theme toggle button in the Navbar.
    const themeBtn = page.getByRole('button', { name: /theme:/i });
    await expect.element(themeBtn).toBeVisible();
  });

  test('embeds an unauthenticated remote OpenCode target at its direct URL', async () => {
    const active: MockConnection = {
      id: 'remote',
      label: 'Workshop OpenCode',
      url: 'https://opencode.lan:4096',
      kind: 'remote-opencode',
      isDefault: false,
      hasPassword: false,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];

    await render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(active.url);
  });

  test('does not probe or embed credentialed raw OpenCode targets', async () => {
    const active: MockConnection = {
      id: 'secured',
      label: 'Secured OpenCode',
      url: 'https://secured.lan:4096',
      kind: 'remote-opencode',
      isDefault: false,
      hasPassword: true,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];

    await render(AdvancedPage);

    await expect.element(
      page.getByRole('heading', { name: 'Advanced UI unavailable for this secured connection' }),
    ).toBeVisible();
    await expect.element(page.getByRole('link', { name: 'Manage connection' })).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(active.url);
  });

  test('shows mixed-content guidance instead of mounting an HTTP remote frame on HTTPS', async () => {
    mockPage.url = new URL('https://localhost/advanced');
    const active: MockConnection = {
      id: 'http-remote',
      label: 'HTTP remote',
      url: 'http://assistant.lan:4096',
      kind: 'remote-opencode',
      isDefault: false,
      hasPassword: false,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];

    await render(AdvancedPage);

    await expect.element(
      page.getByRole('heading', { name: 'Advanced UI unavailable over this connection' }),
    ).toBeVisible();
    await expect.element(page.getByText(/browser will block/i)).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  test.each([
    {
      case: 'URL userinfo',
      url: 'https://user:secret@opencode.example:4096',
      heading: 'Advanced UI unavailable for this secured connection',
    },
    {
      case: 'a query',
      url: 'https://opencode.example:4096?workspace=one',
      heading: 'Advanced UI unavailable for this endpoint',
    },
    {
      case: 'a fragment',
      url: 'https://opencode.example:4096#workspace',
      heading: 'Advanced UI unavailable for this endpoint',
    },
    {
      case: 'a non-HTTP scheme',
      url: 'ftp://opencode.example:4096',
      heading: 'Advanced UI unavailable for this endpoint',
    },
  ])('rejects an Advanced endpoint containing $case before probing', async ({ url, heading }) => {
    const active: MockConnection = {
      id: 'unsafe',
      label: 'Unsafe OpenCode',
      url,
      kind: 'remote-opencode',
      isDefault: false,
      hasPassword: false,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];

    await render(AdvancedPage);

    await expect.element(page.getByRole('heading', { name: heading })).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(chatMock.alignActiveEndpoint).not.toHaveBeenCalled();
    expect(chatMock.setActiveSessionId).not.toHaveBeenCalled();
  });

  test('renders Guardian client API targets as externally managed without probing an iframe', async () => {
    const active: MockConnection = {
      id: 'guardian',
      label: 'Family OpenPalm',
      url: 'https://family.example/oc',
      kind: 'openpalm-client-api',
      isDefault: false,
      hasPassword: false,
    };
    mockEndpointsService.active = active;
    mockEndpointsService.activeId = active.id;
    mockEndpointsService.endpoints = [active];

    await render(AdvancedPage);

    await expect.element(
      page.getByRole('heading', { name: 'Advanced UI is managed externally' }),
    ).toBeVisible();
    await expect.element(page.getByText(/Guardian, not an embeddable OpenCode/)).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(active.url);
  });

  test('re-evaluates secure embedding policy when the active connection changes in place', async () => {
    await render(AdvancedPage);
    await expect.element(page.getByTitle('OpenCode — Advanced Chat')).toBeVisible();
    const fetchCallsBeforeSwitch = vi.mocked(fetch).mock.calls.length;

    const guardian: MockConnection = {
      id: 'guardian',
      label: 'Switched Guardian',
      url: 'https://guardian.example/oc',
      kind: 'openpalm-client-api',
      isDefault: false,
      hasPassword: true,
    };
    mockEndpointsService.active = guardian;
    mockEndpointsService.activeId = guardian.id;
    mockEndpointsService.endpoints = [guardian];
    await activationMock.listener?.();

    await expect.element(
      page.getByRole('heading', { name: 'Advanced UI is managed externally' }),
    ).toBeVisible();
    expect(document.querySelector('iframe')).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(fetchCallsBeforeSwitch);
  });

  test('discards endpoint A session data when endpoint B becomes active during the unresolved probe', async () => {
    mockPage.url = new URL('http://localhost/advanced?session=session-a');
    const sessionGate: { release?: (session: unknown) => void } = {};
    let sessionReadStarted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/proxy/assistant/session/session-a')) {
          return {
            ok: true,
            json: () => {
              sessionReadStarted = true;
              return new Promise<unknown>((resolve) => {
                sessionGate.release = resolve;
              });
            },
          } as Response;
        }
        return new Response('ok', { status: 200 });
      }),
    );

    await render(AdvancedPage);
    await vi.waitFor(() => expect(sessionReadStarted).toBe(true));

    const endpointB: MockConnection = {
      id: 'endpoint-b',
      label: 'Endpoint B',
      url: 'https://endpoint-b.example/oc',
      kind: 'openpalm-client-api',
      isDefault: false,
      hasPassword: true,
    };
    mockEndpointsService.active = endpointB;
    mockEndpointsService.activeId = endpointB.id;
    mockEndpointsService.endpoints = [endpointB];
    chatMock.activeEndpointId = endpointB.id;
    chatMock.activeSessionId = 'session-b';

    if (!sessionGate.release) throw new Error('session response was not pending');
    sessionGate.release({ id: 'session-a', directory: '/endpoint-a' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(chatMock.activeEndpointId).toBe(endpointB.id);
    expect(chatMock.activeSessionId).toBe('session-b');
    expect(chatMock.alignActiveEndpoint).not.toHaveBeenCalled();
    expect(chatMock.setActiveSessionId).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();

    await activationMock.listener?.();
    await expect.element(
      page.getByRole('heading', { name: 'Advanced UI is managed externally' }),
    ).toBeVisible();
    expect(chatMock.activeEndpointId).toBe(endpointB.id);
    expect(chatMock.activeSessionId).toBe('session-b');
    expect(chatMock.alignActiveEndpoint).not.toHaveBeenCalled();
    expect(chatMock.setActiveSessionId).not.toHaveBeenCalled();
  });

  test('aligns a direct remote Advanced entry before storing its validated session cursor', async () => {
    const remote: MockConnection = {
      id: 'remote-direct',
      label: 'Direct remote',
      url: 'https://remote.example:4096',
      kind: 'remote-opencode',
      isDefault: false,
      hasPassword: false,
    };
    mockEndpointsService.active = remote;
    mockEndpointsService.activeId = remote.id;
    mockEndpointsService.endpoints = [remote];
    mockPage.url = new URL('http://localhost/advanced?session=remote-session');
    chatMock.activeEndpointId = 'old-endpoint';
    chatMock.activeSessionId = 'old-session';

    await render(AdvancedPage);

    await expect.element(page.getByTitle('OpenCode — Advanced Chat')).toBeVisible();
    expect(chatMock.alignActiveEndpoint).toHaveBeenCalledWith(remote.id);
    expect(chatMock.setActiveSessionId).toHaveBeenCalledWith('remote-session', remote.id);
    expect(chatMock.alignActiveEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
      chatMock.setActiveSessionId.mock.invocationCallOrder[0],
    );
    expect(chatMock.activeEndpointId).toBe(remote.id);
    expect(chatMock.activeSessionId).toBe('remote-session');
  });

  test('shows an inline Reconnect affordance when the endpoint is unreachable', async () => {
    probeOk = false; // the probe to /proxy/assistant/ returns 503
    await render(AdvancedPage);

    // No broken iframe — a clear status + Reconnect instead.
    await expect.element(page.getByRole('heading', { name: /Can.t reach/ })).toBeVisible();
    const reconnect = page.getByRole('button', { name: 'Reconnect' });
    await expect.element(reconnect).toBeVisible();
    expect(document.querySelector('iframe[title="OpenCode — Advanced Chat"]')).toBeNull();

    // Recovering: the endpoint comes back, Reconnect re-probes and the frame loads.
    probeOk = true;
    await reconnect.click();
    await expect.element(page.getByTitle('OpenCode — Advanced Chat')).toBeVisible();
  });

  test('deep-links a requested session using its REAL directory, not a hardcoded path', async () => {
    mockPage.url = new URL('http://localhost/advanced?session=ses_known');
    sessionDirectory = '/work'; // the directory the session actually lives in
    await render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();
    const src = document.querySelector('iframe[title="OpenCode — Advanced Chat"]')?.getAttribute('src');
    // base64('/work') = 'L3dvcms' — the workspace segment must encode the real dir.
    expect(src).toContain('/L3dvcms/session/ses_known');
    // Never the old hardcoded path base64('/work/itlackey/openpalm').
    expect(src).not.toContain('L3dvcmsvaXRsYWNrZXkvb3BlbnBhbG0');
    expect(chatMock.setActiveSessionId).toHaveBeenCalledWith('ses_known', 'default');
  });

  test('falls back to the base URL when the session is not on the active endpoint', async () => {
    mockPage.url = new URL('http://localhost/advanced?session=ses_elsewhere');
    sessionDirectory = null; // the lookup 404s — session belongs to another endpoint
    await render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();
    const src = document.querySelector('iframe[title="OpenCode — Advanced Chat"]')?.getAttribute('src');
    // No broken /session/ deep link — just the endpoint base.
    expect(src).not.toContain('/session/');
    expect(src).toBe('http://127.0.0.1:3800');
    expect(chatMock.setActiveSessionId).not.toHaveBeenCalled();
  });
});
