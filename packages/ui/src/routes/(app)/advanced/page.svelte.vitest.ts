/**
 * What /advanced actually puts on screen.
 *
 * The regression this pins: on every install the locked connection is this
 * app's own `/oc` pass-through, and the page used to fall through to a
 * degraded duplicate chat surface. It now frames the static OpenCode web-UI
 * bundle at /opencode-ui/ — same origin, so the frame survives loopback, LAN,
 * and reverse-proxied deployments identically — and a connection that cannot
 * be framed gets an honest notice pointing at /chat instead of a worse chat.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page as browserPage } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

const LOCKED_CONNECTION = {
  id: 'openpalm-assistant-opencode',
  label: 'Local assistant',
  baseUrl: 'http://127.0.0.1:3800/oc',
  hasPassword: false,
  isDefault: true,
};

const mocks = vi.hoisted(() => ({
  appPage: { url: new URL('http://127.0.0.1:3800/advanced') },
  goto: vi.fn().mockResolvedValue(undefined),
  afterNavigate: vi.fn(),
  active: null as Record<string, unknown> | null,
  probeHealth: vi.fn(),
  request: vi.fn(),
  onEndpointChanged: vi.fn().mockResolvedValue(undefined),
  openSession: vi.fn().mockResolvedValue(undefined),
}));

// afterNavigate is the page's "arrive at this route" hook; run it on mount.
vi.mock('$app/navigation', () => ({
  afterNavigate: (callback: () => void) => {
    mocks.afterNavigate();
    callback();
  },
  goto: mocks.goto,
}));
vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
// The page itself no longer reads runtime context, but the chrome it mounts
// (ConversationFrame → ChatNavbar) does.
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({
    routes: {},
    effectiveCapabilities: [],
    uiVersion: 'test',
    clientContext: { displayMode: 'browser' },
  }),
  hasCapability: () => false,
}));
vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: {
    get active() {
      return mocks.active;
    },
    get activeId() {
      return mocks.active?.id ?? null;
    },
    get endpoints() {
      return mocks.active ? [mocks.active] : [];
    },
    loading: false,
    error: null,
    load: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('$lib/chat/chat-state.svelte.js', () => ({
  chat: {
    byEndpoint: new Map(),
    activeEndpointId: null,
    activeSessionId: null,
    entries: [],
    entriesLoading: false,
    sending: false,
    liveConnected: false,
    error: null,
    pendingAssistantText: '',
    pendingPermission: null,
    pendingQuestion: null,
    onEndpointChanged: mocks.onEndpointChanged,
    openSession: mocks.openSession,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stopTurn: vi.fn().mockResolvedValue(undefined),
    answerPermission: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    rejectQuestion: vi.fn().mockResolvedValue(undefined),
    setQuestionAnswer: vi.fn(),
  },
}));
// The transport is what this page reads; the other exports are stubbed only
// because the surrounding chrome imports them (they open no IndexedDB here).
vi.mock('$lib/connections/boot.js', () => ({
  getTransport: () => ({ probeHealth: mocks.probeHealth, request: mocks.request }),
  getConnectionStore: () => ({}),
  getSecretStore: () => ({}),
  getConnectionStorageMode: () => Promise.resolve('persistent'),
  setActiveConnection: vi.fn(),
}));
vi.mock('$lib/connection-events.js', () => ({ onConnectionActivated: () => () => {} }));

import AdvancedPage from './+page.svelte';

const SHELL_URL = '/opencode-ui/';
const NOTICE = 'can’t be embedded here';

const workspaceFrame = () => browserPage.getByTitle('OpenCode — Advanced Chat');
const notice = () => browserPage.getByText(NOTICE, { exact: false });

beforeEach(() => {
  mocks.appPage.url = new URL('http://127.0.0.1:3800/advanced');
  mocks.active = { ...LOCKED_CONNECTION };
  mocks.probeHealth.mockResolvedValue({ status: 'accessible' });
  mocks.onEndpointChanged.mockClear();
  mocks.openSession.mockClear();
});

describe('/advanced — the locked connection frames the static bundle', () => {
  test('frames /opencode-ui/ instead of falling back to a chat copy', async () => {
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', SHELL_URL);
  });

  test('frames it from a LAN client identically — same origin, no port math', async () => {
    mocks.appPage.url = new URL('http://192.168.0.201:3800/advanced');
    mocks.active = { ...LOCKED_CONNECTION, baseUrl: 'http://192.168.0.201:3800/oc' };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', SHELL_URL);
  });

  test('a ?session deep link becomes the app’s server-scoped session route', async () => {
    mocks.appPage.url = new URL('http://127.0.0.1:3800/advanced?session=ses_42');
    render(AdvancedPage);

    const key = btoa('http://127.0.0.1:3800/oc').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    await expect
      .element(workspaceFrame())
      .toHaveAttribute('src', `/opencode-ui/server/${key}/session/ses_42`);
    // The chat store follows, so ChatNavbar's picker names the same thread.
    expect(mocks.openSession).toHaveBeenCalledWith('ses_42');
  });

  test('an unreachable assistant renders the dead state, not a dead frame', async () => {
    mocks.probeHealth.mockResolvedValue({ status: 'unreachable' });
    render(AdvancedPage);

    await expect.element(browserPage.getByText('Can’t reach', { exact: false })).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });
});

describe('/advanced — connections this page cannot frame', () => {
  test('a credentialed remote connection gets the notice with a link to /chat', async () => {
    // OpenPalm keeps Basic credentials out of iframe URLs, so an embedded UI
    // could not authenticate; /chat is the full-featured surface for these.
    mocks.active = {
      id: 'remote-1',
      label: 'Remote assistant',
      baseUrl: 'https://assistant.example',
      hasPassword: true,
      isDefault: false,
    };
    render(AdvancedPage);

    await expect.element(notice()).toBeVisible();
    await expect.element(browserPage.getByText('Continue in Chat')).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('a framable remote OpenCode frames itself, not the local bundle', async () => {
    mocks.active = {
      id: 'remote-2',
      label: 'Remote assistant',
      baseUrl: 'http://127.0.0.1:4096',
      hasPassword: false,
      isDefault: false,
    };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', 'http://127.0.0.1:4096');
  });
});
