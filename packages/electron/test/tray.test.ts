// Run via vitest (Node), NOT bun test — same reason as main.test.ts (bun
// executes the real 'electron' module and can't honor vi.mock() hoisting).
//
// Pins the browser-chat and admin entries to their supplied callbacks.
import { describe, it, expect, vi } from 'vitest';

const { mockBuildFromTemplate, mockTrayInstance, mockTrayConstructor } = vi.hoisted(() => ({
  mockBuildFromTemplate: vi.fn((template: unknown) => template),
  mockTrayInstance: { setToolTip: vi.fn(), setContextMenu: vi.fn(), setImage: vi.fn(), on: vi.fn() },
  mockTrayConstructor: vi.fn(function MockTray() {
    return mockTrayInstance;
  }),
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
    Tray: mockTrayConstructor,
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
    isMicShortcutEnabled: vi.fn(() => false),
    onToggleMicShortcut: vi.fn(),
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

  // E3: the global mic shortcut is opt-in — the tray must expose a way to
  // turn it on, and its checked state must reflect the persisted setting.
  it('contains a "Global Mic Shortcut" checkbox reflecting isMicShortcutEnabled and invoking onToggleMicShortcut', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks({ isMicShortcutEnabled: vi.fn(() => true) });
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Global Mic Shortcut (Ctrl/Cmd+Shift+M)');
    expect(item).toBeTruthy();
    expect(item.type).toBe('checkbox');
    expect(item.checked).toBe(true);
    item.click({ checked: false });
    expect(callbacks.onToggleMicShortcut).toHaveBeenCalledWith(false);
  });
});

describe('TrayController click-to-open (#427)', () => {
  it('registers a click handler that calls onOpen on win32', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks();
    controller.create(callbacks, 'win32');

    expect(mockTrayInstance.on).toHaveBeenCalledWith('click', expect.any(Function));
    const clickHandler = mockTrayInstance.on.mock.calls.find(([event]) => event === 'click')?.[1];
    expect(clickHandler).toBeTruthy();
    clickHandler();
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not register a click handler on darwin or linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      mockTrayInstance.on.mockClear();
      const controller = new TrayController();
      controller.create(makeCallbacks(), platform);
      expect(mockTrayInstance.on).not.toHaveBeenCalledWith('click', expect.any(Function));
    }
  });
});

describe('TrayController.isActive', () => {
  it('is false before create() is called', () => {
    const controller = new TrayController();
    expect(controller.isActive()).toBe(false);
  });

  it('is true after a successful create()', () => {
    const controller = new TrayController();
    controller.create(makeCallbacks());
    expect(controller.isActive()).toBe(true);
  });

  it('stays false when the tray-icon asset is missing (no-op create)', async () => {
    const assets = await import('../src/assets.js');
    vi.mocked(assets.resolveAssetPath).mockReturnValueOnce(null);
    const controller = new TrayController();
    controller.create(makeCallbacks());
    expect(controller.isActive()).toBe(false);
  });

  it('stays false (and does not throw) when the native Tray constructor fails — e.g. a Linux desktop with no StatusNotifier host', () => {
    mockTrayConstructor.mockImplementationOnce(() => {
      throw new Error('no StatusNotifier host');
    });
    const controller = new TrayController();
    expect(() => controller.create(makeCallbacks())).not.toThrow();
    expect(controller.isActive()).toBe(false);
  });
});
