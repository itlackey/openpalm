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
 * - `autoInstallOnAppQuit = false`. electron-updater's OWN install-on-quit
 *   hook (`BaseUpdater.addQuitHandler`) is wired to Electron's `app`'s
 *   `'quit'` event — but main.ts's `before-quit` handler always finishes with
 *   `app.exit(0)`, which Electron's own docs state skips `before-quit` /
 *   `will-quit`, and does not run the normal will-quit → window-teardown →
 *   `quit` sequence those events gate, so that hook's listener would never be
 *   reached regardless of this flag (verified against installed
 *   electron-updater 6.8.9's `BaseUpdater`/`ElectronAppAdapter` sources).
 *   Leaving it `true` would be pure decoration, so it is explicitly off.
 *   Ordinary quit DOES still install a staged update — see `installOnQuit()`
 *   below, which main.ts's before-quit handler calls directly instead of
 *   depending on electron-updater's hook. It deliberately calls `install()`,
 *   NOT `quitAndInstall()`: the latter schedules electron-updater's OWN
 *   `app.quit()` internally, and racing that against main.ts's own exit
 *   sequence is exactly the double-quit hazard the `app.exit(0)` switch in
 *   before-quit exists to avoid (see its comment) — reintroducing it here
 *   would trade one dead setting for a live bug. `install()` alone just
 *   launches the installer and returns; it never touches app lifecycle, so
 *   before-quit's existing `app.exit(0)` remains the one thing that ends the
 *   process, on every path, whether or not a staged update happened to exist.
 *   "Restart and update" (the explicit button, `quitAndInstall()`) is
 *   unaffected — it is a user-chosen restart, not an ordinary quit, and keeps
 *   using electron-updater's own quit path.
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
  /** False on macOS, Windows portable builds, and unpackaged runs. */
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
  downloadUpdate(cancellationToken?: CancellationTokenLike): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  /**
   * Trigger the installer WITHOUT quitting — unlike `quitAndInstall`, which
   * always schedules electron-updater's own `app.quit()` internally. Returns
   * whether the installer actually launched. See `installOnQuit()` below for
   * why the desktop harness needs this split.
   */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /**
   * Needed by `dispose()` (review E6): `createDesktopUpdater` builds a FRESH
   * DesktopUpdater over the SAME singleton `autoUpdater` every time the
   * prerelease-channel toggle fires, and without a way to remove the prior
   * instance's `download-progress`/`update-downloaded` listeners, N toggles
   * leave N of each registered — all still firing, all still calling their
   * (stale) `onStateChange` closure.
   */
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Minimal cancellation surface (electron-updater's CancellationToken). */
export interface CancellationTokenLike {
  cancel(): void;
}

export interface UpdaterDeps {
  updater: AppUpdaterLike;
  currentVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** Set by electron-builder when its Windows portable launcher runs the app. */
  portableExecutableFile?: string;
  /** NSIS ships this beside the installed executable; extracted archives do not. */
  windowsInstallerPresent: boolean;
  prerelease: boolean;
  /** Injected so tests can assert throttling without real time. */
  now?: () => number;
  onStateChange?: (state: UpdaterState) => void;
  /**
   * Builds the token `download()` hands to `downloadUpdate` so `dispose()` can
   * cancel an in-flight download (review E3): the prerelease-channel toggle
   * rebuilds this wrapper over the SAME singleton `autoUpdater`, and without
   * cancellation the old instance's download keeps running — completing on the
   * OLD channel's artifact after the user switched away from it. Injected
   * (main.ts passes electron-updater's own CancellationToken) so the state
   * machine stays testable in plain Node.
   */
  createCancellationToken?: () => CancellationTokenLike;
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
 * refuses to launch. An unpackaged dev run has no installer at all. A Windows
 * portable build also has no install location to replace. electron-builder's
 * portable launcher identifies that runtime with PORTABLE_EXECUTABLE_FILE,
 * while an installed NSIS runtime is positively identified by its adjacent
 * shipped uninstaller so an extracted ZIP cannot install into a second copy.
 */
export function isAutoUpdateSupported(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  windowsInstallerPresent: boolean,
  portableExecutableFile?: string,
): boolean {
  if (!isPackaged) return false;
  if (platform === 'win32') return windowsInstallerPresent && !portableExecutableFile;
  return platform === 'linux';
}

function parseSemver(
  version: string,
): { release: [number, number, number]; prerelease: Array<string | number> | null } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/.exec(
    version.trim(),
  );
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    // Per semver §11, numeric identifiers compare numerically, so beta.4 <
    // beta.10 — parse them to numbers here rather than comparing strings.
    prerelease: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : null,
  };
}

/**
 * Whether `candidate` is a strictly NEWER semver than `current`. `check()`
 * below needs this because electron-updater resolves with whatever version the
 * feed carries, newer or not — and a plain `!==` treated a beta install on the
 * default stable channel as having an "update" to the OLDER stable release, a
 * phantom whose download can never succeed (electron-updater never stages a
 * not-newer update).
 *
 * electron-updater's own `semver` dependency is not resolvable from this
 * package (isolated installs), so this is a small local comparison covering
 * the semver precedence rules that matter here: a prerelease sorts BEFORE its
 * release (1.2.3-beta.4 < 1.2.3), numeric identifiers compare numerically
 * (beta.4 < beta.10), and a longer identifier set wins over its own prefix.
 * When either side is not semver at all, this falls back to plain inequality —
 * the prior behavior for strings it cannot order.
 */
export function isVersionNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return candidate !== current;
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] > b.release[i];
  }
  // Same release: a prerelease sorts before the release itself.
  if (!a.prerelease) return b.prerelease !== null;
  if (!b.prerelease) return false;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // Equal prefix: the version with MORE identifiers is the newer one.
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (x === y) continue;
    // Numeric identifiers always have lower precedence than alphanumeric.
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    if (typeof x === 'number' || typeof y === 'number') return typeof y === 'number';
    return x > y;
  }
  return false;
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
  /** Token for the in-flight download, so dispose() can cancel it (review E3). */
  private downloadCancellation: CancellationTokenLike | null = null;
  /**
   * Set the first time THIS staged update's install has actually been handed
   * to electron-updater, via EITHER `quitAndInstall()` or `installOnQuit()`;
   * cleared when a new download starts. (#635)
   *
   * electron-updater's own re-entry guard (`BaseUpdater#quitAndInstallCalled`)
   * is set unconditionally by `install()` before it even attempts the install,
   * and on failure is reset back to `false` ONLY inside `quitAndInstall()`'s
   * own wrapper — never when `install()` is called directly, which is exactly
   * the path `installOnQuit()` uses (see its docblock). So once a silent
   * install-on-quit has been attempted once, EVERY later call on EITHER path —
   * for the rest of this process's life — is guaranteed to fail, and
   * electron-updater itself only logs that as a quiet
   * "install call ignored: quitAndInstallCalled is set to true" warning.
   * Worse, `quitAndInstall()`'s own `app.quit()` fires Electron's real 'quit'
   * lifecycle, which main.ts's before-quit handler reaches too — so a single
   * user click on "Restart and update" was already making TWO raw calls into
   * electron-updater (one via `quitAndInstall()`, one via the `installOnQuit()`
   * that before-quit calls unconditionally afterward).
   *
   * This flag stops OUR code from ever making that doomed (or redundant)
   * second call — a repeat attempt is refused right here, loudly, instead of
   * silently retrying into a no-op.
   */
  private installAttempted = false;
  // Bound listener references, kept so dispose() can remove exactly these
  // from the shared singleton updater (review E6 — see dispose() below).
  private readonly onDownloadProgress: ((...args: unknown[]) => void) | null;
  private readonly onUpdateDownloaded: ((...args: unknown[]) => void) | null;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    const supported = isAutoUpdateSupported(
      deps.platform,
      deps.isPackaged,
      deps.windowsInstallerPresent,
      deps.portableExecutableFile,
    );
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
    if (!supported) {
      this.onDownloadProgress = null;
      this.onUpdateDownloaded = null;
      return;
    }

    const u = deps.updater;
    // Consent before bytes: discovery must not download (#572 acceptance).
    u.autoDownload = false;
    // Off — see the class docblock. Ordinary-quit install is handled
    // explicitly by `installOnQuit()` below, not by electron-updater's own
    // (unreachable) install-on-quit hook.
    u.autoInstallOnAppQuit = false;
    u.channel = updaterFeedChannel(this.state.channel);
    u.allowPrerelease = deps.prerelease;

    this.onDownloadProgress = (...args: unknown[]) => {
      const progress = args[0] as { percent?: number } | undefined;
      const percent = typeof progress?.percent === 'number' ? progress.percent : null;
      this.patch({ status: 'downloading', percent });
    };
    this.onUpdateDownloaded = (...args: unknown[]) => {
      // Review E3: the singleton autoUpdater outlives this wrapper across
      // prerelease-channel toggles, so a download begun by a PREVIOUS instance
      // can complete after the rebuild and fire this listener with the OLD
      // channel's artifact — which quit would then install. Ignore any version
      // this instance never itself reported as available. (dispose() also
      // cancels the old download; this guards the race where it completes
      // first. Dropping that staged artifact on a channel switch is by design:
      // the user just switched away from the channel it came from.)
      const info = args[0] as { version?: string } | undefined;
      if (typeof info?.version === 'string' && info.version !== this.state.availableVersion) return;
      this.patch({ status: 'downloaded', percent: 100, error: null });
    };
    u.on('download-progress', this.onDownloadProgress);
    u.on('update-downloaded', this.onUpdateDownloaded);
  }

  getState(): UpdaterState {
    return { ...this.state };
  }

  /**
   * Remove this instance's listeners from the shared electron-updater
   * singleton (review E6). `createDesktopUpdater` in main.ts builds a FRESH
   * DesktopUpdater over that same singleton every time the prerelease-channel
   * toggle fires (#504); without this, N toggles leave N sets of
   * 'download-progress'/'update-downloaded' listeners all still firing —
   * each patching a `this.state` nothing reads anymore, but still forwarding
   * through its own (now stale) `onStateChange` closure. Call before
   * discarding an instance in favor of a new one. Safe to call more than
   * once or on an `unsupported` instance (no-op either way).
   */
  dispose(): void {
    if (!this.state.supported) return;
    // Review E3: a download begun by THIS instance must not keep running on
    // the shared singleton after the channel toggle discards the instance.
    // Cancelling also drops anything it already staged — deliberate: an
    // artifact from the OLD channel must never be what quit installs after
    // the user switched channels.
    this.downloadCancellation?.cancel();
    this.downloadCancellation = null;
    if (this.onDownloadProgress) this.deps.updater.removeListener('download-progress', this.onDownloadProgress);
    if (this.onUpdateDownloaded) this.deps.updater.removeListener('update-downloaded', this.onUpdateDownloaded);
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
    // Review E1: captured BEFORE patching 'checking' so a failed SILENT check
    // can restore it — patching 'idle' there clobbered a previously discovered
    // 'available' (while leaving availableVersion set) whenever an offline
    // focus check failed.
    const priorStatus = this.state.status;
    this.patch({ status: 'checking', error: null });
    const run = (async (): Promise<UpdaterState> => {
      try {
        const result = await this.deps.updater.checkForUpdates();
        const version = result?.updateInfo?.version ?? null;
        // electron-updater resolves with the FEED's version whether or not it
        // is newer, so "available" means strictly newer than what we run — a
        // mere `!==` would report a beta install's OLDER stable release as a
        // phantom update (see isVersionNewer above).
        const available = !!version && isVersionNewer(version, this.state.currentVersion);
        return this.patch({
          status: available ? 'available' : 'not-available',
          availableVersion: available ? version : null,
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Silent checks leave the prior state intact and stay quiet: restore
        // the pre-check status so an already-discovered 'available' (with its
        // availableVersion) survives an offline focus check (review E1).
        if (silent) return this.patch({ status: priorStatus, error: null });
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
    // A fresh downloaded artifact gets a fresh, one-shot install budget (#635).
    this.installAttempted = false;
    // Held so dispose() can cancel this download if the channel toggle
    // discards the instance mid-flight (review E3).
    this.downloadCancellation = this.deps.createCancellationToken?.() ?? null;
    const token = this.downloadCancellation;
    const run = (async (): Promise<UpdaterState> => {
      try {
        await this.deps.updater.downloadUpdate(token ?? undefined);
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
        if (this.downloadCancellation === token) this.downloadCancellation = null;
      }
    })();
    this.downloadInFlight = run;
    return run;
  }

  /**
   * Install the staged update now. No-op unless a download completed — calling
   * quitAndInstall without one would quit the app and install nothing.
   *
   * At most once per downloaded update (#635): a repeat call — e.g. the
   * `installOnQuit()` that main.ts's before-quit handler makes unconditionally
   * once electron-updater's own `app.quit()` (fired below) reaches it — is
   * refused here rather than making a second, doomed raw call into
   * electron-updater. See `installAttempted`'s docblock.
   */
  quitAndInstall(): boolean {
    if (!this.state.supported || this.state.status !== 'downloaded') return false;
    if (this.installAttempted) {
      console.error(
        '[updater] quitAndInstall() refused: an install was already attempted for this ' +
          'staged update (#635 single-attempt guard) — electron-updater would silently ' +
          'ignore a second call anyway.',
      );
      return false;
    }
    this.installAttempted = true;
    this.deps.updater.quitAndInstall(false, true);
    return true;
  }

  /**
   * Silently launch the installer for an already-staged update WITHOUT
   * quitting — called by main.ts's before-quit handler immediately before its
   * own `app.exit(0)`, since a real Electron `'quit'` event (which
   * electron-updater's built-in install-on-quit hook needs) never fires from
   * that path (see this class's docblock and `autoInstallOnAppQuit` above).
   *
   * Silent + no relaunch (`install(true, false)`): an ordinary quit is not
   * "restart now" — that stays the explicit button's job (`quitAndInstall()`,
   * non-silent, force-run-after).
   *
   * No-op (returns false) unless a download has actually completed.
   *
   * At most once per downloaded update (#635). Two distinct "already handled"
   * cases share that budget with `quitAndInstall()`:
   *  - Expected, benign: `quitAndInstall()` already installed this update and
   *    its own `app.quit()` is what brought us to this before-quit call in the
   *    first place. Nothing failed — refuse quietly instead of making a second
   *    raw call electron-updater would ignore anyway.
   *  - Genuine failure: an EARLIER `installOnQuit()` in this same process
   *    already tried and failed. electron-updater's guard means a retry here
   *    is guaranteed to fail too (see `installAttempted`'s docblock), so
   *    refuse — loudly, since this is the only path a stuck-forever updater
   *    would otherwise never be reported on.
   */
  installOnQuit(): boolean {
    if (!this.state.supported || this.state.status !== 'downloaded') return false;
    if (this.installAttempted) return false;
    this.installAttempted = true;
    const launched = this.deps.updater.install(true, false);
    if (!launched) {
      // Loud and unconditional: this quit proceeds regardless (main.ts's
      // before-quit handler calls app.exit(0) right after), so this is the
      // only chance to record that the staged update was NOT applied — the
      // app is about to relaunch on its OLD version, and (#635)
      // electron-updater's own quitAndInstallCalled guard means no later
      // attempt in this process can ever succeed either.
      console.error(
        '[updater] installOnQuit() failed to launch the update installer; the staged ' +
          'update was NOT applied. This process cannot retry it — electron-updater\'s ' +
          'quitAndInstallCalled guard is now permanently set for this run.',
      );
    }
    return launched;
  }
}
