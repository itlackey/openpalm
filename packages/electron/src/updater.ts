/**
 * Full-application desktop updates (#572).
 *
 * Replaces the notify-only update-check with electron-updater: the app finds,
 * downloads, stages and installs a COMPLETE tested release — shell, bundled UI
 * and all — instead of announcing a version and asking the user to reinstall by
 * hand. There is exactly one update operation on the desktop, and the artifact
 * it installs is the one that was tested together.
 *
 * Policy, all enforced here rather than by electron-updater's defaults:
 *
 * - `autoDownload = false`. Discovery must never spend a user's bandwidth;
 *   downloading is a separate, explicit act of consent (`download()`).
 * - `autoInstallOnAppQuit = true`. A staged update installs on normal quit, so
 *   "Restart and update" is a convenience rather than the only route.
 * - Silent checks (startup, window focus) never surface an error: a laptop that
 *   is offline is the normal case, not a fault worth a persistent banner. Only
 *   a user-initiated check reports why it failed.
 * - Single-flight. Concurrent checks, or concurrent downloads, collapse onto
 *   the one in flight; a download is never started twice for the same release.
 *
 * Platform support mirrors what can actually self-install today: Windows NSIS
 * and Linux AppImage. macOS auto-update requires a Developer ID-signed and
 * notarized app, which this project does not yet produce, so macOS reports
 * `unsupported` and is routed to the releases page for a manual download. The
 * same applies to any unpackaged (dev) run.
 *
 * The electron-updater instance is INJECTED rather than imported at module
 * scope so the state machine below is unit-testable in plain Node with no
 * Electron runtime — see test/updater.test.ts.
 */

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export type UpdaterChannel = 'stable' | 'beta';

export interface UpdaterState {
  status: UpdaterStatus;
  currentVersion: string;
  /** Version discovered by the last successful check, when newer than current. */
  availableVersion: string | null;
  /** 0-100 while downloading, else null. */
  percent: number | null;
  /** Only ever set by a user-initiated action — silent checks stay quiet. */
  error: string | null;
  channel: UpdaterChannel;
  /** False on macOS and unpackaged runs: the UI must offer a manual download. */
  supported: boolean;
  /** Where to send a user whose platform cannot self-install. */
  releasesUrl: string;
}

/** Minimal surface this wrapper needs, so tests can supply a fake. */
export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface UpdaterDeps {
  updater: AppUpdaterLike;
  currentVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  prerelease: boolean;
  /** Injected so tests can assert throttling without real time. */
  now?: () => number;
  onStateChange?: (state: UpdaterState) => void;
}

export const RELEASES_URL = 'https://github.com/itlackey/openpalm/releases';

/**
 * Whether an IPC message may drive the updater. Updater IPC can download and
 * execute an installer, so it is gated on the EXACT origin the trusted UI is
 * served from — scheme, host and port all matched, not a prefix.
 *
 * `localhost` is deliberately NOT accepted even though the window would load
 * it: `http://localhost:P` and `http://127.0.0.1:P` are different origins to
 * the browser (different cookie jars — the same reason every OpenPalm entry
 * point settled on the literal IP), so accepting both would widen the trust
 * boundary to an origin the app never serves. A prefix test would be worse
 * still: `http://127.0.0.1:PORT@evil.com` and `http://127.0.0.1:PORTX.evil.com`
 * both start with the trusted string while pointing at an attacker.
 */
export function isTrustedUpdaterSender(senderUrl: string, uiPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(senderUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.port === String(uiPort)
  );
}

/**
 * Desktop channels are exactly two (#572 item 10). The pre-existing desktop
 * "check prereleases" opt-in (#504) maps onto `beta`; there is deliberately no
 * custom `rc` channel for the updater to resolve.
 */
export function updaterChannel(prerelease: boolean): UpdaterChannel {
  return prerelease ? 'beta' : 'stable';
}

/**
 * The feed file electron-updater actually requests for a channel.
 *
 * electron-updater turns `channel` straight into a filename —
 * `getChannelFilename(c)` returns `${c}.yml` — and electron-builder names the
 * stable feed `latest.yml`, not `stable.yml` (its default channel IS "latest";
 * a prerelease version like 1.2.3-beta.4 emits `beta.yml` instead). So the
 * user-facing label and the wire name differ for exactly one channel, and
 * assigning the label directly would make every stable install request a
 * `stable.yml` that is never published — a 404 on every check, which reads to
 * the user as "no updates" forever.
 */
export function updaterFeedChannel(channel: UpdaterChannel): string {
  return channel === 'stable' ? 'latest' : channel;
}

/**
 * Whether this build can install an update in place. Windows (NSIS) and Linux
 * (AppImage) can; macOS cannot until the app is Developer ID-signed AND
 * notarized, because electron-updater's macOS path verifies the signature and
 * an unsigned in-place replacement would leave the user with an app Gatekeeper
 * refuses to launch. An unpackaged dev run has no installer at all.
 */
export function isAutoUpdateSupported(platform: NodeJS.Platform, isPackaged: boolean): boolean {
  if (!isPackaged) return false;
  return platform === 'win32' || platform === 'linux';
}

/** Throttle for focus-triggered checks — a window regains focus constantly. */
export const FOCUS_CHECK_THROTTLE_MS = 60 * 60 * 1000;

export class DesktopUpdater {
  private readonly deps: UpdaterDeps;
  private readonly now: () => number;
  private state: UpdaterState;
  private checkInFlight: Promise<UpdaterState> | null = null;
  private downloadInFlight: Promise<UpdaterState> | null = null;
  /** null = never checked. Not 0: that is a real (if ancient) timestamp. */
  private lastCheckAt: number | null = null;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    const supported = isAutoUpdateSupported(deps.platform, deps.isPackaged);
    this.state = {
      status: supported ? 'idle' : 'unsupported',
      currentVersion: deps.currentVersion,
      availableVersion: null,
      percent: null,
      error: null,
      channel: updaterChannel(deps.prerelease),
      supported,
      releasesUrl: RELEASES_URL,
    };
    if (!supported) return;

    const u = deps.updater;
    // Consent before bytes: discovery must not download (#572 acceptance).
    u.autoDownload = false;
    // A staged update also installs on an ordinary quit, not only via the
    // explicit "Restart and update" action.
    u.autoInstallOnAppQuit = true;
    u.channel = updaterFeedChannel(this.state.channel);
    u.allowPrerelease = deps.prerelease;

    u.on('download-progress', (...args: unknown[]) => {
      const progress = args[0] as { percent?: number } | undefined;
      const percent = typeof progress?.percent === 'number' ? progress.percent : null;
      this.patch({ status: 'downloading', percent });
    });
    u.on('update-downloaded', () => {
      this.patch({ status: 'downloaded', percent: 100, error: null });
    });
  }

  getState(): UpdaterState {
    return { ...this.state };
  }

  private patch(next: Partial<UpdaterState>): UpdaterState {
    this.state = { ...this.state, ...next };
    this.deps.onStateChange?.(this.getState());
    return this.getState();
  }

  /**
   * Check for a newer release. `silent` suppresses error reporting (startup and
   * focus checks) — an offline machine is normal, and a persistent error banner
   * for it is noise. A manual check reports the real reason instead.
   *
   * Single-flight: a second call while one is in flight returns the same
   * promise rather than issuing a second request.
   */
  async check({ silent = false }: { silent?: boolean } = {}): Promise<UpdaterState> {
    if (!this.state.supported) return this.getState();
    if (this.checkInFlight) return this.checkInFlight;
    // Never re-check on top of a completed download; the answer is already
    // "restart to apply", and re-checking would reset that back to `available`.
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return this.getState();
    }

    this.lastCheckAt = this.now();
    this.patch({ status: 'checking', error: null });
    const run = (async (): Promise<UpdaterState> => {
      try {
        const result = await this.deps.updater.checkForUpdates();
        const version = result?.updateInfo?.version ?? null;
        // electron-updater resolves with the FEED's version whether or not it
        // is newer, so "available" means strictly newer than what we run.
        const available = !!version && version !== this.state.currentVersion;
        return this.patch({
          status: available ? 'available' : 'not-available',
          availableVersion: available ? version : null,
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Silent checks leave the prior state intact and stay quiet.
        if (silent) return this.patch({ status: 'idle', error: null });
        return this.patch({ status: 'error', error: message });
      } finally {
        this.checkInFlight = null;
      }
    })();
    this.checkInFlight = run;
    return run;
  }

  /**
   * Startup and focus checks share one throttle so a user who alt-tabs
   * repeatedly does not generate a check per focus event.
   */
  async checkOnFocus(): Promise<UpdaterState> {
    if (!this.state.supported) return this.getState();
    if (this.lastCheckAt !== null && this.now() - this.lastCheckAt < FOCUS_CHECK_THROTTLE_MS) {
      return this.getState();
    }
    return this.check({ silent: true });
  }

  /**
   * Download the discovered update. Requires a prior successful check that
   * found one: this is the consent step, so it never implicitly checks.
   */
  async download(): Promise<UpdaterState> {
    if (!this.state.supported) return this.getState();
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.state.status === 'downloaded') return this.getState();
    if (this.state.status !== 'available') {
      return this.patch({ status: 'error', error: 'No update is available to download.' });
    }

    this.patch({ status: 'downloading', percent: 0, error: null });
    const run = (async (): Promise<UpdaterState> => {
      try {
        await this.deps.updater.downloadUpdate();
        // `update-downloaded` normally moves us to 'downloaded'; if a fake or a
        // provider resolves without emitting it, don't strand the UI at
        // 'downloading'.
        if (this.state.status !== 'downloaded') {
          return this.patch({ status: 'downloaded', percent: 100, error: null });
        }
        return this.getState();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return this.patch({ status: 'error', percent: null, error: message });
      } finally {
        this.downloadInFlight = null;
      }
    })();
    this.downloadInFlight = run;
    return run;
  }

  /**
   * Install the staged update now. No-op unless a download completed — calling
   * quitAndInstall without one would quit the app and install nothing.
   */
  quitAndInstall(): boolean {
    if (!this.state.supported || this.state.status !== 'downloaded') return false;
    this.deps.updater.quitAndInstall(false, true);
    return true;
  }
}
