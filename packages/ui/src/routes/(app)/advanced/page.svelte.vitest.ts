/**
 * What /advanced actually puts on screen for the locked default connection.
 *
 * The regression this pins: on every desktop install the locked connection is
 * this app's own `/oc` pass-through, and the page fell straight through to the
 * native chat surface. /advanced became a second copy of /chat, which is
 * exactly what the route exists NOT to be.
 *
 * It now frames the same-origin `/_opencode` workspace proxy. That is a
 * stronger claim than the `opencodeWorkspace` advertisement it replaced: the
 * advertisement is a PORT, so it only ever existed for a browser on the
 * machine that published it, and never for a credentialed OpenCode. The proxy
 * rides the origin the browser already loaded, so the frame survives a reverse
 * proxy, a phone on the LAN, a tailnet, and `OPENCODE_AUTH=true` alike.
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
  displayMode: 'browser' as 'browser' | 'electron',
  opencodeWorkspace: undefined as
    | { port: number; loopbackOnly: boolean; requiresAuth: boolean }
    | undefined,
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
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({
    routes: {},
    effectiveCapabilities: [],
    uiVersion: 'test',
    clientContext: { displayMode: mocks.displayMode },
    opencodeWorkspace: mocks.opencodeWorkspace,
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

const WORKSPACE_PORT = 39810;
const WORKSPACE_PROXY_PATH = '/_opencode';
const NATIVE_NOTICE = 'runs on OpenPalm’s own surface';

const workspaceFrame = () => browserPage.getByTitle('OpenCode — Advanced Chat');
const nativeSurface = () => browserPage.getByText(NATIVE_NOTICE, { exact: false });

beforeEach(() => {
  mocks.appPage.url = new URL('http://127.0.0.1:3800/advanced');
  mocks.displayMode = 'browser';
  mocks.opencodeWorkspace = undefined;
  mocks.active = { ...LOCKED_CONNECTION };
  mocks.probeHealth.mockResolvedValue({ status: 'accessible' });
  mocks.onEndpointChanged.mockClear();
});

describe('/advanced — the locked /oc connection frames the same-origin workspace proxy', () => {
  test('frames /_opencode instead of falling back to chat', async () => {
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_PROXY_PATH);
  });

  test('needs no published assistant port — the hop is server-side', async () => {
    // The `opencodeWorkspace` advertisement is absent here. Under the old
    // direct-port frame that was the "no workspace to reach" case and the page
    // rendered the native surface; nothing about the proxy depends on it.
    mocks.opencodeWorkspace = undefined;
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_PROXY_PATH);
    expect(nativeSurface().elements()).toHaveLength(0);
  });

  test('frames it with OpenCode auth on — the credential is attached by the proxy', async () => {
    // The direct-port frame could not: no OpenCode credential exists
    // client-side, so it rendered OpenCode's 401 instead of the workspace.
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT, loopbackOnly: true, requiresAuth: true };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_PROXY_PATH);
  });

  test('frames it from a LAN client, where a loopback-only publish does not exist', async () => {
    // The store resolves the locked connection against the visited origin
    // (resolveLockedBaseUrl), so a LAN browser holds the LAN spelling.
    mocks.appPage.url = new URL('http://192.168.0.201:3800/advanced');
    mocks.active = { ...LOCKED_CONNECTION, baseUrl: 'http://192.168.0.201:3800/oc' };
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT, loopbackOnly: true, requiresAuth: false };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_PROXY_PATH);
  });

  test('the desktop shell frames the same proxy', async () => {
    mocks.displayMode = 'electron';
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_PROXY_PATH);
  });
});

describe('/advanced — connections this app cannot serve from its own origin', () => {
  test('a credentialed remote connection still falls back to the native surface', async () => {
    // The proxy forwards to THIS process's assistant, so it is not an answer
    // for a connection naming someone else's OpenCode; OpenPalm also keeps
    // Basic credentials out of iframe URLs, so the frame could not authenticate.
    mocks.active = {
      id: 'remote-1',
      label: 'Remote assistant',
      baseUrl: 'https://assistant.example',
      hasPassword: true,
      isDefault: false,
    };
    render(AdvancedPage);

    await expect.element(nativeSurface()).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('a framable remote OpenCode frames itself, not the local workspace proxy', async () => {
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
