// Run via vitest (Node), NOT bun test — same reason as main.test.ts (bun
// executes the real 'electron' module and can't honor vi.mock() hoisting).
//
// Pins the browser-chat and admin entries to their supplied callbacks.
import { describe, it, expect, vi } from 'vitest';

const { mockBuildFromTemplate, mockTrayInstance } = vi.hoisted(() => ({
  mockBuildFromTemplate: vi.fn((template: unknown) => template),
  mockTrayInstance: { setToolTip: vi.fn(), setContextMenu: vi.fn(), setImage: vi.fn(), on: vi.fn() },
}));

vi.mock('electron', () => {
  // Self-referential fake NativeImage: .resize() returns another instance
  // with the same shape (tray.ts resizes an already-resized icon again
  // inside createTrayIconVariant).
  function makeFakeImage(): unknown {
    const img = {
      resize: vi.fn(() => makeFakeImage()),
      setTemplateImage: vi.fn(),
      toBitmap: vi.fn(() => Buffer.from([])),
      getSize: vi.fn(() => ({ width: 18, height: 18 })),
    };
    return img;
  }
  return {
    Menu: { buildFromTemplate: mockBuildFromTemplate },
    Tray: function MockTray() { return mockTrayInstance; },
    nativeImage: {
      createFromPath: vi.fn(() => makeFakeImage()),
      createFromBitmap: vi.fn(() => makeFakeImage()),
    },
  };
});

vi.mock('../src/assets.js', () => ({
  resolveAssetPath: vi.fn(() => '/mock/assets/tray-icon.png'),
}));

import { TrayController, type TrayCallbacks } from '../src/tray.js';

function makeCallbacks(overrides: Partial<TrayCallbacks> = {}): TrayCallbacks {
  return {
    onOpen: vi.fn(),
    onOpenChatInBrowser: vi.fn(),
    onOpenAdmin: vi.fn(),
    onShowLogs: vi.fn(),
    getLaunchOnLoginStatus: vi.fn(() => ({ enabled: false, supported: true })),
    onSetLaunchOnLogin: vi.fn(),
    isPrereleaseEnabled: vi.fn(() => false),
    onTogglePrerelease: vi.fn(),
    onQuit: vi.fn(),
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: menu template items are Electron's own loose shape
function findItem(template: any[], label: string) {
  return template.find((item) => item?.label === label);
}

describe('TrayController menu template', () => {
  it('contains an "Open Admin Dashboard" item that invokes onOpenAdmin', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks();
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Open Admin Dashboard');
    expect(item).toBeTruthy();
    item.click();
    expect(callbacks.onOpenAdmin).toHaveBeenCalledTimes(1);
  });

  it('contains an always-available browser chat item that invokes onOpenChatInBrowser', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks();
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Open Chat in Browser');
    expect(item).toBeTruthy();
    expect(item.enabled).not.toBe(false);
    item.click();
    expect(callbacks.onOpenChatInBrowser).toHaveBeenCalledTimes(1);
  });

  it('does not offer the removed experimental chat toggle', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks();
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    expect(findItem(template, 'Use the new app chat (experimental)')).toBeUndefined();
  });
});
