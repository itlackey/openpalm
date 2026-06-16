import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdvancedPage from './+page.svelte';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost/advanced'),
  },
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: vi.fn(),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    active: { id: 'default', label: 'Local assistant', url: 'http://127.0.0.1:3800', isDefault: true },
    load: vi.fn().mockResolvedValue(undefined),
  },
}));

/** Stub the endpoint-reachability probe. By default the active endpoint is
 *  reachable (200) so the iframe renders; tests can override `probeOk`. */
let probeOk = true;
function installFetchStub(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
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
    installFetchStub();
  });

  afterEach(() => {
    resetThemeForTests();
    vi.unstubAllGlobals();
  });

  test('opens the settings drawer above the OpenCode iframe', async () => {
    render(AdvancedPage);

    const iframe = page.getByTitle('OpenCode — Advanced Chat');
    await expect.element(iframe).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole('link', { name: 'Manage this assistant...' })).toBeVisible();

    const drawerElement = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
    const iframeElement = document.querySelector<HTMLIFrameElement>('iframe[title="OpenCode — Advanced Chat"]');

    expect(drawerElement).not.toBeNull();
    expect(iframeElement).not.toBeNull();

    const drawerPosition = drawerElement ? getComputedStyle(drawerElement).position : '';
    const drawerZIndex = drawerElement ? getComputedStyle(drawerElement).zIndex : '0';
    const iframeZIndex = iframeElement ? getComputedStyle(iframeElement).zIndex : '0';

    expect(drawerPosition).toBe('fixed');
    expect(Number.parseInt(drawerZIndex, 10)).toBeGreaterThan(Number.parseInt(iframeZIndex, 10) || 0);
  });

  test('shows an inline Reconnect affordance when the endpoint is unreachable', async () => {
    probeOk = false; // the probe to /proxy/assistant/ returns 503
    render(AdvancedPage);

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
});
