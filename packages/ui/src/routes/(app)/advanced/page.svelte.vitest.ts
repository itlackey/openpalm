/**
 * What /advanced actually puts on screen for the locked default connection.
 *
 * The regression this pins: on every desktop install the locked connection is
 * this app's own `/oc` pass-through — correctly not framable, since OpenCode's
 * web UI is a root-mounted SPA — and the page fell straight through to the
 * native chat surface. /advanced became a second copy of /chat, which is
 * exactly what the route exists NOT to be. It frames OpenCode's own published
 * origin instead, which the server advertises as `opencodeWorkspace`.
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
const WORKSPACE_URL = `http://127.0.0.1:${WORKSPACE_PORT}`;
const NATIVE_NOTICE = 'runs on OpenPalm’s own surface';

const workspaceFrame = () => browserPage.getByTitle('OpenCode — Advanced Chat');
const nativeSurface = () => browserPage.getByText(NATIVE_NOTICE, { exact: false });

beforeEach(() => {
  mocks.displayMode = 'browser';
  mocks.opencodeWorkspace = undefined;
  mocks.active = { ...LOCKED_CONNECTION };
  mocks.probeHealth.mockResolvedValue({ status: 'accessible' });
  mocks.onEndpointChanged.mockClear();
});

describe('/advanced — the locked /oc connection frames OpenCode’s own origin', () => {
  test('frames the advertised workspace instead of falling back to chat', async () => {
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT, loopbackOnly: true, requiresAuth: false };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_URL);
  });

  test('keeps the native surface when there is no workspace to reach', async () => {
    render(AdvancedPage);

    await expect.element(nativeSurface()).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('a credentialed workspace is not framed in an ordinary browser', async () => {
    // No credential exists client-side, so the frame would render OpenCode's
    // 401 rather than the workspace.
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT, loopbackOnly: true, requiresAuth: true };
    render(AdvancedPage);

    await expect.element(nativeSurface()).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('the desktop shell frames it — it answers the Basic challenge in its main process', async () => {
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT, loopbackOnly: true, requiresAuth: true };
    mocks.displayMode = 'electron';
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_URL);
  });
});
