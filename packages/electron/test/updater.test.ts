// Run via vitest (Node). Covers the full-app desktop updater (#572): channel
// mapping, platform support, state transitions, consent-before-download,
// single-flight, silent offline checks, focus throttling and quitAndInstall.
//
// DesktopUpdater takes its electron-updater instance as a dependency, so every
// case below runs in plain Node against the fake — no Electron, no network.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DesktopUpdater,
  FOCUS_CHECK_THROTTLE_MS,
  isAutoUpdateSupported,
  isTrustedUpdaterSender,
  updaterChannel,
  updaterFeedChannel,
  type AppUpdaterLike,
} from '../src/updater.js';

class FakeUpdater implements AppUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  allowPrerelease = false;
  checkCalls = 0;
  downloadCalls = 0;
  quitCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  feedVersion: string | null = '2.0.0';
  checkError: Error | null = null;
  downloadError: Error | null = null;
  /** Resolvers for pending calls, so tests can control overlap. */
  private pendingCheck: (() => void) | null = null;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  async checkForUpdates() {
    this.checkCalls += 1;
    if (this.pendingCheck) throw new Error('unexpected concurrent check');
    await new Promise<void>((resolve) => {
      this.pendingCheck = resolve;
      if (!this.holdChecks) resolve();
    });
    this.pendingCheck = null;
    if (this.checkError) throw this.checkError;
    return this.feedVersion ? { updateInfo: { version: this.feedVersion } } : null;
  }

  holdChecks = false;
  releaseCheck(): void {
    this.pendingCheck?.();
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    return [];
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitCalls.push([isSilent, isForceRunAfter]);
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function makeUpdater(
  overrides: Partial<{
    platform: NodeJS.Platform;
    isPackaged: boolean;
    prerelease: boolean;
    now: () => number;
  }> = {},
): { updater: DesktopUpdater; fake: FakeUpdater } {
  const fake = new FakeUpdater();
  const updater = new DesktopUpdater({
    updater: fake,
    currentVersion: '1.0.0',
    platform: overrides.platform ?? 'linux',
    isPackaged: overrides.isPackaged ?? true,
    prerelease: overrides.prerelease ?? false,
    now: overrides.now,
  });
  return { updater, fake };
}

describe('channel mapping', () => {
  it('maps the desktop prerelease opt-in onto beta and nothing else', () => {
    expect(updaterChannel(false)).toBe('stable');
    expect(updaterChannel(true)).toBe('beta');
  });

  it('configures the injected updater with the resolved channel', () => {
    const { fake } = makeUpdater({ prerelease: true });
    expect(fake.channel).toBe('beta');
    expect(fake.allowPrerelease).toBe(true);
  });

  // electron-updater turns `channel` straight into the feed FILENAME, and the
  // stable feed electron-builder publishes is latest.yml — there is no
  // stable.yml. Assigning the UI label directly would 404 every stable check,
  // which the user would read as "no updates" forever.
  it('asks for the latest feed on the stable channel, not a stable.yml', () => {
    expect(updaterFeedChannel('stable')).toBe('latest');
    const { fake } = makeUpdater({ prerelease: false });
    expect(fake.channel).toBe('latest');
    expect(fake.allowPrerelease).toBe(false);
  });

  it('keeps stable as the user-facing label even though the feed is latest', () => {
    const { updater } = makeUpdater({ prerelease: false });
    expect(updater.getState().channel).toBe('stable');
  });

  it('leaves the beta channel name alone — beta.yml is what is published', () => {
    expect(updaterFeedChannel('beta')).toBe('beta');
  });
});

describe('platform support', () => {
  it('supports packaged Windows and Linux', () => {
    expect(isAutoUpdateSupported('win32', true)).toBe(true);
    expect(isAutoUpdateSupported('linux', true)).toBe(true);
  });

  it('does not support macOS (unsigned/un-notarized) or unpackaged runs', () => {
    expect(isAutoUpdateSupported('darwin', true)).toBe(false);
    expect(isAutoUpdateSupported('linux', false)).toBe(false);
    expect(isAutoUpdateSupported('win32', false)).toBe(false);
  });

  it('reports unsupported with a manual releases URL, and never calls the updater', async () => {
    const { updater, fake } = makeUpdater({ platform: 'darwin' });
    const state = updater.getState();
    expect(state.status).toBe('unsupported');
    expect(state.supported).toBe(false);
    expect(state.releasesUrl).toContain('github.com/itlackey/openpalm/releases');

    await updater.check();
    await updater.download();
    expect(updater.quitAndInstall()).toBe(false);
    expect(fake.checkCalls).toBe(0);
    expect(fake.downloadCalls).toBe(0);
    expect(fake.quitCalls).toEqual([]);
  });
});

describe('consent before download', () => {
  it('disables autoDownload and enables install-on-quit', () => {
    const { fake } = makeUpdater();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(true);
  });

  it('discovering an update does not download it', async () => {
    const { updater, fake } = makeUpdater();
    const state = await updater.check();
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('2.0.0');
    expect(fake.downloadCalls).toBe(0);
  });

  it('refuses to download when no update was discovered', async () => {
    const { updater, fake } = makeUpdater();
    const state = await updater.download();
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/no update/i);
    expect(fake.downloadCalls).toBe(0);
  });
});

describe('state transitions', () => {
  it('reports not-available when the feed matches the running version', async () => {
    const { updater, fake } = makeUpdater();
    fake.feedVersion = '1.0.0';
    const state = await updater.check();
    expect(state.status).toBe('not-available');
    expect(state.availableVersion).toBeNull();
  });

  it('walks available → downloading → downloaded, tracking percent', async () => {
    const { updater, fake } = makeUpdater();
    const seen: string[] = [];
    await updater.check();

    fake.downloadError = null;
    const pending = updater.download();
    seen.push(updater.getState().status);
    fake.emit('download-progress', { percent: 42 });
    expect(updater.getState().percent).toBe(42);
    fake.emit('update-downloaded');
    const final = await pending;

    expect(seen[0]).toBe('downloading');
    expect(final.status).toBe('downloaded');
    expect(final.percent).toBe(100);
  });

  it('surfaces a download failure as an actionable error', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.downloadError = new Error('disk full');
    const state = await updater.download();
    expect(state.status).toBe('error');
    expect(state.error).toBe('disk full');
  });

  it('does not let a later check reset a completed download', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.emit('update-downloaded');
    await updater.download();
    expect(updater.getState().status).toBe('downloaded');

    const after = await updater.check();
    expect(after.status).toBe('downloaded');
    expect(fake.checkCalls).toBe(1);
  });
});

describe('silent offline checks', () => {
  it('a silent check that fails reports no error', async () => {
    const { updater, fake } = makeUpdater();
    fake.checkError = new Error('getaddrinfo ENOTFOUND github.com');
    const state = await updater.check({ silent: true });
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
  });

  it('a manual check that fails reports the reason', async () => {
    const { updater, fake } = makeUpdater();
    fake.checkError = new Error('getaddrinfo ENOTFOUND github.com');
    const state = await updater.check();
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/ENOTFOUND/);
  });
});

describe('single flight', () => {
  it('collapses concurrent checks onto one request', async () => {
    const { updater, fake } = makeUpdater();
    fake.holdChecks = true;
    const a = updater.check();
    const b = updater.check();
    fake.releaseCheck();
    await Promise.all([a, b]);
    expect(fake.checkCalls).toBe(1);
  });

  it('collapses concurrent downloads onto one request', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    const a = updater.download();
    const b = updater.download();
    await Promise.all([a, b]);
    expect(fake.downloadCalls).toBe(1);
  });
});

describe('focus throttling', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it('checks on first focus, then not again until the throttle elapses', async () => {
    const { updater, fake } = makeUpdater({ now: () => clock });
    await updater.checkOnFocus();
    expect(fake.checkCalls).toBe(1);

    clock += FOCUS_CHECK_THROTTLE_MS - 1;
    await updater.checkOnFocus();
    expect(fake.checkCalls).toBe(1);

    clock += 2;
    await updater.checkOnFocus();
    expect(fake.checkCalls).toBe(2);
  });

  it('focus checks are silent — an offline focus check shows no error', async () => {
    const { updater, fake } = makeUpdater({ now: () => clock });
    fake.checkError = new Error('offline');
    const state = await updater.checkOnFocus();
    expect(state.error).toBeNull();
  });
});

describe('quitAndInstall', () => {
  it('does nothing until a download has completed', async () => {
    const { updater, fake } = makeUpdater();
    expect(updater.quitAndInstall()).toBe(false);
    await updater.check();
    expect(updater.quitAndInstall()).toBe(false);
    expect(fake.quitCalls).toEqual([]);
  });

  it('installs and relaunches once a download has completed', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.emit('update-downloaded');
    await updater.download();
    expect(updater.quitAndInstall()).toBe(true);
    // isSilent=false keeps the installer UI; isForceRunAfter=true relaunches.
    expect(fake.quitCalls).toEqual([[false, true]]);
  });
});

describe('updater IPC sender validation', () => {
  const PORT = 41234;

  it('accepts exactly the origin the trusted UI is served from', () => {
    expect(isTrustedUpdaterSender(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isTrustedUpdaterSender(`http://127.0.0.1:${PORT}/host/settings`, PORT)).toBe(true);
  });

  it('rejects a different port, so another local server cannot drive updates', () => {
    expect(isTrustedUpdaterSender(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isTrustedUpdaterSender('http://127.0.0.1', PORT)).toBe(false);
  });

  it('rejects localhost — a different origin than the one the app serves', () => {
    expect(isTrustedUpdaterSender(`http://localhost:${PORT}`, PORT)).toBe(false);
  });

  it('rejects hosts that merely start with the trusted origin', () => {
    expect(isTrustedUpdaterSender(`http://127.0.0.1:${PORT}@evil.com`, PORT)).toBe(false);
    expect(isTrustedUpdaterSender(`http://127.0.0.1.evil.com:${PORT}`, PORT)).toBe(false);
    expect(isTrustedUpdaterSender(`http://evil.com/http://127.0.0.1:${PORT}`, PORT)).toBe(false);
  });

  it('rejects non-http schemes and unparseable senders', () => {
    expect(isTrustedUpdaterSender(`https://127.0.0.1:${PORT}`, PORT)).toBe(false);
    expect(isTrustedUpdaterSender(`file:///tmp/x.html`, PORT)).toBe(false);
    expect(isTrustedUpdaterSender('', PORT)).toBe(false);
    expect(isTrustedUpdaterSender('not a url', PORT)).toBe(false);
  });
});
