import { describe, test, expect } from "bun:test";
import {
  DEFAULT_READY_TIMEOUT_MS,
  waitForReady,
  restoreUiBackup,
  UiSupervisor,
  type RestoreUiBackupDeps,
  type UiChildStrategy,
  type UiSupervisorCallbacks,
} from "./ui-supervisor.js";

// ── waitForReady ─────────────────────────────────────────────────────────────
// Characterization: locks in the /health poll contract shared by the CLI and
// Electron supervisors (200 OR 401 == ready; otherwise poll until the deadline).

describe("waitForReady", () => {
  const noSleep = () => Promise.resolve();

  test("exposes a 60s default timeout (unifies CLI 15s / Electron 60s)", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBe(60_000);
  });

  test("resolves true when the server responds 200", async () => {
    const fetchFn = (() => Promise.resolve({ ok: true, status: 200 } as Response)) as typeof fetch;
    expect(await waitForReady(3880, 5000, { fetchFn, sleep: noSleep })).toBe(true);
  });

  test("resolves true on 401 (auth wall = server is up)", async () => {
    const fetchFn = (() => Promise.resolve({ ok: false, status: 401 } as Response)) as typeof fetch;
    expect(await waitForReady(3880, 5000, { fetchFn, sleep: noSleep })).toBe(true);
  });

  test("keeps polling on non-ready status, then succeeds", async () => {
    let calls = 0;
    const fetchFn = (() => {
      calls += 1;
      return Promise.resolve(
        calls < 3 ? ({ ok: false, status: 503 } as Response) : ({ ok: true, status: 200 } as Response),
      );
    }) as typeof fetch;
    expect(await waitForReady(3880, 5000, { fetchFn, sleep: noSleep })).toBe(true);
    expect(calls).toBe(3);
  });

  test("resolves false when the server never responds before the deadline", async () => {
    // Deterministic clock: advance the virtual time past the deadline over polls.
    let t = 0;
    const now = () => (t += 200); // each read jumps forward 200ms
    const fetchFn = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
    expect(await waitForReady(3880, 1000, { fetchFn, sleep: noSleep, now })).toBe(false);
  });

  test("targets /health on loopback with the given port", async () => {
    const urls: string[] = [];
    const fetchFn = ((url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;
    await waitForReady(4321, 5000, { fetchFn, sleep: noSleep });
    expect(urls[0]).toBe("http://127.0.0.1:4321/health");
  });
});

// ── restoreUiBackup ──────────────────────────────────────────────────────────
// Characterization of the copy-pasted backup-restore block: move the failed
// data/ui to `.ui-failed-<ts>` then rename the backup back into place.

describe("restoreUiBackup", () => {
  function harness(overrides: Partial<RestoreUiBackupDeps> & { present?: Set<string> } = {}) {
    const present = overrides.present ?? new Set<string>();
    const renames: Array<[string, string]> = [];
    const logs: unknown[][] = [];
    const deps: RestoreUiBackupDeps = {
      existsSync: (p) => present.has(p),
      renameSync: (from, to) => {
        renames.push([from, to]);
        if (present.delete(from)) present.add(to);
      },
      now: () => 1234,
      log: (...args) => logs.push(args),
      ...overrides,
    };
    return { present, renames, logs, deps };
  }

  test("no-op when no backup dir is provided", () => {
    const { renames, deps } = harness();
    expect(restoreUiBackup("/data", undefined, deps)).toEqual({ status: "no-backup" });
    expect(renames).toHaveLength(0);
  });

  test("no-op when the backup dir does not exist", () => {
    const { renames, deps } = harness({ present: new Set(["/data/other"]) });
    expect(restoreUiBackup("/data", "/data/.ui-backup", deps)).toEqual({ status: "no-backup" });
    expect(renames).toHaveLength(0);
  });

  test("moves the failed build aside then reinstates the backup", () => {
    const { renames, logs, deps } = harness({
      present: new Set(["/data/.ui-backup", "/data/ui"]),
    });
    const outcome = restoreUiBackup("/data", "/data/.ui-backup", deps);
    expect(outcome.status).toBe("restored");
    expect(outcome.failedDir).toBe("/data/.ui-failed-1234");
    // Order matters: current build → .ui-failed-<ts>, THEN backup → ui.
    expect(renames).toEqual([
      ["/data/ui", "/data/.ui-failed-1234"],
      ["/data/.ui-backup", "/data/ui"],
    ]);
    expect(logs[0][0]).toContain("reinstated backup from /data/.ui-backup");
  });

  test("skips the failed-move rename when data/ui is absent", () => {
    const { renames, deps } = harness({ present: new Set(["/data/.ui-backup"]) });
    const outcome = restoreUiBackup("/data", "/data/.ui-backup", deps);
    expect(outcome.status).toBe("restored");
    expect(renames).toEqual([["/data/.ui-backup", "/data/ui"]]);
  });

  test("reports an error (and logs) when a rename throws", () => {
    const { logs, deps } = harness({ present: new Set(["/data/.ui-backup", "/data/ui"]) });
    deps.renameSync = () => {
      throw new Error("EPERM");
    };
    const outcome = restoreUiBackup("/data", "/data/.ui-backup", deps);
    expect(outcome.status).toBe("error");
    expect((outcome.error as Error).message).toBe("EPERM");
    expect(logs[0][0]).toBe("UI backup restore failed:");
  });
});

// ── UiSupervisor state machine ────────────────────────────────────────────────
// Characterization of the supervisor STATE MACHINE shared by the CLI and Electron
// harnesses, driven entirely through an injected FAKE process-strategy. Locks in
// the observable contract both adapters must preserve:
//   • normal start → ready
//   • ready-timeout → onStartFailure invoked (NOT process.exit — lib is exit-free)
//   • restart → stop + respawn + wait-for-ready, ordered
//   • restart ready-failure → restoreBackup THEN onRestartFailure (CLI exits /
//     Electron stays up), and NO renderer reload
//   • restart success → onReloadRenderer fired (Electron) / omitted → not fired (CLI)
//   • the `restarting` re-entrancy guard and the `shuttingDown` guard

type FakeHandle = { id: number };

function fakeStrategy() {
  const events: string[] = [];
  let nextId = 1;
  const handles: FakeHandle[] = [];
  const strategy: UiChildStrategy<FakeHandle> = {
    spawn: () => {
      const h = { id: nextId++ };
      handles.push(h);
      events.push(`spawn#${h.id}`);
      return h;
    },
    stop: async (h) => {
      events.push(`stop#${h.id}`);
    },
  };
  return { strategy, events, handles };
}

/** Build a supervisor whose readiness poll returns the queued booleans in order. */
function makeSupervisor(
  readyQueue: boolean[],
  overrides: Partial<UiSupervisorCallbacks<FakeHandle>> = {},
) {
  const { strategy, events, handles } = fakeStrategy();
  const calls: string[] = [];
  let readyIdx = 0;
  const callbacks: UiSupervisorCallbacks<FakeHandle> = {
    waitForReady: () => {
      const v = readyQueue[readyIdx] ?? readyQueue[readyQueue.length - 1] ?? true;
      readyIdx += 1;
      events.push(`ready:${v}`);
      return Promise.resolve(v);
    },
    onStartFailure: (h) => {
      calls.push(`onStartFailure#${h.id}`);
    },
    log: () => {},
    ...overrides,
  };
  const sup = new UiSupervisor<FakeHandle>({ port: 3880, strategy, callbacks });
  return { sup, events, handles, calls };
}

describe("UiSupervisor.start", () => {
  test("normal start spawns then waits for ready and returns true", async () => {
    const { sup, events } = makeSupervisor([true]);
    expect(await sup.start()).toBe(true);
    expect(events).toEqual(["spawn#1", "ready:true"]);
    expect(sup.current).toEqual({ id: 1 });
  });

  test("ready-timeout invokes onStartFailure (no process.exit) and returns false", async () => {
    const calls: string[] = [];
    const { sup, events } = makeSupervisor([false], {
      // The adapter's policy hook — here it just records; a real CLI adapter
      // would process.exit(1) and Electron would show a dialog + app.quit().
      onStartFailure: (h) => {
        calls.push(`fail#${h.id}`);
      },
    });
    expect(await sup.start()).toBe(false);
    expect(events).toEqual(["spawn#1", "ready:false"]);
    // The handle is passed to the policy hook so a CLI adapter can kill it.
    expect(calls).toEqual(["fail#1"]);
  });
});

describe("UiSupervisor.restart", () => {
  test("stops the old child, respawns, waits, then reloads renderer on success", async () => {
    const reloads: string[] = [];
    const { sup, events } = makeSupervisor([true, true], {
      onReloadRenderer: () => reloads.push("reload"),
    });
    await sup.start();
    expect(await sup.restart()).toBe(true);
    // Ordering contract: stop old → spawn new → wait → reload.
    expect(events).toEqual([
      "spawn#1",
      "ready:true",
      "stop#1",
      "spawn#2",
      "ready:true",
    ]);
    expect(reloads).toEqual(["reload"]);
    expect(sup.current).toEqual({ id: 2 });
  });

  test("CLI-shaped (no onReloadRenderer) restart succeeds without firing a reload", async () => {
    // No onReloadRenderer callback == the CLI adapter (no renderer to reload).
    const { sup, events } = makeSupervisor([true, true]);
    await sup.start();
    expect(await sup.restart()).toBe(true);
    expect(events).toEqual(["spawn#1", "ready:true", "stop#1", "spawn#2", "ready:true"]);
    // Nothing else to assert: the absence of a reload IS the CLI contract.
  });

  test("respawn ready-failure restores the backup THEN runs onRestartFailure, no reload", async () => {
    const order: string[] = [];
    const { sup } = makeSupervisor([true, false], {
      restoreBackup: () => order.push("restoreBackup"),
      onRestartFailure: () => order.push("onRestartFailure"),
      onReloadRenderer: () => order.push("reload"),
    });
    await sup.start();
    expect(await sup.restart()).toBe(false);
    // restore precedes the failure policy; the renderer is NEVER reloaded on failure.
    expect(order).toEqual(["restoreBackup", "onRestartFailure"]);
  });

  test("Electron-shaped restart failure stays up (onRestartFailure omitted) and still restores backup", async () => {
    const order: string[] = [];
    const { sup } = makeSupervisor([true, false], {
      restoreBackup: () => order.push("restoreBackup"),
      // onRestartFailure omitted == Electron: the app stays running, restart() returns false.
    });
    await sup.start();
    expect(await sup.restart()).toBe(false);
    expect(order).toEqual(["restoreBackup"]);
    expect(sup.isRestarting).toBe(false);
  });

  test("re-entrant restart is guarded: a second call while one is in flight no-ops", async () => {
    let releaseReady!: () => void;
    const gate = new Promise<void>((r) => {
      releaseReady = r;
    });
    const { strategy, events } = fakeStrategy();
    let readyCall = 0;
    const sup = new UiSupervisor<FakeHandle>({
      port: 3880,
      strategy,
      callbacks: {
        waitForReady: async () => {
          readyCall += 1;
          // First (start) resolves immediately; the restart's ready blocks on the gate.
          if (readyCall > 1) await gate;
          return true;
        },
        onStartFailure: () => {},
        log: () => {},
      },
    });
    await sup.start();
    const first = sup.restart();
    // Second restart while the first is still awaiting ready → guarded out immediately.
    expect(await sup.restart()).toBe(false);
    releaseReady();
    expect(await first).toBe(true);
    // Only ONE stop+respawn happened despite two restart() calls.
    expect(events.filter((e) => e.startsWith("stop")).length).toBe(1);
    expect(events.filter((e) => e.startsWith("spawn")).length).toBe(2); // start + 1 restart
  });

  test("markShuttingDown blocks further restarts (CLI signal-shutdown guard)", async () => {
    const { sup, events } = makeSupervisor([true, true]);
    await sup.start();
    sup.markShuttingDown();
    expect(await sup.restart()).toBe(false);
    // No stop/respawn after shutdown was flagged.
    expect(events).toEqual(["spawn#1", "ready:true"]);
  });

  test("a thrown strategy error routes to onRestartError and resets the guard", async () => {
    const errs: unknown[] = [];
    const { strategy, events } = fakeStrategy();
    const boom = new Error("spawn blew up");
    let readyCall = 0;
    const sup = new UiSupervisor<FakeHandle>({
      port: 3880,
      strategy: {
        spawn: () => {
          readyCall += 1;
          if (readyCall === 2) throw boom; // fail the RESPAWN
          events.push("spawn");
          return { id: readyCall };
        },
        stop: strategy.stop,
      },
      callbacks: {
        waitForReady: () => Promise.resolve(true),
        onStartFailure: () => {},
        onRestartError: (e) => errs.push(e),
        log: () => {},
      },
    });
    await sup.start();
    expect(await sup.restart()).toBe(false);
    expect(errs).toEqual([boom]);
    // Guard is released in `finally` so a later restart can proceed.
    expect(sup.isRestarting).toBe(false);
  });
});
