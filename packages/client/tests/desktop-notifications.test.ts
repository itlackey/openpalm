/**
 * B12 [MEDIUM] (review 2026-07-10) — desktop notifications for replies/
 * errors were entirely absent from the client SPA: close-to-tray is the
 * app's resting state (Electron), so a long turn completing produced no
 * signal at all. Ported from packages/ui/src/lib/desktop-notifications.ts,
 * with a web `Notification` fallback added (per the review's fix guidance)
 * for the browser-tab case where `window.openpalm?.notify` doesn't exist —
 * the host app only ever runs inside Electron, so it never needed one.
 *
 * RED until packages/client/src/lib/desktop-notifications.ts exists.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

async function loadModule() {
  return import('../src/lib/desktop-notifications.ts');
}

type FakeWindow = {
  localStorage: {
    clear(): void;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  openpalm?: { notify: (title: string, body: string) => void };
  Notification?: {
    permission: NotificationPermission;
    requestPermission: () => Promise<NotificationPermission>;
  };
};

function installWindow(overrides: Partial<FakeWindow> = {}): {
  notifyCalls: Array<[string, string]>;
  focused: { value: boolean };
} {
  const storage = new Map<string, string>();
  const notifyCalls: Array<[string, string]> = [];
  const focused = { value: false };
  const win: FakeWindow = {
    localStorage: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    ...overrides,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { hasFocus: () => focused.value },
  });
  if (win.openpalm) {
    win.openpalm.notify = (title: string, body: string) => {
      notifyCalls.push([title, body]);
    };
  }
  return { notifyCalls, focused };
}

describe('desktop notifications — toggle persistence', () => {
  beforeEach(() => installWindow());
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  test('persists the desktop-notify toggle', async () => {
    const { desktopNotifyEnabled, setDesktopNotifyEnabled } = await loadModule();
    setDesktopNotifyEnabled(true);
    expect(desktopNotifyEnabled()).toBe(true);
  });
});

describe('desktop notifications — window.openpalm bridge (Electron)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  test('calls window.openpalm.notify with a content-free reply message by default', async () => {
    const { notifyAssistantReply, setDesktopNotifyEnabled } = await loadModule();
    const { notifyCalls } = installWindow({ openpalm: { notify: () => {} } });
    setDesktopNotifyEnabled(true);

    notifyAssistantReply('Top secret reply');
    expect(notifyCalls).toEqual([['OpenPalm', 'Assistant replied']]);
  });

  test('fires the content-free error notification', async () => {
    const { notifyAssistantError, setDesktopNotifyEnabled } = await loadModule();
    const { notifyCalls } = installWindow({ openpalm: { notify: () => {} } });
    setDesktopNotifyEnabled(true);

    notifyAssistantError();
    expect(notifyCalls).toEqual([['OpenPalm', 'Assistant error']]);
  });

  test('does nothing when notifications are disabled', async () => {
    const { notifyAssistantReply, setDesktopNotifyEnabled } = await loadModule();
    const { notifyCalls } = installWindow({ openpalm: { notify: () => {} } });
    setDesktopNotifyEnabled(false);

    notifyAssistantReply('hello');
    expect(notifyCalls).toEqual([]);
  });

  test('does nothing while the document has focus', async () => {
    const { notifyAssistantReply, setDesktopNotifyEnabled } = await loadModule();
    const { notifyCalls, focused } = installWindow({ openpalm: { notify: () => {} } });
    setDesktopNotifyEnabled(true);
    focused.value = true;

    notifyAssistantReply('hello');
    expect(notifyCalls).toEqual([]);
  });
});

describe('desktop notifications — web Notification fallback (browser tab, no Electron bridge)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  test('falls back to the web Notification API when window.openpalm is absent', async () => {
    const { notifyAssistantReply, setDesktopNotifyEnabled } = await loadModule();
    let created: { title: string; body?: string } | null = null;
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      constructor(title: string, options?: { body?: string }) {
        created = { title, body: options?.body };
      }
    }
    installWindow({ Notification: FakeNotification as unknown as FakeWindow['Notification'] });
    (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
    setDesktopNotifyEnabled(true);

    notifyAssistantReply('hello there');
    expect(created).toEqual({ title: 'OpenPalm', body: 'Assistant replied' });
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  test('does not construct a Notification when permission is not granted', async () => {
    const { notifyAssistantReply, setDesktopNotifyEnabled } = await loadModule();
    let constructed = false;
    class FakeNotification {
      static permission: NotificationPermission = 'denied';
      constructor() {
        constructed = true;
      }
    }
    installWindow({ Notification: FakeNotification as unknown as FakeWindow['Notification'] });
    (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
    setDesktopNotifyEnabled(true);

    notifyAssistantReply('hello there');
    expect(constructed).toBe(false);
    delete (globalThis as { Notification?: unknown }).Notification;
  });
});
