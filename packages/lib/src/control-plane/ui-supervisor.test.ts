import { describe, test, expect } from "bun:test";
import {
  checkExistingUiInstance,
  DEFAULT_READY_TIMEOUT_MS,
  readyOrChildExit,
  waitForReady,
  UiSupervisor,
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

  test("accepts localhost for the CLI app readiness path", async () => {
    const urls: string[] = [];
    const fetchFn = ((url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;
    await waitForReady(4321, 5000, { host: "localhost", fetchFn, sleep: noSleep });
    expect(urls[0]).toBe("http://localhost:4321/health");
  });
});

// ── UiSupervisor.start ────────────────────────────────────────────────────────
// Characterization of the supervisor STATE MACHINE shared by the CLI and Electron
// harnesses, driven entirely through an injected FAKE process-strategy. Locks in
// the observable contract both adapters must preserve:
//   • normal start → ready
//   • ready-timeout → onStartFailure invoked (NOT process.exit — lib is exit-free)

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

  test("adopt seeds the handle without spawning", () => {
    const { strategy } = fakeStrategy();
    const external = { id: 99 };
    const sup = new UiSupervisor<FakeHandle>({
      port: 3880,
      strategy,
      callbacks: {
        waitForReady: () => Promise.resolve(true),
        onStartFailure: () => {},
        log: () => {},
      },
    });
    sup.adopt(external);
    expect(sup.current).toBe(external);
  });
});

// ── Instance identity + child-exit race (shared with Electron) ────────────────

describe("checkExistingUiInstance", () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  test("a silent port is 'absent' — proceed with a normal spawn", async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "absent" });
  });

  test("a matching capability level is 'match' — attach instead of racing for the socket", async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => jsonResponse({ admin: true })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "match", admin: true });
  });

  test("a DIFFERENT capability level is 'mismatch', never a silent adoption", async () => {
    // This is the Electron failure: a bare `openpalm` serving a non-admin UI on
    // the port, the desktop app's own child dying of EADDRINUSE, and the window
    // opening onto the foreign server with no host capability.
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => jsonResponse({ admin: false })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "mismatch", admin: false });
  });

  test("a non-2xx or non-JSON answer is 'absent' — never inferred as a match", async () => {
    const notFound = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    expect(notFound).toEqual({ status: "absent" });

    const garbage = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(garbage).toEqual({ status: "absent" });
  });

  test("a missing `admin` field reads as non-admin, so it cannot pass an admin expectation", async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "mismatch", admin: false });
  });
});

describe("readyOrChildExit", () => {
  test("a child that dies first reports not-ready immediately", async () => {
    // Without this the supervisor waits out the FULL ready timeout while an
    // unrelated process on the port answers the health poll for it.
    const never = new Promise<boolean>(() => {});
    expect(await readyOrChildExit(() => never, Promise.resolve(1))).toBe(false);
  });

  test("readiness still wins when the child stays alive", async () => {
    const never = new Promise<never>(() => {});
    expect(await readyOrChildExit(() => Promise.resolve(true), never)).toBe(true);
  });

  test("a rejected exit promise is not-ready, not a thrown exception", async () => {
    // node's events.once(child, 'exit') REJECTS if the child emits 'error'
    // first; letting that escape would throw out of the supervisor instead of
    // producing the not-ready result its callers handle.
    const never = new Promise<boolean>(() => {});
    expect(await readyOrChildExit(() => never, Promise.reject(new Error("ENOENT")))).toBe(false);
  });

  test("with no child handle it degrades to the plain readiness poll", async () => {
    expect(await readyOrChildExit(() => Promise.resolve(true), undefined)).toBe(true);
    expect(await readyOrChildExit(() => Promise.resolve(false), undefined)).toBe(false);
  });
});
