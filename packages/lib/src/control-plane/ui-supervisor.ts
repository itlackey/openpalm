/**
 * Shared UI-server supervisor primitives.
 *
 * The CLI UI commands and the Electron desktop shell both run a
 * long-lived supervisor around the SvelteKit adapter-node UI child: they spawn
 * it and wait for it to become ready.
 *
 * These two harnesses independently reimplemented the same logic and DRIFTED
 * (notably the ready-timeout: CLI 15s vs Electron 60s). This module is the SSOT
 * for the pure, harness-agnostic pieces so both consume one implementation.
 *
 * Node.js-compatible only (no Bun.* APIs) so the Electron Node child can use it.
 * No `process.exit` here — these functions return/throw and the CLI/Electron
 * entry points decide exit behavior.
 */

/**
 * Default readiness timeout (ms). Unifies the previously-divergent CLI (15s) and
 * Electron (60s) values on the more tolerant 60s so a slow first start — where
 * the UI child may pull/build images before it can answer /health — does not
 * spuriously fail the supervisor.
 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Injectable dependencies for {@link waitForReady} (defaults to real timers/fetch). */
export interface WaitForReadyDeps {
  /** Hostname used by the health probe (defaults to IPv4 loopback). */
  host?: string;
  /** Fetch implementation (defaults to the global `fetch`). */
  fetchFn?: typeof fetch;
  /** Sleep between polls (defaults to a real setTimeout-backed delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between health polls, ms (default 300). */
  pollIntervalMs?: number;
  /** Per-request abort timeout, ms (default 1000). */
  requestTimeoutMs?: number;
  /** Clock (defaults to Date.now); injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Poll the selected loopback host's `/health` until the UI server answers or the
 * timeout elapses. A 200 OR a 401 both count as ready: 401 means the server is
 * up but behind the login wall, which is still "started".
 *
 * @returns true once ready; false if the deadline passes first.
 */
export async function waitForReady(
  port: number,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
  deps: WaitForReadyDeps = {},
): Promise<boolean> {
  const {
    host = '127.0.0.1',
    fetchFn = fetch,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 300,
    requestTimeoutMs = 1000,
    now = Date.now,
  } = deps;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const res = await fetchFn(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (res.ok || res.status === 401) return true;
    } catch {
      // not ready yet
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

// ── Instance identity probe ───────────────────────────────────────────────────

/** Outcome of {@link checkExistingUiInstance}. */
export type UiInstanceCheck =
  | { status: 'absent' }
  | { status: 'match'; admin: boolean }
  | { status: 'mismatch'; admin: boolean };

/** Fetch and parse a JSON body; `null` on any failure — "couldn't confirm" is
 *  treated as "not there", never as a hard failure. */
async function probeJson<T>(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Pre-spawn instance-identity probe.
 *
 * Readiness alone is a bare port poll (200 OR 401) that cannot tell "our child
 * is still starting" from "our child died of EADDRINUSE and the poll is hitting
 * some OTHER process that happens to own the port". The CLI learned this (D1);
 * Electron never did, and the failure is user-visible: with a bare `openpalm`
 * already serving a non-admin UI on 3880, launching the desktop app spawned a
 * child that died instantly, `waitForReady` was satisfied by the FOREIGN
 * server, and the window opened onto a UI with no host capability — /host
 * silently redirecting to /chat.
 *
 * `absent` → nothing there, spawn normally. `match` → an OpenPalm UI of the
 * expected capability level already owns the port, so attach instead of racing
 * it. `mismatch` → something OpenPalm-shaped but of the WRONG capability level;
 * the caller must refuse with an actionable error rather than silently open the
 * wrong thing.
 */
export async function checkExistingUiInstance(
  port: number,
  expectedAdmin: boolean,
  deps: { fetchFn?: typeof fetch; host?: string; timeoutMs?: number } = {},
): Promise<UiInstanceCheck> {
  const fetchFn = deps.fetchFn ?? fetch;
  const host = deps.host ?? '127.0.0.1';
  // Loopback targets answer near-instantly or are not there at all.
  const timeoutMs = deps.timeoutMs ?? 1_500;
  const body = await probeJson<{ admin?: boolean }>(
    fetchFn,
    `http://${host}:${port}/api/runtime`,
    timeoutMs,
  );
  if (body === null) return { status: 'absent' };
  const admin = body.admin === true;
  return admin === expectedAdmin ? { status: 'match', admin } : { status: 'mismatch', admin };
}

/**
 * Readiness that loses to the child's own death.
 *
 * Wrap a readiness poll so a child which exits before the poll settles reports
 * not-ready IMMEDIATELY, instead of waiting out the full timeout while some
 * unrelated process on the port answers for it. `childExited` is the harness's
 * own "this handle has exited" promise (Bun's `proc.exited`, or a promise
 * resolved from node's `exit` event).
 */
export function readyOrChildExit(
  waitFn: () => Promise<boolean>,
  childExited: Promise<unknown> | undefined,
): Promise<boolean> {
  if (!childExited) return waitFn();
  // Both settlement paths mean the same thing — the child is gone, so it is not
  // ready. A REJECTION must not propagate: node's `events.once(child, 'exit')`
  // rejects if the child emits `error` first, and letting that escape would turn
  // "the child failed to spawn" into an exception thrown out of the supervisor
  // instead of the not-ready result its callers handle.
  return Promise.race([
    waitFn(),
    childExited.then(
      () => false,
      () => false,
    ),
  ]);
}

// ── UiSupervisor state machine ────────────────────────────────────────────────
// The CLI UI commands and the Electron desktop shell run the same
// supervisor STATE MACHINE around the UI child — spawn → wait-for-ready — but
// they differ in every harness-scoped DETAIL:
//
//   • how the child is spawned/killed (Bun.Subprocess + proc.exited race vs
//     node child_process + killProcessTree + fixed delay),
//   • what happens on a ready-failure (CLI process.exit(1) vs Electron
//     dialog.showErrorBox + app.quit()).
//
// This class owns ONLY the state machine. Every harness-scoped effect is an
// injected strategy method or callback, so the lib stays `process.exit`-free
// (design §6.2 / §4.4).

/**
 * Per-harness process strategy: abstracts the Bun.Subprocess vs
 * node:child_process + killProcessTree divergence behind spawn/stop. `Handle` is
 * the opaque child handle the harness understands (never inspected by the
 * supervisor).
 */
export interface UiChildStrategy<Handle> {
  /**
   * Spawn a fresh UI child and return its handle. The harness owns everything
   * around the spawn (update-checks, env-building, pid-file, stdio/log wiring).
   */
  spawn(): Promise<Handle> | Handle;
  /**
   * Graceful-then-force stop of a running child. The harness owns the EXACT
   * kill sequence — CLI: `kill('SIGTERM')` → race `proc.exited` against a
   * timeout → conditional `kill('SIGKILL')`; Electron: `killProcessTree('SIGTERM')`
   * → fixed delay → `killProcessTree('SIGKILL')`.
   */
  stop(handle: Handle): Promise<void>;
}

/**
 * Harness-scoped callbacks. The supervisor stays `process.exit`-free: the exit /
 * quit / dialog / renderer-reload decisions all live in these adapter hooks.
 */
export interface UiSupervisorCallbacks<Handle> {
  /** Readiness poll (adapter injects its own timeout wrapper around {@link waitForReady}). */
  waitForReady(port: number): Promise<boolean>;
  /**
   * The INITIAL start never became ready. The lib does NOT exit — the adapter
   * decides: CLI kills the child + `process.exit(1)`. Receives the spawned
   * handle so the adapter can kill it if it wants to. Optional: harnesses that
   * drive their own bespoke initial spawn and {@link UiSupervisor.adopt} the
   * child (e.g. Electron) never call {@link UiSupervisor.start} and omit this.
   */
  onStartFailure?(handle: Handle): void | Promise<void>;
  /** Log sink for the shared informational state-machine lines (defaults to console.log — stdout). */
  log?(...args: unknown[]): void;
  /** Log sink for the shared FAILURE lines (defaults to console.error — stderr). */
  logError?(...args: unknown[]): void;
}

export interface UiSupervisorOptions<Handle> {
  /** UI-server port the readiness poll targets. */
  port: number;
  strategy: UiChildStrategy<Handle>;
  callbacks: UiSupervisorCallbacks<Handle>;
}

/**
 * Shared supervisor state machine for the UI child. Both harnesses construct one
 * with their own {@link UiChildStrategy} + {@link UiSupervisorCallbacks}; the CLI
 * and Electron entry points become thin adapters that supply the divergent
 * spawn/kill/exit/dialog/reload behavior.
 */
export class UiSupervisor<Handle> {
  private handle: Handle | null = null;
  private readonly port: number;
  private readonly strategy: UiChildStrategy<Handle>;
  private readonly cb: UiSupervisorCallbacks<Handle>;

  constructor(opts: UiSupervisorOptions<Handle>) {
    this.port = opts.port;
    this.strategy = opts.strategy;
    this.cb = opts.callbacks;
  }

  /** The current child handle (null before the first start / after a failed spawn). */
  get current(): Handle | null {
    return this.handle;
  }

  /**
   * Adopt a child that was spawned OUTSIDE the supervisor. Use this when a
   * harness owns a bespoke initial-spawn path (e.g. Electron's seed-or-quit +
   * splash + stderr ring-buffer prelude). The alternative to {@link start} for
   * the first child.
   */
  adopt(handle: Handle): void {
    this.handle = handle;
  }

  /**
   * Spawn the UI child and wait for it to become ready. On a ready-timeout the
   * {@link UiSupervisorCallbacks.onStartFailure} hook runs (the lib never exits).
   *
   * @returns true once the child is ready; false if it timed out (after the hook ran).
   */
  async start(): Promise<boolean> {
    this.handle = await this.strategy.spawn();
    if (!(await this.cb.waitForReady(this.port))) {
      await this.cb.onStartFailure?.(this.handle);
      return false;
    }
    return true;
  }
}
