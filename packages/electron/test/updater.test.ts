// Run via vitest (Node). Covers the full-app desktop updater (#572): channel
// mapping, platform support, state transitions, consent-before-download,
// single-flight, silent offline checks, focus throttling and quitAndInstall.
//
// DesktopUpdater takes its electron-updater instance as a dependency, so every
// case below runs in plain Node against the fake — no Electron, no network.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DesktopUpdater,
  FOCUS_CHECK_THROTTLE_MS,
  isAutoUpdateSupported,
  isTrustedUpdaterSender,
  isVersionNewer,
  updaterChannel,
  updaterFeedChannel,
  type AppUpdaterLike,
  type CancellationTokenLike,
} from '../src/updater.js';

class FakeUpdater implements AppUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  allowPrerelease = false;
  checkCalls = 0;
  downloadCalls = 0;
  quitCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  installCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  installResult = true;
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

  async downloadUpdate(cancellationToken?: CancellationTokenLike) {
    this.downloadCalls += 1;
    this.downloadTokens.push(cancellationToken);
    if (this.downloadError) throw this.downloadError;
    return [];
  }

  /** Tokens passed to downloadUpdate, so tests can pin cancellation (E3). */
  downloadTokens: Array<CancellationTokenLike | undefined> = [];

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitCalls.push([isSilent, isForceRunAfter]);
  }

  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean {
    this.installCalls.push([isSilent, isForceRunAfter]);
    return this.installResult;
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
    return this;
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function makeUpdater(
  overrides: Partial<{
    currentVersion: string;
    platform: NodeJS.Platform;
    isPackaged: boolean;
    portableExecutableFile: string;
    windowsInstallerPresent: boolean;
    prerelease: boolean;
    now: () => number;
    createCancellationToken: () => CancellationTokenLike;
  }> = {},
): { updater: DesktopUpdater; fake: FakeUpdater } {
  const fake = new FakeUpdater();
  const updater = new DesktopUpdater({
    updater: fake,
    currentVersion: overrides.currentVersion ?? '1.0.0',
    platform: overrides.platform ?? 'linux',
    isPackaged: overrides.isPackaged ?? true,
    portableExecutableFile: overrides.portableExecutableFile,
    windowsInstallerPresent: overrides.windowsInstallerPresent ?? true,
    prerelease: overrides.prerelease ?? false,
    now: overrides.now,
    createCancellationToken: overrides.createCancellationToken,
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

// check()'s "available" gate: strictly newer by semver precedence, not merely
// different. Local implementation because electron-updater's own `semver`
// dependency is not resolvable from this package (isolated installs).
describe('isVersionNewer', () => {
  it('orders plain releases', () => {
    expect(isVersionNewer('2.0.0', '1.0.0')).toBe(true);
    expect(isVersionNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isVersionNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isVersionNewer('0.9.9', '1.0.0')).toBe(false);
  });

  it('sorts a prerelease BEFORE its release (1.2.3-beta.4 < 1.2.3)', () => {
    expect(isVersionNewer('1.2.3', '1.2.3-beta.4')).toBe(true);
    expect(isVersionNewer('1.2.3-beta.4', '1.2.3')).toBe(false);
  });

  it('compares numeric prerelease identifiers numerically (beta.4 < beta.10)', () => {
    expect(isVersionNewer('1.2.3-beta.10', '1.2.3-beta.4')).toBe(true);
    expect(isVersionNewer('1.2.3-beta.4', '1.2.3-beta.10')).toBe(false);
  });

  it('compares alphanumeric prerelease identifiers lexically (alpha < beta)', () => {
    expect(isVersionNewer('1.2.3-beta.1', '1.2.3-alpha.9')).toBe(true);
    expect(isVersionNewer('1.2.3-alpha.9', '1.2.3-beta.1')).toBe(false);
  });

  it('ranks numeric identifiers below alphanumeric ones (semver §11)', () => {
    expect(isVersionNewer('1.2.3-beta', '1.2.3-4')).toBe(true);
    expect(isVersionNewer('1.2.3-4', '1.2.3-beta')).toBe(false);
  });

  it('lets a longer identifier set win over its own prefix', () => {
    expect(isVersionNewer('1.2.3-beta.4.1', '1.2.3-beta.4')).toBe(true);
    expect(isVersionNewer('1.2.3-beta.4', '1.2.3-beta.4.1')).toBe(false);
  });

  it('a release with a prerelease is still newer than an older release', () => {
    expect(isVersionNewer('1.1.0-beta.1', '1.0.0')).toBe(true);
    expect(isVersionNewer('1.0.0', '1.1.0-beta.1')).toBe(false);
  });

  it('falls back to plain inequality for non-semver strings', () => {
    expect(isVersionNewer('nightly-2', 'nightly-1')).toBe(true);
    expect(isVersionNewer('nightly-1', 'nightly-1')).toBe(false);
  });
});

describe('platform support', () => {
  it('supports packaged Windows and Linux', () => {
    expect(isAutoUpdateSupported('win32', true, true)).toBe(true);
    expect(isAutoUpdateSupported('linux', true, false)).toBe(true);
  });

  it('does not support macOS (unsigned/un-notarized) or unpackaged runs', () => {
    expect(isAutoUpdateSupported('darwin', true, false)).toBe(false);
    expect(isAutoUpdateSupported('linux', false, false)).toBe(false);
    expect(isAutoUpdateSupported('win32', false, true)).toBe(false);
  });

  it('does not support electron-builder Windows portable runtimes', () => {
    expect(isAutoUpdateSupported('win32', true, true, 'C:\\Downloads\\OpenPalm.exe')).toBe(false);
    expect(isAutoUpdateSupported('linux', true, false, '/tmp/irrelevant-portable-signal')).toBe(true);
  });

  it('does not support an extracted Windows archive with no NSIS uninstaller', () => {
    expect(isAutoUpdateSupported('win32', true, false)).toBe(false);
  });

  it('keeps an extracted Windows archive inert instead of installing NSIS elsewhere', async () => {
    const { updater, fake } = makeUpdater({
      platform: 'win32',
      windowsInstallerPresent: false,
    });

    expect(updater.getState()).toMatchObject({ status: 'unsupported', supported: false });
    await updater.check();
    await updater.download();
    expect(updater.quitAndInstall()).toBe(false);
    expect(updater.installOnQuit()).toBe(false);
    expect(fake.checkCalls).toBe(0);
    expect(fake.downloadCalls).toBe(0);
    expect(fake.quitCalls).toEqual([]);
    expect(fake.installCalls).toEqual([]);
  });

  it('keeps a portable runtime inert so it cannot download or install NSIS', async () => {
    const { updater, fake } = makeUpdater({
      platform: 'win32',
      portableExecutableFile: 'C:\\Downloads\\OpenPalm.exe',
    });

    expect(updater.getState()).toMatchObject({ status: 'unsupported', supported: false });
    await updater.check();
    await updater.download();
    expect(updater.quitAndInstall()).toBe(false);
    expect(updater.installOnQuit()).toBe(false);
    expect(fake.checkCalls).toBe(0);
    expect(fake.downloadCalls).toBe(0);
    expect(fake.quitCalls).toEqual([]);
    expect(fake.installCalls).toEqual([]);
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
  // autoInstallOnAppQuit stays OFF: electron-updater's own install-on-quit
  // hook is wired to Electron's 'quit' event, which main.ts's before-quit
  // handler never reaches (it always finishes with app.exit(0) — see the
  // class docblock). Ordinary-quit install is handled explicitly by
  // installOnQuit() below instead, called directly from main.ts.
  it('disables autoDownload and does not rely on electron-updater\'s own install-on-quit hook', () => {
    const { fake } = makeUpdater();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
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

  // A different feed version is NOT automatically an update: `!==` used to
  // report an OLDER feed release as 'available', a phantom whose download can
  // never succeed (electron-updater never stages a not-newer update).
  it('reports not-available when the feed is OLDER than the running version', async () => {
    const { updater, fake } = makeUpdater();
    fake.feedVersion = '0.9.0';
    const state = await updater.check();
    expect(state.status).toBe('not-available');
    expect(state.availableVersion).toBeNull();
  });

  // The concrete phantom: a beta install on the default stable channel, whose
  // stable feed carries the older release the beta was cut ahead of.
  it('does not offer a beta install its own older stable release as an update', async () => {
    const { updater, fake } = makeUpdater({ currentVersion: '1.1.0-beta.4' });
    fake.feedVersion = '1.0.0';
    const state = await updater.check();
    expect(state.status).toBe('not-available');
    expect(state.availableVersion).toBeNull();
  });

  it('still offers the stable release a prerelease of it predates', async () => {
    const { updater, fake } = makeUpdater({ currentVersion: '1.0.0-beta.4' });
    fake.feedVersion = '1.0.0';
    const state = await updater.check();
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('1.0.0');
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

  // E3 review: the singleton autoUpdater outlives a wrapper across
  // prerelease-channel toggles, so a download begun by the PREVIOUS instance
  // can complete after the rebuild and fire the NEW instance's listener with
  // the OLD channel's artifact — which quit would then install.
  it('ignores update-downloaded for a version this instance never reported', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check(); // reports 2.0.0 as available
    fake.emit('update-downloaded', { version: '9.9.9-beta.1' });
    expect(updater.getState().status).toBe('available');
  });

  it('accepts update-downloaded carrying the version it reported', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.emit('update-downloaded', { version: '2.0.0' });
    expect(updater.getState().status).toBe('downloaded');
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

  // E1 review: a failed SILENT check used to patch {status:'idle'}, clobbering
  // a previously discovered 'available' while leaving availableVersion set —
  // an offline focus check silently hid a known update.
  it('a failed silent check does not clobber an already-discovered update', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    expect(updater.getState().status).toBe('available');

    fake.checkError = new Error('getaddrinfo ENOTFOUND github.com');
    const state = await updater.check({ silent: true });
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('2.0.0');
    expect(state.error).toBeNull();
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

// installOnQuit() is what actually makes a staged update install on an
// ordinary quit (main.ts's before-quit calls this, not quitAndInstall — see
// the class docblock for why the two must not be conflated).
describe('installOnQuit', () => {
  it('does nothing until a download has completed', async () => {
    const { updater, fake } = makeUpdater();
    expect(updater.installOnQuit()).toBe(false);
    await updater.check();
    expect(updater.installOnQuit()).toBe(false);
    expect(fake.installCalls).toEqual([]);
    expect(fake.quitCalls).toEqual([]);
  });

  it('silently launches the installer with no relaunch, once a download has completed', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.emit('update-downloaded');
    await updater.download();
    expect(updater.installOnQuit()).toBe(true);
    // isSilent=true, isForceRunAfter=false: an ordinary quit is not "restart
    // now" — that stays quitAndInstall()'s job.
    expect(fake.installCalls).toEqual([[true, false]]);
    // Crucially, this must NOT go through quitAndInstall — that schedules
    // electron-updater's own app.quit() internally, which would race
    // main.ts's own exit sequence (see the class docblock).
    expect(fake.quitCalls).toEqual([]);
  });

  it('propagates a failed install (e.g. no installer file) as false', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    fake.emit('update-downloaded');
    await updater.download();
    fake.installResult = false;
    expect(updater.installOnQuit()).toBe(false);
  });

  it('does nothing on an unsupported (e.g. macOS) instance', async () => {
    const { updater, fake } = makeUpdater({ platform: 'darwin' });
    expect(updater.installOnQuit()).toBe(false);
    expect(fake.installCalls).toEqual([]);
  });
});

// #635: "install call ignored: quitAndInstallCalled is set to true" jams the
// updater — the operator's log shows exactly one v0.13.0 start against 24
// reverts to v0.12.42, with that warning recurring for weeks.
//
// FakeRealUpdater below is NOT the loose FakeUpdater above: it mirrors
// electron-updater 6.8.9's ACTUAL BaseUpdater#install/#quitAndInstall
// (node_modules/electron-updater/out/BaseUpdater.js) line for line, including
// the part that matters here — `install()` sets `quitAndInstallCalled = true`
// BEFORE it attempts anything, and on failure only `quitAndInstall()`'s own
// wrapper resets that flag back to false; a direct `install()` call (which is
// exactly what `installOnQuit()` makes) never resets it. `onAppQuit` stands
// in for the real Electron `app.quit()` that `quitAndInstall()` schedules —
// wiring it straight to `installOnQuit()` reproduces the exact cascade
// main.ts's before-quit handler creates: it calls `installOnQuit()`
// unconditionally on every quit, including the one electron-updater's own
// `quitAndInstall()` triggers internally.
describe('quitAndInstall single-attempt guard (#635)', () => {
  class FakeRealUpdater implements AppUpdaterLike {
    autoDownload = true;
    autoInstallOnAppQuit = false;
    channel: string | null = null;
    allowPrerelease = false;
    /** Mirrors BaseUpdater#quitAndInstallCalled exactly. */
    quitAndInstallCalled = false;
    /** Raw calls that reached electron-updater's real install() — not refused by its guard. */
    rawInstallCalls: Array<[boolean, boolean]> = [];
    /** Mirrors electron-updater's own `_logger` output (console by default). */
    logs: Array<string> = [];
    doInstallOutcome: 'succeed' | 'throw' | 'return-false' = 'succeed';
    /** Stands in for the real Electron app.quit() that quitAndInstall() schedules. */
    onAppQuit: (() => void) | null = null;
    private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

    async checkForUpdates() {
      return { updateInfo: { version: '2.0.0' } };
    }
    async downloadUpdate() {
      return [];
    }

    // Mirrors BaseUpdater.js's install() (lines 42-68) exactly.
    install(isSilent = false, isForceRunAfter = false): boolean {
      if (this.quitAndInstallCalled) {
        this.logs.push('install call ignored: quitAndInstallCalled is set to true');
        return false;
      }
      this.quitAndInstallCalled = true;
      try {
        this.rawInstallCalls.push([isSilent, isForceRunAfter]);
        if (this.doInstallOutcome === 'throw') throw new Error('mv failed: EACCES');
        return this.doInstallOutcome === 'succeed';
      } catch (e) {
        this.logs.push(`error: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }

    // Mirrors BaseUpdater.js's quitAndInstall() (lines 13-27) exactly,
    // `autoRunAppAfterInstall` defaulting true as it does in real
    // electron-updater.
    quitAndInstall(isSilent = false, isForceRunAfter = false): void {
      const isInstalled = this.install(isSilent, isSilent ? isForceRunAfter : true);
      if (isInstalled) {
        this.onAppQuit?.();
      } else {
        this.quitAndInstallCalled = false;
      }
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const l of this.listeners.get(event) ?? []) l(...args);
    }
  }

  async function makeRealisticUpdater() {
    const fake = new FakeRealUpdater();
    const updater = new DesktopUpdater({
      updater: fake,
      currentVersion: '0.12.42',
      platform: 'linux',
      isPackaged: true,
      windowsInstallerPresent: false,
      prerelease: false,
    });
    await updater.check();
    fake.emit('update-downloaded');
    await updater.download();
    expect(updater.getState().status).toBe('downloaded');
    return { updater, fake };
  }

  // The exact operator sequence: click "Restart and update" -> electron-updater's
  // quitAndInstall() installs and schedules its own app.quit() -> that fires
  // Electron's real 'before-quit' -> main.ts's handler calls installOnQuit()
  // unconditionally, REGARDLESS of how the quit started.
  it('makes at most one raw install() call across quitAndInstall -> cascading installOnQuit', async () => {
    const { updater, fake } = await makeRealisticUpdater();
    fake.onAppQuit = () => updater.installOnQuit();

    expect(updater.quitAndInstall()).toBe(true);

    expect(fake.rawInstallCalls).toEqual([[false, true]]);
    expect(fake.logs).not.toContain('install call ignored: quitAndInstallCalled is set to true');
  });

  // Ordinary quit, no button click: installOnQuit() is the ONLY and FIRST
  // attempt. When electron-updater's doInstall step itself fails (a real
  // AppImage/NSIS failure — disk full, EACCES, whatever), the failure must be
  // loud, and this process must never retry into electron-updater's now
  // permanently-stuck quitAndInstallCalled guard.
  it('logs a failed quit-time install loudly and never retries the doomed call', async () => {
    const { updater, fake } = await makeRealisticUpdater();
    fake.doInstallOutcome = 'throw';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(updater.installOnQuit()).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockClear();

      // A later quit attempt in the SAME process must be refused WITHOUT a
      // second raw call — electron-updater's guard makes it unrecoverable, so
      // retrying would only ever reproduce the silent "install call ignored"
      // no-op this fix exists to avoid.
      expect(updater.installOnQuit()).toBe(false);
      expect(fake.rawInstallCalls).toHaveLength(1);
      expect(fake.logs).not.toContain('install call ignored: quitAndInstallCalled is set to true');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// E6: createDesktopUpdater rebuilds a DesktopUpdater over the SAME singleton
// autoUpdater on every prerelease-channel toggle. Without dispose(), each
// rebuild leaves the PRIOR instance's listeners registered on the shared
// updater, so N toggles == N sets of listeners all still firing.
describe('dispose (listener teardown)', () => {
  it('removes this instance\'s listeners from the shared updater', () => {
    const { updater, fake } = makeUpdater();
    expect(fake.listenerCount('download-progress')).toBe(1);
    expect(fake.listenerCount('update-downloaded')).toBe(1);

    updater.dispose();

    expect(fake.listenerCount('download-progress')).toBe(0);
    expect(fake.listenerCount('update-downloaded')).toBe(0);
  });

  it('a disposed instance no longer reacts to events from the shared updater', async () => {
    const { updater, fake } = makeUpdater();
    await updater.check();
    updater.dispose();

    fake.emit('download-progress', { percent: 77 });
    // percent stays whatever it was before dispose (null — no download started).
    expect(updater.getState().percent).toBeNull();
  });

  it('rebuilding over the same singleton after dispose leaves exactly one listener set', () => {
    const fake = new FakeUpdater();
    const first = new DesktopUpdater({ updater: fake, currentVersion: '1.0.0', platform: 'linux', isPackaged: true, windowsInstallerPresent: false, prerelease: false });
    first.dispose();
    const second = new DesktopUpdater({ updater: fake, currentVersion: '1.0.0', platform: 'linux', isPackaged: true, windowsInstallerPresent: false, prerelease: true });

    expect(fake.listenerCount('download-progress')).toBe(1);
    expect(fake.listenerCount('update-downloaded')).toBe(1);

    fake.emit('download-progress', { percent: 55 });
    expect(second.getState().percent).toBe(55);
  });

  // E3 review: a channel toggle discards the instance mid-download — the
  // download must not keep running (and staging the old channel's artifact)
  // on the shared singleton afterwards.
  it('cancels an in-flight download, using the token it passed to downloadUpdate', async () => {
    const token: CancellationTokenLike & { cancel: ReturnType<typeof vi.fn> } = { cancel: vi.fn() };
    const { updater, fake } = makeUpdater({ createCancellationToken: () => token });
    await updater.check();

    const pending = updater.download();
    updater.dispose();

    expect(token.cancel).toHaveBeenCalledOnce();
    expect(fake.downloadTokens).toEqual([token]);
    await pending;
  });

  it('is a no-op on an unsupported (e.g. macOS) instance', () => {
    const { updater, fake } = makeUpdater({ platform: 'darwin' });
    expect(() => updater.dispose()).not.toThrow();
    expect(fake.listenerCount('download-progress')).toBe(0);
  });

  it('is safe to call twice', () => {
    const { updater, fake } = makeUpdater();
    updater.dispose();
    expect(() => updater.dispose()).not.toThrow();
    expect(fake.listenerCount('download-progress')).toBe(0);
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
