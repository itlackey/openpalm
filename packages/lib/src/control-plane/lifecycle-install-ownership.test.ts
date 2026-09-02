/**
 * Regression test for the rootless ownership pass skipped on install:
 * `reconcileHostOwnership` is wired into `start`,
 * `upgrade`, and `up`, but was missing from `applyInstall` — so a one-shot
 * fresh rootless install's first `up` could hit unwritable operator-owned
 * bind dirs before any chown ever ran.
 *
 * Fix: applyInstall now calls
 * `reconcileHostOwnership(state, { services: await buildManagedServices(state) })`
 * before writing any managed files, mirroring performUpgrade (lifecycle.ts).
 *
 * Below also covers #641/#642: applyInstall AND performUpgrade now pass
 * `repair: 'always'` in that same call, so the deep ownership walk runs
 * before `applyManagedFiles` renames/deletes the managed `system/` tree and
 * takes the durable backup — regardless of a marker written by an earlier
 * release that did not yet cover those paths.
 *
 * `reconcileHostOwnership` is statically imported by lifecycle.ts, so this
 * test mocks it via `mock.module` and re-imports lifecycle.ts with a
 * cache-busting query — the same pattern used elsewhere in this suite (see
 * akm-stats.test.ts) — rather than spying on the already-cached static
 * import, which bun's module cache would not let us intercept.
 *
 * IMPORTANT: bun's `mock.module()` rewrites a module's live export bindings
 * in place — an `import * as ns` namespace object captured before mocking
 * still observes whatever is CURRENTLY installed for that specifier when its
 * properties are read later. So the restore factory below must delegate to a
 * function reference snapshotted at file-load time (`realReconcileHostOwnership`,
 * captured before any test runs / any mock.module call happens), never to a
 * live read of the namespace object for the mocked key — otherwise the
 * restore just re-installs whatever this file's own test mocked, leaking a
 * no-op reconcileHostOwnership into every other test file that shares this
 * bun test process and imports ownership-reconcile.js after this one runs
 * (this was caught the hard way: it broke ownership-reconcile.test.ts's own
 * "throws HostSwapBlockedError" / "skips the repair walk" assertions when
 * this file naively restored via `{ ...realOwnershipReconcile }` alone).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realOwnershipReconcile from "./ownership-reconcile.js";

const realReconcileHostOwnership = realOwnershipReconcile.reconcileHostOwnership;

// mock.module() is NOT undone by mock.restore() and leaks across test files
// sharing this bun test process — always re-point back to the real
// implementation afterward (mirrors akm-stats.test.ts's own comment/pattern).
afterEach(() => {
  mock.restore();
  mock.module("./ownership-reconcile.js", () => ({
    ...realOwnershipReconcile,
    reconcileHostOwnership: realReconcileHostOwnership,
  }));
});

describe("applyInstall runs the rootless ownership reconcile before the first managed write (F1)", () => {
  test("calls reconcileHostOwnership before applyManagedFiles writes the managed system/ tree", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-install-ownership-"));
    const savedHome = process.env.OP_HOME;
    const savedSkip = process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    process.env.OP_HOME = homeDir;
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1";

    try {
      // The managed system/ tree is what applyManagedFiles (via applyHome ->
      // applyHomeSeed) writes wholesale on every apply — it does not exist on
      // a bare fresh OP_HOME. Snapshotting whether it exists at the moment
      // reconcileHostOwnership runs proves ordering directly from an
      // observable side effect, with no need to also mock/spy on
      // applyManagedFiles's internals.
      let systemTreeExistedAtReconcileTime: boolean | null = null;
      let capturedOptions: { repair?: string } | undefined;
      const reconcileHostOwnershipMock = mock(async (_state: unknown, options: { repair?: string }) => {
        systemTreeExistedAtReconcileTime = existsSync(join(homeDir, "system"));
        capturedOptions = options;
      });

      mock.module("./ownership-reconcile.js", () => ({
        ...realOwnershipReconcile,
        reconcileHostOwnership: reconcileHostOwnershipMock,
      }));

      const { applyInstall, createState } = await import(
        `./lifecycle.js?f1-ownership-test=${Math.random()}`
      );

      const state = createState();
      await applyInstall(state);

      expect(reconcileHostOwnershipMock).toHaveBeenCalledTimes(1);
      expect(systemTreeExistedAtReconcileTime).toBe(false);
      // applyInstall did go on to actually write the managed tree afterward —
      // confirms this isn't passing merely because applyManagedFiles never ran.
      expect(existsSync(join(homeDir, "system"))).toBe(true);
      // #641/#642: install passes repair: 'always' too — a fresh install must
      // not rely on a marker (there is none yet, but the option is what makes
      // the walk unconditional rather than an accident of an absent marker).
      expect(capturedOptions?.repair).toBe("always");
    } finally {
      if (savedHome === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedHome;
      if (savedSkip === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
      else process.env.OP_SKIP_COMPOSE_PREFLIGHT = savedSkip;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("performUpgrade passes repair: 'always' to reconcileHostOwnership (#641/#642)", () => {
  // #641/#642: both failures traced back to the SAME missing behavior — the
  // deep ownership-repair walk not running before applyManagedFiles renames/
  // deletes the managed system/ tree and takes the durable backup. The walk
  // itself is proven separately (ownership-reconcile.test.ts); this test
  // proves the WIRING — that an upgrade actually asks for the unconditional
  // walk rather than leaving it to a marker that may have been written by an
  // earlier release, before this one started covering `system/`.
  //
  // reconcileHostOwnership is mocked to record its call options and then
  // throw a sentinel — short-circuiting performUpgrade right after the call
  // this test cares about, before it needs a real compose stack (image pull,
  // health-wait) to succeed. runWithSnapshotRollback (lifecycle.ts) always
  // re-throws the original error after its best-effort recovery, so the
  // sentinel still reaches the caller.
  test("performUpgrade's reconcileHostOwnership call requests repair: 'always'", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openpalm-upgrade-ownership-"));
    const savedHome = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;

    try {
      let capturedOptions: { repair?: string; services?: string[] } | undefined;
      const sentinel = new Error("reconcileHostOwnership-mock-sentinel");
      const reconcileHostOwnershipMock = mock(async (_state: unknown, options: { repair?: string; services?: string[] }) => {
        capturedOptions = options;
        throw sentinel;
      });

      mock.module("./ownership-reconcile.js", () => ({
        ...realOwnershipReconcile,
        reconcileHostOwnership: reconcileHostOwnershipMock,
      }));

      const { performUpgrade, createState } = await import(
        `./lifecycle.js?f2-upgrade-repair-test=${Math.random()}`
      );

      const state = createState();
      await expect(performUpgrade(state)).rejects.toThrow(sentinel.message);

      expect(reconcileHostOwnershipMock).toHaveBeenCalledTimes(1);
      expect(capturedOptions?.repair).toBe("always");
    } finally {
      if (savedHome === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
