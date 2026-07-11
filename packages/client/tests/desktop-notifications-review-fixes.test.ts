/**
 * F7 (review 2026-07-11) — the B12 desktop-notifications feature was inert:
 * nothing in packages/client ever WROTE 'openpalm.desktop.notify', so
 * `desktopNotifyEnabled()` (and therefore `shouldNotifyDesktop()`, which it
 * gates) could never be anything but false, and
 * notifyAssistantReply()/notifyAssistantError() never fired regardless of
 * how a turn ended. Fix: a reachable client UI control that flips the
 * preference and requests the browser Notification permission on enable.
 *
 * `toggleDesktopNotify()` is the pure, independently-testable piece the UI
 * wiring calls (packages/client has no component-render harness, so the
 * actual button is pinned separately in a source test) — it writes the
 * preference AND requests permission, mirroring the host app's
 * UpdatesTab.svelte onchange handler adapted to a toggle button instead of a
 * checkbox.
 *
 * RED until packages/client/src/lib/desktop-notifications.ts exports it.
 */
import { afterEach, describe, expect, test } from 'bun:test';

async function loadModule() {
  return import('../src/lib/desktop-notifications.ts');
}

type FakeWindow = {
  localStorage: {
    clear(): void;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  Notification?: {
    permission: NotificationPermission;
    requestPermission: () => Promise<NotificationPermission>;
  };
};

function installWindow(overrides: Partial<FakeWindow> = {}): { permissionRequests: number } {
  const storage = new Map<string, string>();
  const counter = { permissionRequests: 0 };
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
    value: { hasFocus: () => false },
  });
  return counter;
}

describe('toggleDesktopNotify() — F7', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  test('turning it ON persists the preference and requests Notification permission', async () => {
    let requested = 0;
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission(): Promise<NotificationPermission> {
        requested += 1;
        FakeNotification.permission = 'granted';
        return 'granted';
      }
    }
    installWindow({ Notification: FakeNotification as unknown as FakeWindow['Notification'] });

    const { toggleDesktopNotify, desktopNotifyEnabled } = await loadModule();
    const next = toggleDesktopNotify(false);
    expect(next).toBe(true);
    expect(desktopNotifyEnabled()).toBe(true);
    // Give the (fire-and-forget) permission request's microtask a tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(requested).toBe(1);
  });

  test('turning it OFF persists the preference and does NOT request permission again', async () => {
    let requested = 0;
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static async requestPermission(): Promise<NotificationPermission> {
        requested += 1;
        return 'granted';
      }
    }
    installWindow({ Notification: FakeNotification as unknown as FakeWindow['Notification'] });

    const { toggleDesktopNotify, desktopNotifyEnabled } = await loadModule();
    const next = toggleDesktopNotify(true);
    expect(next).toBe(false);
    expect(desktopNotifyEnabled()).toBe(false);
    await Promise.resolve();
    expect(requested).toBe(0);
  });

  test('round-trips: after toggling on, notifyAssistantReply actually fires (shouldNotifyDesktop reflects the new preference)', async () => {
    const notifyCalls: Array<[string, string]> = [];
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static async requestPermission(): Promise<NotificationPermission> {
        return 'granted';
      }
      constructor(title: string, options?: { body?: string }) {
        notifyCalls.push([title, options?.body ?? '']);
      }
    }
    installWindow({ Notification: FakeNotification as unknown as FakeWindow['Notification'] });
    (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;

    const { toggleDesktopNotify, notifyAssistantReply } = await loadModule();
    // Before toggling on, the feature is inert (this is the exact bug).
    notifyAssistantReply('hello');
    expect(notifyCalls).toEqual([]);

    toggleDesktopNotify(false);
    notifyAssistantReply('hello again');
    expect(notifyCalls).toEqual([['OpenPalm', 'Assistant replied']]);

    delete (globalThis as { Notification?: unknown }).Notification;
  });
});
