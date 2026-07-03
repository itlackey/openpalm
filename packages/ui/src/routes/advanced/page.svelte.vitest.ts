import type { AfterNavigate } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdvancedPage from './+page.svelte';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

// Mutable so individual tests can drive the `?session=` query param.
const mockPage = vi.hoisted(() => ({ url: new URL('http://localhost/advanced') }));
vi.mock('$app/state', () => ({ page: mockPage }));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  // Call the callback immediately to simulate the initial load navigation event.
  afterNavigate: vi.fn((cb: (nav: AfterNavigate) => void) =>
    cb({ to: mockPage, from: null, type: 'goto', complete: Promise.resolve(), delta: 0, willUnload: false } as unknown as AfterNavigate)
  ),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
    load: vi.fn().mockResolvedValue(undefined),
  },
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

vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: {
    sending: false,
    send: vi.fn().mockResolvedValue(undefined),
    setActiveSessionId: vi.fn(),
    // Navbar renders SessionPicker, which reads the per-endpoint session state.
    byEndpoint: new Map(),
    activeSessionId: null,
    liveConnected: false,
  },
}));

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
    const src = document.querySelector('iframe[title="OpenCode — Advanced Chat"]')!.getAttribute('src')!;
    // base64('/work') = 'L3dvcms' — the workspace segment must encode the real dir.
    expect(src).toContain('/L3dvcms/session/ses_known');
    // Never the old hardcoded path base64('/work/itlackey/openpalm').
    expect(src).not.toContain('L3dvcmsvaXRsYWNrZXkvb3BlbnBhbG0');
  });

  test('falls back to the base URL when the session is not on the active endpoint', async () => {
    mockPage.url = new URL('http://localhost/advanced?session=ses_elsewhere');
    sessionDirectory = null; // the lookup 404s — session belongs to another endpoint
    await render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();
    const src = document.querySelector('iframe[title="OpenCode — Advanced Chat"]')!.getAttribute('src')!;
    // No broken /session/ deep link — just the endpoint base.
    expect(src).not.toContain('/session/');
    expect(src).toBe('http://127.0.0.1:3800');
  });
});
