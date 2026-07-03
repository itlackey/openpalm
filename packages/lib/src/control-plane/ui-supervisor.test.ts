import { describe, test, expect } from "bun:test";
import {
  DEFAULT_READY_TIMEOUT_MS,
  waitForReady,
  restoreUiBackup,
  type RestoreUiBackupDeps,
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
