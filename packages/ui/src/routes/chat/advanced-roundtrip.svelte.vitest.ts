import type { AfterNavigate } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ChatPage from './+page.svelte';
import AdvancedPage from '../advanced/+page.svelte';
import { advancedModeService } from '$lib/advanced-mode-state.svelte.js';
import { chat } from '$lib/chat/chat-state.svelte.js';
import type { ToolStripEntry } from '$lib/chat/tool-strip.js';
import { resetThemeForTests, themeService } from '$lib/theme-state.svelte.js';

const mockPage = vi.hoisted(() => ({ url: new URL('http://localhost/chat') }));
const gotoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('$app/state', () => ({ page: mockPage }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/navigation', () => ({
  goto: gotoMock,
  afterNavigate: vi.fn((callback: (navigation: AfterNavigate) => void) => {
    callback({
      to: mockPage,
      from: null,
      type: 'goto',
      complete: Promise.resolve(),
      delta: 0,
      willUnload: false,
    } as unknown as AfterNavigate);
  }),
}));

const endpoint = {
  id: 'alpha',
  label: 'Local assistant',
  url: 'http://127.0.0.1:3800',
  kind: 'local-opencode' as const,
  isDefault: true,
  hasPassword: false,
};
const endpointsServiceMock = vi.hoisted(() => ({
  endpoints: [] as typeof endpoint[],
  activeId: 'alpha',
  active: null as typeof endpoint | null,
  loading: false,
  loaded: true,
  error: '',
  load: vi.fn().mockResolvedValue(undefined),
  activate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/endpoints-state.svelte.js', () => ({ endpointsService: endpointsServiceMock }));

const apiMocks = vi.hoisted(() => ({
  abortChatTurn: vi.fn(),
  createSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  rejectChatQuestion: vi.fn(),
  replyChatPermission: vi.fn(),
  replyChatQuestion: vi.fn(),
  sendChatMessage: vi.fn(),
  startChatMessageTurn: vi.fn(),
}));

vi.mock('$lib/api.js', () => apiMocks);
vi.mock('$lib/api/chat.js', () => ({ probeChatBackend: vi.fn().mockResolvedValue(true) }));

type EventHandlers = {
  onConnect?: () => void;
  onDisconnect?: (error: Error) => void;
};
const eventRuntime = vi.hoisted(() => ({
  subscriptions: [] as { handlers: EventHandlers; unsubscribe: ReturnType<typeof vi.fn> }[],
  subscribe: vi.fn((handlers: EventHandlers) => {
    const unsubscribe = vi.fn();
    eventRuntime.subscriptions.push({ handlers, unsubscribe });
    return unsubscribe;
  }),
}));

vi.mock('$lib/chat/session-events.js', () => ({
  subscribeSessionEvents: eventRuntime.subscribe,
}));

const voiceStateMock = vi.hoisted(() => ({
  sttEngine: 'browser',
  sttSupported: true,
  ttsSupported: true,
  ttsAutoEnabled: false,
  conversationActive: false,
  status: 'idle',
  interimTranscript: '',
  autoplayBlocked: false,
  errorMessage: '',
}));

vi.mock('$lib/voice/voice-state.svelte.js', () => ({
  voiceState: voiceStateMock,
  initVoice: vi.fn().mockResolvedValue(undefined),
  destroyVoice: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  startConversation: vi.fn(),
  stopConversation: vi.fn(),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
  setTtsAutoEnabled: vi.fn((enabled: boolean) => {
    voiceStateMock.ttsAutoEnabled = enabled;
  }),
  resumeAutoplay: vi.fn(),
}));

vi.mock('$lib/voice/earcon.js', () => ({ playAck: vi.fn() }));

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe('host chat Advanced round trip', () => {
  beforeEach(() => {
    chat.reset();
    chat.activeEndpointId = endpoint.id;
    chat.sending = false;
    chat.error = '';
    eventRuntime.subscriptions.length = 0;
    eventRuntime.subscribe.mockClear();
    gotoMock.mockClear();
    mockPage.url = new URL('http://localhost/chat');
    endpointsServiceMock.endpoints = [endpoint];
    endpointsServiceMock.active = endpoint;
    endpointsServiceMock.activeId = endpoint.id;
    endpointsServiceMock.load.mockClear();
    apiMocks.listSessions.mockReset().mockResolvedValue([
      { id: 'ses_active', title: 'Active session', createdAt: 1, updatedAt: 2 },
    ]);
    apiMocks.getSessionMessages.mockReset().mockResolvedValue([
      { id: 'message-1', role: 'user', text: 'Keep this conversation', timestamp: 1 },
    ]);
    window.localStorage.removeItem('openpalm.chat.advanced');
    advancedModeService.initialized = false;
    advancedModeService.setEnabled(false);
    voiceStateMock.status = 'idle';
    voiceStateMock.conversationActive = false;
    voiceStateMock.ttsAutoEnabled = false;
    resetThemeForTests();
    themeService.init();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/proxy/assistant/session/ses_active')) {
          return new Response(JSON.stringify({ id: 'ses_active', directory: '/work' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('ok', { status: 200 });
      }),
    );
  });

  afterEach(async () => {
    chat.reset();
    resetThemeForTests();
    vi.unstubAllGlobals();
    await page.viewport(1280, 720);
  });

  test('preserves endpoint/session and replaces the live event stream without a reconnect error', async () => {
    const firstChat = render(ChatPage);
    await vi.waitFor(() => expect(eventRuntime.subscriptions).toHaveLength(1));
    eventRuntime.subscriptions[0].handlers.onConnect?.();
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    expect(chat.activeEndpointId).toBe(endpoint.id);
    expect(chat.activeSessionId).toBe('ses_active');
    expect(chat.liveConnected).toBe(true);

    await page.getByRole('button', { name: 'Advanced mode', exact: true }).click();
    expect(gotoMock).toHaveBeenLastCalledWith('/advanced?session=ses_active');
    firstChat.unmount();

    mockPage.url = new URL('http://localhost/advanced?session=ses_active');
    const advanced = render(AdvancedPage);
    await expect.element(page.getByTitle('OpenCode — Advanced Chat')).toBeVisible();
    expect(chat.activeEndpointId).toBe(endpoint.id);
    expect(chat.activeSessionId).toBe('ses_active');

    await page.getByRole('button', { name: 'Advanced mode', exact: true }).click();
    expect(gotoMock).toHaveBeenLastCalledWith('/chat?session=ses_active');
    advanced.unmount();

    mockPage.url = new URL('http://localhost/chat?session=ses_active');
    const returnedChat = render(ChatPage);
    await vi.waitFor(() => expect(eventRuntime.subscriptions).toHaveLength(2));
    expect(eventRuntime.subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    eventRuntime.subscriptions[1].handlers.onConnect?.();

    expect(chat.activeEndpointId).toBe(endpoint.id);
    expect(chat.activeSessionId).toBe('ses_active');
    expect(chat.liveConnected).toBe(true);
    expect(chat.error).toBe('');
    expect(apiMocks.getSessionMessages).toHaveBeenCalledTimes(2);
    await expect.element(page.getByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();

    const conversations = document.querySelector<HTMLButtonElement>(
      '.s-corner-bottom-left button[aria-label="Conversations"]',
    );
    expect(conversations).not.toBeNull();
    expect(
      document.querySelector('.s-corner-bottom-left .s-glyph-cell:first-child button'),
    ).toBe(conversations);
    expect(document.querySelector('.s-corner-bottom-left button[aria-label="Activity"]')).not.toBeNull();
    expect(
      document.querySelector('.s-corner-bottom-right button[aria-label="Turn on spoken responses"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('.s-corner-bottom-right button[aria-label="Start recording"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('.s-corner-bottom-right button[aria-label="Start conversation mode"]'),
    ).not.toBeNull();
    expect(document.querySelector('.s-composer button[aria-label="Start recording"]')).toBeNull();
    expect(document.querySelector('.s-composer button[aria-label="Start conversation mode"]')).toBeNull();
    expect(document.querySelector('.s-presence[role="button"]')).toBeNull();

    returnedChat.unmount();
  });

  test('keeps the composer clear of both footer clusters at phone and tablet widths', async () => {
    await page.viewport(768, 1024);
    const view = render(ChatPage);
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

    for (const [width, height] of [
      [390, 844],
      [768, 500],
      [768, 1024],
      [820, 1180],
      [900, 1024],
      [1024, 768],
    ] as const) {
      await page.viewport(width, height);
      await settleLayout();

      const composer = document.querySelector<HTMLElement>('.s-composer');
      const base = document.querySelector<HTMLElement>('.s-base');
      const left = document.querySelector<HTMLElement>('.s-corner-bottom-left');
      const right = document.querySelector<HTMLElement>('.s-corner-bottom-right');
      expect(composer, `composer exists at ${width}px`).not.toBeNull();
      expect(base, `composer base exists at ${width}px`).not.toBeNull();
      expect(left, `left footer exists at ${width}px`).not.toBeNull();
      expect(right, `right footer exists at ${width}px`).not.toBeNull();
      if (!composer || !base || !left || !right) continue;
      expect(
        Number.parseFloat(getComputedStyle(base).paddingBottom),
        `footer-row padding is reserved at ${width}px`,
      ).toBeGreaterThanOrEqual(84);

      const composerRect = composer.getBoundingClientRect();
      expect(
        overlaps(composerRect, left.getBoundingClientRect()),
        `left footer must not overlap composer at ${width}x${height}`,
      ).toBe(false);
      expect(
        overlaps(composerRect, right.getBoundingClientRect()),
        `right footer must not overlap composer at ${width}x${height}`,
      ).toBe(false);

      const visibleFooterButtons = document.querySelectorAll<HTMLButtonElement>(
        '.s-corner-bottom-left .s-glyph-btn, .s-corner-bottom-right .s-glyph-btn',
      );
      for (const button of visibleFooterButtons) {
        if (getComputedStyle(button).display === 'none' || button.getClientRects().length === 0) continue;
        const rect = button.getBoundingClientRect();
        expect(rect.width, `${button.ariaLabel} width at ${width}px`).toBeGreaterThanOrEqual(44);
        expect(rect.height, `${button.ariaLabel} height at ${width}px`).toBeGreaterThanOrEqual(44);
      }
    }

    view.unmount();
  });

  test('keeps a populated activity rail and desktop voice cluster clear of composer actions', async () => {
    await page.viewport(901, 768);
    const view = render(ChatPage);
    await expect.element(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    const activity: ToolStripEntry = {
      id: 'tool-1',
      kind: 'tool',
      tool: 'bash',
      status: 'running',
      title: 'Running a command',
      detail: 'checking the workspace',
      output: '',
      error: '',
      updatedAt: Date.now(),
    };
    chat.pendingToolStates = [activity];
    await vi.waitFor(() =>
      expect(document.querySelector('.s-tool-rail.has-items .tool-log')).not.toBeNull(),
    );

    for (const width of [901, 960, 1007, 1024, 1101, 1200, 1280]) {
      await page.viewport(width, 768);
      await settleLayout();

      const composer = document.querySelector<HTMLElement>('.s-composer');
      const rail = document.querySelector<HTMLElement>('.s-tool-rail.has-items');
      const voiceCluster = document.querySelector<HTMLElement>('.s-corner-bottom-right');
      const send = document.querySelector<HTMLButtonElement>('.s-composer button[aria-label="Send message"]');
      expect(composer, `composer exists at ${width}px`).not.toBeNull();
      expect(rail, `populated rail exists at ${width}px`).not.toBeNull();
      expect(voiceCluster, `voice cluster exists at ${width}px`).not.toBeNull();
      expect(send, `send control exists at ${width}px`).not.toBeNull();
      if (!composer || !rail || !voiceCluster || !send) continue;

      const composerRect = composer.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      const voiceRect = voiceCluster.getBoundingClientRect();
      expect(
        overlaps(composerRect, railRect),
        `populated activity rail must not overlap composer at ${width}px`,
      ).toBe(false);
      expect(composerRect.left, `composer starts after rail at ${width}px`).toBeGreaterThanOrEqual(
        railRect.right,
      );
      expect(
        overlaps(composerRect, voiceRect),
        `voice cluster must not overlap composer at ${width}px`,
      ).toBe(false);
      expect(
        overlaps(send.getBoundingClientRect(), voiceRect),
        `voice cluster must not overlap send at ${width}px`,
      ).toBe(false);
    }

    chat.sending = true;
    await expect.element(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    for (const width of [1101, 1200, 1280]) {
      await page.viewport(width, 768);
      await settleLayout();

      const stop = document.querySelector<HTMLButtonElement>(
        '.s-composer button[aria-label="Stop generating"]',
      );
      const voiceCluster = document.querySelector<HTMLElement>('.s-corner-bottom-right');
      expect(stop, `stop control exists at ${width}px`).not.toBeNull();
      expect(voiceCluster, `voice cluster exists at ${width}px`).not.toBeNull();
      if (!stop || !voiceCluster) continue;
      expect(
        overlaps(stop.getBoundingClientRect(), voiceCluster.getBoundingClientRect()),
        `voice cluster must not overlap stop at ${width}px`,
      ).toBe(false);
    }

    chat.sending = false;
    view.unmount();
  });

  test('shows a persistent visual pressed indicator when recording and conversation labels are hidden', async () => {
    await page.viewport(768, 500);

    voiceStateMock.status = 'recording';
    voiceStateMock.conversationActive = false;
    const recordingView = render(ChatPage);
    const recording = page.getByRole('button', { name: 'Stop recording' });
    await expect.element(recording).toBeVisible();
    await settleLayout();
    const recordingButton = document.querySelector<HTMLButtonElement>(
      '.s-corner-bottom-right button[aria-label="Stop recording"]',
    );
    expect(recordingButton?.getAttribute('aria-pressed')).toBe('true');
    expect(getComputedStyle(recordingButton?.parentElement?.querySelector('.s-glyph-label') as Element).display).toBe('none');
    expect(recordingButton?.classList.contains('active')).toBe(true);
    expect(getComputedStyle(recordingButton as Element, '::after').borderTopStyle).toBe('solid');
    recordingView.unmount();

    voiceStateMock.status = 'recording';
    voiceStateMock.conversationActive = true;
    const conversationView = render(ChatPage);
    const conversation = page.getByRole('button', { name: 'End conversation mode' });
    await expect.element(conversation).toBeVisible();
    await settleLayout();
    const conversationButton = document.querySelector<HTMLButtonElement>(
      '.s-corner-bottom-right button[aria-label="End conversation mode"]',
    );
    expect(conversationButton?.getAttribute('aria-pressed')).toBe('true');
    expect(getComputedStyle(conversationButton?.parentElement?.querySelector('.s-glyph-label') as Element).display).toBe('none');
    expect(conversationButton?.classList.contains('active')).toBe(true);
    expect(getComputedStyle(conversationButton as Element, '::after').borderTopStyle).toBe('solid');
    conversationView.unmount();
  });
});
