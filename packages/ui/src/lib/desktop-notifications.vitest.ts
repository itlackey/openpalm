import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  desktopNotifyEnabled,
  notifyAssistantError,
  notifyAssistantReply,
  setDesktopNotifyEnabled,
  setDesktopReplyPreviewEnabled,
} from './desktop-notifications.js';

describe('desktop notifications', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          clear: () => storage.clear(),
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
        openpalm: { notify: vi.fn() },
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { hasFocus: () => false },
    });
    window.localStorage.clear();
  });

  test('persists the desktop-notify toggle', () => {
    setDesktopNotifyEnabled(true);
    expect(desktopNotifyEnabled()).toBe(true);
    expect(window.localStorage.getItem('openpalm.desktop.notify')).toBe('1');
  });

  test('sends content-free reply notifications by default', () => {
    setDesktopNotifyEnabled(true);
    notifyAssistantReply('Top secret reply');
    expect(window.openpalm?.notify).toHaveBeenCalledWith('OpenPalm', 'Assistant replied');
  });

  test('includes reply preview only when explicitly enabled', () => {
    setDesktopNotifyEnabled(true);
    setDesktopReplyPreviewEnabled(true);
    notifyAssistantReply('Visible preview');
    expect(window.openpalm?.notify).toHaveBeenCalledWith('OpenPalm', 'Visible preview');
  });

  test('fires the content-free error notification', () => {
    setDesktopNotifyEnabled(true);
    notifyAssistantError();
    expect(window.openpalm?.notify).toHaveBeenCalledWith('OpenPalm', 'Assistant error');
  });
});
