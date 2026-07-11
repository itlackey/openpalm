// Run via vitest (Node), NOT bun test — same reason as main.test.ts (bun
// executes the real 'electron' module and can't honor vi.mock() hoisting).
//
// A2: the tray menu had NO admin entry at all — the only way back to the
// host admin dashboard from Electron was a fallback failure mode. Pins that
// the tray template contains an "Open Admin Dashboard" item wired to the
// supplied callback.
//
// E4: "Open Local App" opened a hardcoded client URL with no health check,
// producing an ERR_CONNECTION_REFUSED page whenever the client server wasn't
// running. Pins that the item is disabled while the caller reports the
// client app unavailable (main.ts wires this to `clientProcess === null` and
// rebuilds the menu on client-process start/exit).
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
    onOpenLocalApp: vi.fn(),
    onOpenAdmin: vi.fn(),
    onShowLogs: vi.fn(),
    getLaunchOnLoginStatus: vi.fn(() => ({ enabled: false, supported: true })),
    onSetLaunchOnLogin: vi.fn(),
    isPrereleaseEnabled: vi.fn(() => false),
    onTogglePrerelease: vi.fn(),
    isClientAppAvailable: vi.fn(() => true),
    isClientChatOptedIn: vi.fn(() => false),
    onToggleClientChatOptIn: vi.fn(),
    onQuit: vi.fn(),
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: menu template items are Electron's own loose shape
function findItem(template: any[], label: string) {
  return template.find((item) => item?.label === label);
}

describe('TrayController — menu template (A2 admin entry, E4 local-app health guard)', () => {
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

  it('enables "Open Local App" when the caller reports the client app available', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks({ isClientAppAvailable: vi.fn(() => true) });
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Open Local App');
    expect(item.enabled).toBe(true);
  });

  it('disables "Open Local App" when the caller reports the client app unavailable (E4)', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks({ isClientAppAvailable: vi.fn(() => false) });
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Open Local App');
    expect(item.enabled).toBe(false);
  });

  it('re-evaluates client-app availability on rebuildMenu (so main.ts can disable it after the child exits)', () => {
    const controller = new TrayController();
    let available = true;
    const callbacks = makeCallbacks({ isClientAppAvailable: () => available });
    controller.create(callbacks);
    available = false;
    controller.rebuildMenu();

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Open Local App');
    expect(item.enabled).toBe(false);
  });
});

// ── A1: "Use the new app chat (experimental)" opt-in checkbox ───────────────
// A1: the client SPA chat is now opt-in (see resolveInitialUrl/
// isClientChatOptedIn in main.ts) — mirrors the existing "Check for
// prerelease versions" checkbox pattern exactly.
describe('TrayController — client-chat opt-in checkbox (A1)', () => {
  it('contains a checkbox item reflecting the current opt-in state', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks({ isClientChatOptedIn: vi.fn(() => true) });
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Use the new app chat (experimental)');
    expect(item).toBeTruthy();
    expect(item.type).toBe('checkbox');
    expect(item.checked).toBe(true);
  });

  it('invokes onToggleClientChatOptIn with the new checked state on click', () => {
    const controller = new TrayController();
    const callbacks = makeCallbacks({ isClientChatOptedIn: vi.fn(() => false) });
    controller.create(callbacks);

    const template = mockBuildFromTemplate.mock.calls.at(-1)?.[0];
    const item = findItem(template, 'Use the new app chat (experimental)');
    item.click({ checked: true });
    expect(callbacks.onToggleClientChatOptIn).toHaveBeenCalledWith(true);
  });
});
