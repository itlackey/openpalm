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
  opencodeWorkspace: undefined as { port: number } | undefined,
  workspaceReachable: true,
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
// The workspace probe is a real network call against a port that does not exist
// under vitest; its VERDICT is what this page's branching turns on, and
// embeddable.vitest.ts covers how that verdict is reached.
vi.mock('./embeddable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./embeddable.js')>()),
  isWorkspaceReachable: () => Promise.resolve(mocks.workspaceReachable),
}));

import AdvancedPage from './+page.svelte';

const WORKSPACE_PORT = 39810;
const WORKSPACE_URL = `http://127.0.0.1:${WORKSPACE_PORT}`;
const NATIVE_NOTICE = 'runs on OpenPalm’s own surface';

const workspaceFrame = () => browserPage.getByTitle('OpenCode — Advanced Chat');
const nativeSurface = () => browserPage.getByText(NATIVE_NOTICE, { exact: false });

beforeEach(() => {
  mocks.displayMode = 'browser';
  mocks.opencodeWorkspace = undefined;
  mocks.workspaceReachable = true;
  mocks.active = { ...LOCKED_CONNECTION };
  mocks.probeHealth.mockResolvedValue({ status: 'accessible' });
  mocks.onEndpointChanged.mockClear();
});

describe('/advanced — the locked /oc connection frames OpenCode’s own origin', () => {
  test('frames the advertised workspace instead of falling back to chat', async () => {
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT };
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_URL);
  });

  test('keeps the native surface when there is no workspace advertised', async () => {
    render(AdvancedPage);

    await expect.element(nativeSurface()).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('keeps the native surface when the advertised port does not answer', async () => {
    // The address composes fine — it is this page's own host and the server's
    // port — but nothing forwarded that port to this browser. A blank frame is
    // the failure this replaces.
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT };
    mocks.workspaceReachable = false;
    render(AdvancedPage);

    await expect.element(nativeSurface()).toBeVisible();
    expect(workspaceFrame().elements()).toHaveLength(0);
  });

  test('frames it in an ordinary browser — the workspace needs no client credential', async () => {
    // The listener behind that port authenticates with the op_session cookie
    // the browser already holds and attaches OpenCode's own password upstream,
    // so there is nothing for the client to supply and no capability to gate on.
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT };
    mocks.displayMode = 'browser';
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_URL);
  });

  test('frames it in the desktop shell on the same terms', async () => {
    mocks.opencodeWorkspace = { port: WORKSPACE_PORT };
    mocks.displayMode = 'electron';
    render(AdvancedPage);

    await expect.element(workspaceFrame()).toHaveAttribute('src', WORKSPACE_URL);
  });
});
